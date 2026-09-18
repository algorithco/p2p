import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import Bottleneck from 'bottleneck';
import { config } from './config';
import logger from './logger';
import { loadEncryptedSession, saveEncryptedSession } from './sessionManager';

// Dynamic FloodWait handling via teleproto/errors if available
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let FloodWaitErrorCtor: (new (...args: any[]) => Error & { seconds?: number }) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SlowModeWaitErrorCtor: (new (...args: any[]) => Error & { seconds?: number }) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TakeoutInitDelayErrorCtor: (new (...args: any[]) => Error & { seconds?: number }) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let FreshChangeAdminsForbiddenErrorCtor: (new (...args: any[]) => Error) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PeerFloodErrorCtor: (new (...args: any[]) => Error) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ChannelsTooMuchErrorCtor: (new (...args: any[]) => Error) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AuthKeyDuplicatedErrorCtor: (new (...args: any[]) => Error) | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const errs = require('teleproto/errors') as Record<string, unknown>;
  FloodWaitErrorCtor = (errs['FloodWaitError'] as typeof FloodWaitErrorCtor) ?? null;
  SlowModeWaitErrorCtor = (errs['SlowModeWaitError'] as typeof SlowModeWaitErrorCtor) ?? null;
  TakeoutInitDelayErrorCtor = (errs['TakeoutInitDelayError'] as typeof TakeoutInitDelayErrorCtor) ?? null;
  FreshChangeAdminsForbiddenErrorCtor =
    (errs['FreshChangeAdminsForbiddenError'] as typeof FreshChangeAdminsForbiddenErrorCtor) ?? null;
  PeerFloodErrorCtor = (errs['PeerFloodError'] as typeof PeerFloodErrorCtor) ?? null;
  ChannelsTooMuchErrorCtor = (errs['ChannelsTooMuchError'] as typeof ChannelsTooMuchErrorCtor) ?? null;
  AuthKeyDuplicatedErrorCtor = (errs['AuthKeyDuplicatedError'] as typeof AuthKeyDuplicatedErrorCtor) ?? null;
  // Fallback to RPCErrorList if needed
  if (!FloodWaitErrorCtor) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const list = require('teleproto/errors/RPCErrorList') as Record<string, unknown>;
      FloodWaitErrorCtor = (list['FloodWaitError'] as typeof FloodWaitErrorCtor) ?? FloodWaitErrorCtor;
      SlowModeWaitErrorCtor = (list['SlowModeWaitError'] as typeof SlowModeWaitErrorCtor) ?? SlowModeWaitErrorCtor;
      TakeoutInitDelayErrorCtor =
        (list['TakeoutInitDelayError'] as typeof TakeoutInitDelayErrorCtor) ?? TakeoutInitDelayErrorCtor;
    } catch {}
  }
} catch {
  // teleproto/errors not available — will use string matching fallback
}

let client: TelegramClient | null = null;
let connectPromise: Promise<TelegramClient> | null = null;
let lastAuthFailureAt = 0;
let lastConnectAttemptAt = 0;
let connectAttempts = 0;
// Last time real Telegram activity was ensured (fast-path hit or fresh connect or
// successful queued call). Drives the idle auto-disconnect sweeper in index.ts.
let lastActivityAt = 0;

export function getLastActivityAt(): number {
  return lastActivityAt;
}

function touchActivity(): void {
  lastActivityAt = Date.now();
}

// Global flood state — never violate Telegram's FloodWait
let globalFloodUntil = 0;
export const channelBreakers = new Map<string, number>();

// Bottleneck limiter: serialized, human-like pacing to avoid ban
// minTime from config.globalRateMs (default 1300) to allow tuning without rebuild
export const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: Math.max(100, config.globalRateMs || 1300),
  reservoir: 30,
  reservoirRefreshInterval: 1000,
  reservoirRefreshAmount: 30,
});

