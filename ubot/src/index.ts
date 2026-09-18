import { config, validateConfig } from './config';
import logger from './logger';
import { ensureClient, getClient, getLastActivityAt, disconnect as disconnectClient, limiter } from './client';
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

  // LAZY MODE (default): do NOT touch Telegram at boot. The MTProto connection is
  // established on the first real channel/group request via ensureClient() — every
  // boot-time connect is checkAuthorization + getMe + iterDialogs warmup that the
  // account pays for even with zero deals. /health and /ready stay fully local.
  // Opt back into eager boot (debugging only) with UBOT_PRECONNECT=true.
  if (config.preconnect) {
    try {
      await ensureClient();
      logger.info('Userbot initial connection succeeded (UBOT_PRECONNECT=true)');
    } catch (e) {
      const msg = String((e as Error).message || e);
      logger.error('Pre-connect failed — will retry lazily on first API request', { error: msg });
    }
  } else {
    logger.info('ubot lazy mode — Telegram connect deferred until first channel/group request');
  }

  const app = createApi();
  const port = config.port;

  // Graceful shutdown tracking
  let server: ReturnType<typeof app.listen> | null = null;
  let sweeperTimer: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`${signal} — shutting down (graceful)`);
    if (sweeperTimer) clearInterval(sweeperTimer);
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
    // Idle sweeper (LOCAL ONLY — zero Telegram calls): if no ensured activity for
    // UBOT_IDLE_DISCONNECT_MS, close the MTProto connection. Next real request
    // reconnects lazily via ensureClient(). Replaces the old 60-75s
    // checkAuthorized poll (1 Telegram call/min, ~1440/day with zero deals).
    // Keep-alive pings while connected are already throttled via UBOT_KEEPALIVE_MS.
    if (config.idleDisconnectMs > 0) {
      const idleMs = config.idleDisconnectMs;
      sweeperTimer = setInterval(() => {
        try {
          if (isShuttingDown) return;
          if (!getClient()) return; // not connected — nothing to do, and never connect from here
          const idleFor = Date.now() - getLastActivityAt();
          if (idleFor >= idleMs) {
            void disconnectClient()
              .then(() =>
                logger.info(
                  `Idle ${Math.round(idleFor / 1000)}s — MTProto disconnected (lazy reconnect on next request)`,
                ),
              )
              .catch(() => undefined);
          }
        } catch {}
      }, 60_000);
      // Unref so interval doesn't block shutdown
      sweeperTimer.unref?.();
      logger.info(`Idle auto-disconnect enabled: ${Math.round(idleMs / 1000)}s (UBOT_IDLE_DISCONNECT_MS)`);
    } else {
      logger.info('Idle auto-disconnect disabled (UBOT_IDLE_DISCONNECT_MS=0) — connection stays up once established');
    }
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
