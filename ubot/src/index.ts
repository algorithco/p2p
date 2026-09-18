import { config, validateConfig } from './config';
import logger from './logger';
import { ensureClient, checkAuthorized, setGlobalFloodUntil, limiter } from './client';
import { createApi } from './api';
import { clearKeyCache } from './sessionManager';

let isShuttingDown = false;
export function getShuttingDown(): boolean {
  return isShuttingDown;
}

async function main() {
  const errs = validateConfig();
  if (errs.length) {
    for (const e of errs) logger.warn(e);
    // Fail-closed ENCRYPTION_KEY in ALL environments (BREAKING vs old warn-only dev fallback).
    if (errs.some((e) => e.includes('ENCRYPTION_KEY'))) {
      logger.error('ubot misconfigured — ENCRYPTION_KEY required (64 hex); refusing to boot plaintext. Exiting');
      process.exit(1);
    }
    if (config.isProduction && errs.some((e) => e.includes('API_ID') || e.includes('API_HASH'))) {
      logger.error('ubot misconfigured in production — API_ID/HASH required; exiting');
      process.exit(1);
    }
    if (errs.some((e) => e.includes('API_ID') || e.includes('API_HASH'))) {
      logger.error('ubot misconfigured — API_ID/HASH required; service will start but all channel ops will fail');
    }
  }

  // SIGHUP: reload encryption key cache (for rotation)
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received — clearing encryption key cache');
    try {
      clearKeyCache();
    } catch {}
  });

  // Try to connect userbot with backoff that respects FloodWait secs — non-fatal for health/ready
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await ensureClient();
      logger.info('Userbot initial connection succeeded');
      break;
    } catch (e) {
      const err = e as { message?: string; seconds?: number; errorMessage?: string };
      const msg = String(err.message || err.errorMessage || e);
      logger.error(`Failed to ensure Telegram client (attempt ${attempts}/${maxAttempts})`, { error: msg });
      // Parse FloodWait secs correctly and respect exact wait
      let secs: number | null = null;
      if (typeof err.seconds === 'number' && Number.isFinite(err.seconds)) secs = err.seconds;
      else {
        const m = msg.match(/FLOOD_WAIT_(\d+)|retry after (\d+) seconds|wait of (\d+) seconds/i);
        if (m) secs = parseInt(m[1] || m[2] || m[3] || '30', 10);
        else if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) secs = 86400;
      }
      if (secs !== null && secs > 30) {
        setGlobalFloodUntil(secs);
        logger.warn(
          `Startup FloodWait ${secs}s — global flood until ${new Date(Date.now() + secs * 1000).toISOString()}`,
        );
        // Don't tight-loop; wait a bit but not full 24h at startup — just break and let API handle
        break;
      }
      if (msg.includes('not_authorized') || msg.includes('API_ID') || msg.includes('ENCRYPTION_KEY')) {
        logger.warn('Auth/config error — will retry on next API request, not looping at startup');
        break;
      }
      if (attempts < maxAttempts) {
        const wait = Math.min(5000 * attempts + Math.random() * 2000, 15000);
        logger.info(`Retrying ensureClient in ${Math.round(wait)}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  const app = createApi();
  const port = config.port;

  // Graceful shutdown tracking
  let server: ReturnType<typeof app.listen> | null = null;
  let periodicTimer: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} — shutting down (graceful)`);
    if (periodicTimer) clearInterval(periodicTimer);
    try {
      // Stop accepting new queue tasks, drain existing
      try {
        await limiter.stop({ dropWaitingJobs: false });
      } catch {}
    } catch {}
    try {
      const { disconnect } = await import('./client');
      await disconnect();
    } catch {}
    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      // Idle connections close faster
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).closeIdleConnections?.();
      } catch {}
      setTimeout(() => {
        logger.warn('Graceful shutdown timeout — forcing exit');
        process.exit(0);
      }, 30000);
    } else {
      setTimeout(() => process.exit(0), 1000);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  server = app.listen(port, () => {
    logger.info(
      `ubot listening on http://localhost:${port} (apiId=${config.apiId ? 'set' : 'missing'}, health at /health, ready at /ready, metrics at /metrics, verified at /health/verified)`,
    );
    if (config.apiKey) logger.info('UBOT_API_KEY auth enabled (timing-safe, header only)');
    else logger.warn('UBOT_API_KEY not set — internal API is OPEN (dev only) — set a 32+ char random key');
    // Periodic auth check with jitter 60-75s to avoid bot signature; attempt auto-reconnect if disconnected (NAT idle close)
    periodicTimer = setInterval(
      async () => {
        try {
          const ok = await checkAuthorized();
          if (!ok) {
            logger.warn('Periodic check: session no longer authorized — attempting ensureClient reconnect');
            try {
              await ensureClient();
              logger.info('Periodic reconnect succeeded');
            } catch (e) {
              const msg = String((e as Error).message || e);
              // Don't spam on expected not_authorized / FloodWait - already handled in ensureClient
              if (!msg.includes('not_authorized') && !msg.includes('FLOOD_WAIT')) {
                logger.warn(`Periodic reconnect failed: ${msg.slice(0, 200)}`);
              }
            }
          }
        } catch {}
      },
      60_000 + Math.random() * 15000,
    );
    // Unref so interval doesn't block shutdown
    periodicTimer.unref?.();
  });

  // Expose server for testing if needed
  return server;
}

main().catch((e) => {
  logger.error('ubot fatal', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  const msg = String((e as Error)?.message || e);
  // Don't crash on FloodWait, just log
  if (msg.includes('FloodWait') || msg.includes('FLOOD_WAIT')) {
    logger.warn('unhandled FloodWait', e);
  } else {
    logger.error('unhandledRejection', e);
  }
});
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', e);
  process.exit(1);
});