// Helpers for timing / humanization
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function humanDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const lo = Math.max(0, minMs);
  const hi = Math.max(lo, maxMs);
  const ms = lo + Math.random() * (hi - lo);
  await sleep(ms);
}

export function getGlobalFloodUntil(): number {
  return globalFloodUntil;
}

export function isGlobalFlooded(): boolean {
  return Date.now() < globalFloodUntil;
}

export function setGlobalFloodUntil(secs: number): void {
  if (!Number.isFinite(secs) || secs <= 0) return;
  globalFloodUntil = Date.now() + secs * 1000 + 1000;
}

export function isChannelBlocked(key: string): boolean {
  const until = channelBreakers.get(String(key));
  return typeof until === 'number' && Date.now() < until;
}

export function telegramQueue<T>(fn: () => Promise<T>): Promise<T> {
  return limiter.schedule(fn);
}

export function getClient(): TelegramClient | null {
  return client;
}

function parseFloodSeconds(e: unknown): number | null {
  const err = e as { seconds?: unknown; message?: unknown; errorMessage?: unknown; capture?: unknown };
  const msg = String((err.message ?? err.errorMessage ?? e) as string);

  // instanceof checks via dynamic import if available
  try {
    if (FloodWaitErrorCtor && e instanceof FloodWaitErrorCtor) {
      const s = (e as { seconds?: number }).seconds;
      if (typeof s === 'number' && Number.isFinite(s)) return s;
    }
    if (SlowModeWaitErrorCtor && e instanceof SlowModeWaitErrorCtor) {
      const s = (e as { seconds?: number }).seconds;
      if (typeof s === 'number' && Number.isFinite(s)) return s;
    }
    if (TakeoutInitDelayErrorCtor && e instanceof TakeoutInitDelayErrorCtor) {
      const s = (e as { seconds?: number }).seconds;
      if (typeof s === 'number' && Number.isFinite(s)) return s;
    }
  } catch {}

  // Direct .seconds property (teleproto FloodWaitError often has .seconds)
  if (typeof err.seconds === 'number' && Number.isFinite(err.seconds)) {
    return err.seconds as number;
  }
  if (typeof (e as { seconds?: unknown })?.seconds === 'number') {
    return (e as { seconds: number }).seconds;
  }

  // Fresh admin forbidden => 24h hard block
  if (
    msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN') ||
    (FreshChangeAdminsForbiddenErrorCtor &&
      (() => {
        try {
          return e instanceof FreshChangeAdminsForbiddenErrorCtor;
        } catch {
          return false;
        }
      })())
  ) {
    return 86400;
  }

  // Peer flood => no seconds, map to 86400 to avoid ban (conservative)
  if (
    msg.includes('PEER_FLOOD') ||
    (PeerFloodErrorCtor &&
      (() => {
        try {
          return e instanceof PeerFloodErrorCtor;
        } catch {
          return false;
        }
      })())
  ) {
    // try to extract seconds if present, else hard 24h for safety
    const m = msg.match(/PEER_FLOOD_\d+|PEER_FLOOD/i);
    if (m) {
      const secMatch = msg.match(/(\d{1,10})\s*seconds/i) || msg.match(/FLOOD_WAIT_(\d+)/i);
      if (secMatch) return parseInt(secMatch[1], 10);
    }
    return 86400;
  }

  // SLOWMODE_WAIT
  if (msg.includes('SLOWMODE_WAIT') || msg.includes('SlowModeWait')) {
    const m = msg.match(/SLOWMODE_WAIT_(\d+)|wait of (\d+) seconds/i);
    if (m) return parseInt(m[1] || m[2] || '30', 10);
    const sec = msg.match(/(\d{1,10})\s*seconds/i);
    if (sec) return parseInt(sec[1], 10);
    return 60;
  }

  // TAKEOUT_INIT_DELAY
  if (msg.includes('TAKEOUT_INIT_DELAY') || msg.includes('TakeoutInitDelay')) {
    const m = msg.match(/TAKEOUT_INIT_DELAY_(\d+)/i);
    if (m) return parseInt(m[1], 10);
    const sec = msg.match(/(\d{1,10})\s*seconds/i);
    if (sec) return parseInt(sec[1], 10);
    return 30;
  }

  // Generic FLOOD_WAIT parsing
  const floodMatch = msg.match(
    /FLOOD_WAIT_(\d+)|FLOOD_PREMIUM_WAIT_(\d+)|retry after (\d+) seconds|wait of (\d+) seconds/i,
  );
  if (floodMatch) {
    const v = floodMatch[1] || floodMatch[2] || floodMatch[3] || floodMatch[4];
    if (v) return parseInt(v, 10);
  }
  if (msg.includes('FloodWaitError') || msg.includes('FLOOD_WAIT') || msg.includes('FloodError')) {
    return 30;
  }

  return null;
}

function isChannelsTooMuch(e: unknown): boolean {
  const msg = String(
    (e as { message?: unknown; errorMessage?: unknown })?.message ??
      (e as { errorMessage?: unknown })?.errorMessage ??
      e,
  );
  if (msg.includes('CHANNELS_TOO_MUCH') || msg.includes('ChannelsTooMuch')) return true;
  try {
    if (ChannelsTooMuchErrorCtor && e instanceof ChannelsTooMuchErrorCtor) return true;
  } catch {}
  return false;
}

function isAuthKeyDuplicated(e: unknown): boolean {
  const msg = String(
    (e as { message?: unknown; errorMessage?: unknown })?.message ??
      (e as { errorMessage?: unknown })?.errorMessage ??
      e,
  );
  if (msg.includes('AUTH_KEY_DUPLICATED') || msg.includes('AuthKeyDuplicated')) return true;
  try {
    if (AuthKeyDuplicatedErrorCtor && e instanceof AuthKeyDuplicatedErrorCtor) return true;
  } catch {}
  return false;
}

export async function ensureClient(): Promise<TelegramClient> {
  const now = Date.now();

  // Global flood gate — never hammer during FloodWait
  if (globalFloodUntil && now < globalFloodUntil) {
    const secs = Math.ceil((globalFloodUntil - now) / 1000);
    const err = new Error(
      `FLOOD_WAIT_${secs}: global flood active until ${new Date(globalFloodUntil).toISOString()} (wait ${secs}s)`,
    ) as Error & { seconds: number };
    (err as unknown as { seconds: number }).seconds = secs;
    (err as unknown as { errorMessage: string }).errorMessage = `FLOOD_WAIT_${secs}`;
    throw err;
  }

  // Throttle repeated auth failures (e.g., session invalid) to avoid log spam and DC hammering
  if (lastAuthFailureAt && now - lastAuthFailureAt < 30_000) {
    throw new Error('not_authorized: session invalid (throttled 30s, check docker logs)');
  }

  if (client) {
    try {
      // Cached auth check (12-20s TTL inside checkAuthorized, incl. human jitter):
      // a burst of backend calls shares ONE Telegram checkAuthorization instead of
      // one per call. No extra sleep here — checkAuthorized already jitters.
      if (await checkAuthorized()) {
        touchActivity();
        return client;
      }
      logger.warn('checkAuthorization returned false — session no longer authorized');
      await disconnect();
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (
        msg.includes('AuthKeyUnregistered') ||
        msg.includes('AuthKeyNotFound') ||
        msg.includes('SESSION_REVOKED') ||
        msg.includes('USER_DEACTIVATED') ||
        msg.includes('AUTH_KEY_UNREGISTERED')
      ) {
        lastAuthFailureAt = Date.now();
        logger.warn('Userbot session revoked/unregistered — regenerate via npm run login:qr', e);
        await disconnect().catch(() => undefined);
        throw new Error('not_authorized: session revoked/unregistered — regenerate via npm run login:qr');
      }
      logger.warn('checkAuthorization failed, will reconnect', e);
      await disconnect().catch(() => undefined);
    }
  }

  if (connectPromise) return connectPromise;

  // Rate limit connect attempts: 5000ms + exponential backoff + jitter
  const sinceLast = now - lastConnectAttemptAt;
  const expDelay = 5000 * Math.pow(1.6, Math.min(connectAttempts, 5));
  const requiredGap = expDelay + Math.random() * 1200;
  if (sinceLast < requiredGap) {
    const waitMs = Math.ceil(requiredGap - sinceLast);
    logger.info(
      `Throttling connect attempt — waiting ${waitMs}ms (attempt ${connectAttempts + 1}, gap ${Math.round(requiredGap)}ms)`,
    );
    await sleep(waitMs);
  }
  lastConnectAttemptAt = Date.now();

  connectPromise = (async () => {
    const sessionStr = loadEncryptedSession() || '';
    if (!sessionStr) {
      lastAuthFailureAt = Date.now();
      throw new Error(
        'not_authorized: UBOT_SESSION_STRING empty — run npm run login:qr (teleproto) or set ENCRYPTION_KEY correctly',
      );
    }
    if (!config.apiId || !config.apiHash) {
      throw new Error('API_ID / API_HASH not configured — set in ubot/.env');
    }

    const stringSession = new StringSession(sessionStr);
    // Optional proxy: only MTProxy is natively supported by teleproto; for SOCKS5/HTTP log hint
    let proxyConf: unknown = undefined;
    if (config.proxyUrl) {
      try {
        const u = new URL(config.proxyUrl);
        if (u.protocol === 'mtproxy:' || u.searchParams.has('secret')) {
          const secret = u.searchParams.get('secret') || u.password || '';
          proxyConf = { ip: u.hostname, port: parseInt(u.port || '443', 10), MTProxy: true, secret };
          logger.info(`Using MTProxy ${u.hostname}:${u.port}`);
        } else {
          // Generic SOCKS5/HTTP proxy not natively handled by teleproto TCP layer; log and use without proxy
          // Teleproto will attempt direct connection; recommend running a SOCKS5 wrapper (e.g. tun2socks) if needed
          logger.warn(
            `PROXY_URL set (${u.protocol}//${u.hostname}) but teleproto supports only MTProxy natively — attempting direct connection; set MTProxy or use sidecar`,
          );
        }
      } catch {
        logger.warn(`Invalid PROXY_URL ${config.proxyUrl} — ignoring`);
      }
    }
    const c = new TelegramClient(stringSession, config.apiId, config.apiHash, {
      connectionRetries: 5,
      retryDelay: 2000 + Math.random() * 1000,
      autoReconnect: true,
      floodSleepThreshold: config.floodThreshold || 60,
      requestRetries: 5,
      timeout: 15,
      keepAliveInterval: config.keepAliveMs, // TCP ping; 120s default is far below ~5min Docker NAT idle timeout
      sequentialUpdates: false,
      useIPV6: false,
      proxy: proxyConf as never,
      deviceModel: config.deviceModel || 'Pixel 7',
      systemVersion: config.systemVersion || '14',
      appVersion: config.appVersion || '10.2.1',
      langCode: 'en',
      systemLangCode: 'en-US',
    } as never);

    logger.info('Connecting TelegramClient (teleproto)...');
    try {
      await c.connect();
    } catch (e) {
      connectAttempts += 1;
      const msg = String((e as Error).message || e);
      const secs = parseFloodSeconds(e);
      if (secs !== null) {
        globalFloodUntil = Date.now() + secs * 1000 + 1000;
        logger.warn(
          `Telegram connect FloodWait ${secs}s — global flood until ${new Date(globalFloodUntil).toISOString()}`,
          e,
        );
        // Set breaker for FRESH if applicable
        if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
          channelBreakers.set('FRESH_CHANGE_ADMINS_FORBIDDEN', Date.now() + 86400 * 1000);
        }
      } else {
        logger.warn('Telegram connect failed (will retry on next request)', e);
      }
      throw new Error(`telegram_connect_failed: ${msg}`);
    }

    let authorized = false;
    try {
      authorized = await c.checkAuthorization();
    } catch (e) {
      const msg = String((e as Error).message || e);
      logger.warn('checkAuthorization failed', e);
      await c.disconnect().catch(() => undefined);
      if (
        msg.includes('AuthKeyUnregistered') ||
        msg.includes('AuthKeyNotFound') ||
        msg.includes('SESSION_REVOKED') ||
        msg.includes('AUTH_KEY_UNREGISTERED')
      ) {
        lastAuthFailureAt = Date.now();
        throw new Error(`not_authorized: ${msg} — session invalid, regenerate via npm run login:qr`);
      }
      throw new Error(`not_authorized: ${msg}`);
    }

    if (!authorized) {
      logger.warn('Userbot not authorized — session invalid/expired, regenerate via npm run login:qr');
      await c.disconnect().catch(() => undefined);
      lastAuthFailureAt = Date.now();
      throw new Error('not_authorized: session invalid');
    }

    try {
      const me = await c.getMe();
      logger.info(
        `Userbot connected as ${(me as unknown as { username?: string })?.username || (me as unknown as { id: number })?.id}`,
      );
    } catch {}

    // Warmup: iterDialogs to ensure session is fully ready and avoid cold-start flood (skippable via WARMUP=false)
    if (config.warmupEnabled) {
      try {
        const iter = (c as unknown as { iterDialogs: (p: unknown) => AsyncIterable<unknown> }).iterDialogs({
          limit: 5,
        });
        let count = 0;
        for await (const _ of iter) {
          count += 1;
          if (count >= 1) break;
        }
        // small human delay after warmup
        await sleep(400 + Math.random() * 600);
      } catch (e) {
        logger.warn('Warmup iterDialogs failed (non-fatal)', e);
      }
    } else {
      logger.info('Warmup disabled (WARMUP=false)');
    }

    try {
      const saved = (c.session as unknown as StringSession).save() as unknown as string;
      if (saved && saved !== sessionStr) saveEncryptedSession(saved);
    } catch {}

    client = c;
    lastAuthFailureAt = 0;
    connectAttempts = 0;
    touchActivity();
    return c;
  })();

  try {
    return await connectPromise;
  } catch (e) {
    // keep connectAttempts incremented already on connect failure; also increment on other failures
    if (connectAttempts === 0) connectAttempts = 1;
    throw e;
  } finally {
    connectPromise = null;
  }
}

export async function disconnect(): Promise<void> {
  if (client) {
    try {
      await client.disconnect();
    } catch {}
    client = null;
  }
}

export async function withFloodWait<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    const isFinal = i === retries - 1;
    try {
      // Queue through bottleneck to respect global rate limits
      const result = await telegramQueue(fn);
      touchActivity();
      return result;
    } catch (e) {
      const msg = String(
        (e as { message?: unknown; errorMessage?: unknown })?.message ??
          (e as { errorMessage?: unknown })?.errorMessage ??
          e,
      );
      const secs = parseFloodSeconds(e);

      if (secs !== null) {
        // Global flood gate — remember exact wait
        globalFloodUntil = Date.now() + secs * 1000 + 1000;
        // Channel breaker for FRESH (24h)
        if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
          channelBreakers.set('FRESH_CHANGE_ADMINS_FORBIDDEN', Date.now() + 86400 * 1000);
          logger.warn('FRESH_CHANGE_ADMINS_FORBIDDEN — breaker set for 24h');
        }
        if (msg.includes('PEER_FLOOD')) {
          channelBreakers.set('PEER_FLOOD', Date.now() + secs * 1000);
        }
        if (msg.includes('SLOWMODE_WAIT')) {
          channelBreakers.set('SLOWMODE_WAIT', Date.now() + secs * 1000);
        }
        if (msg.includes('TAKEOUT_INIT_DELAY')) {
          channelBreakers.set('TAKEOUT_INIT_DELAY', Date.now() + secs * 1000);
        }

        lastErr = e;
        const jitter = 500 + Math.random() * 3000; // 500-3500ms
        const exponential = Math.pow(2, i) * 600; // 600, 1200, 2400...
        const capped = Math.min(secs, 300);

        if (isFinal) {
          // Final retry: respect EXACT secs (no cap) to avoid ban
          const waitMs = secs * 1000 + jitter;
          logger.warn(
            `FloodWait ${secs}s (final ${i + 1}/${retries}) — sleeping exact ${Math.round(waitMs / 1000)}s + jitter, global flood until ${new Date(globalFloodUntil).toISOString()}`,
          );
          await sleep(waitMs);
          // After final wait, try one last time outside loop? We'll continue to throw below, but spec says respect exact on final
          // To honour spec, we sleep full then throw if still failing; caller will see lastErr with proper seconds
          continue;
        } else {
          const waitMs = capped * 1000 + jitter + exponential;
          logger.warn(
            `FloodWait — sleeping ${secs}s (capped ${capped}s + jitter ${Math.round(jitter)}ms + exp ${Math.round(exponential)}ms, attempt ${i + 1}/${retries}) global until ${new Date(globalFloodUntil).toISOString()}`,
          );
          await sleep(waitMs);
          continue;
        }
      }

      // Known non-retryable / breaker errors
      if (msg.includes('CHANNELS_TOO_MUCH') || msg.includes('ChannelsTooMuch')) {
        channelBreakers.set('CHANNELS_TOO_MUCH', Date.now() + 6 * 60 * 60 * 1000);
        throw new Error(
          'CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups — leave some or use another account',
        );
      }
      if (msg.includes('AUTH_KEY_DUPLICATED') || msg.includes('AuthKeyDuplicated')) {
        channelBreakers.set('AUTH_KEY_DUPLICATED', Date.now() + 24 * 60 * 60 * 1000);
        throw new Error('AUTH_KEY_DUPLICATED: session duplicated — generate a new session');
      }
      // Also handle via instanceof fallback
      if (isChannelsTooMuch(e)) {
        channelBreakers.set('CHANNELS_TOO_MUCH', Date.now() + 6 * 60 * 60 * 1000);
        throw new Error(
          'CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups — leave some or use another account',
        );
      }
      if (isAuthKeyDuplicated(e)) {
        channelBreakers.set('AUTH_KEY_DUPLICATED', Date.now() + 24 * 60 * 60 * 1000);
        throw new Error('AUTH_KEY_DUPLICATED: session duplicated — generate a new session');
      }

      throw e;
    }
  }
  throw lastErr;
}

// Authorization helpers with jitter + cache to avoid hammering
let lastAuthCheckAt = 0;
let cachedAuth: boolean | null = null;

export function isAuthorized(): boolean {
  return !!client;
}

export async function checkAuthorized(): Promise<boolean> {
  if (!client) return false;
  const now = Date.now();
  const cacheTtl = 12000 + Math.floor(Math.random() * 8000); // 12-20s jitter
  if (cachedAuth !== null && now - lastAuthCheckAt < cacheTtl) {
    return cachedAuth;
  }
  // Human-like jitter before hitting Telegram
  await sleep(200 + Math.random() * 700);
  try {
    const ok = await client.checkAuthorization();
    cachedAuth = ok;
    lastAuthCheckAt = now;
    if (!ok) logger.warn('checkAuthorized: not authorized');
    return ok;
  } catch {
    cachedAuth = false;
    lastAuthCheckAt = now;
    return false;
  }
}
