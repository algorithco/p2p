import dotenv from 'dotenv';
dotenv.config();

// Optional zod import — fallback to manual validation if not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let zod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  zod = require('zod');
} catch {
  zod = null;
}

export function num(v: string | undefined, def: number): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function str(v: string | undefined, def: string): string {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  return s === '' ? def : s;
}

export const config = {
  apiId: num(process.env.API_ID, 0),
  apiHash: str(process.env.API_HASH, ''),
  sessionString: str(process.env.UBOT_SESSION_STRING, ''),
  phone: str(process.env.UBOT_PHONE, ''),
  twoFaPassword: str(process.env.TWO_FA_PASSWORD, ''),
  // INDEPENDENT key: protects only ubot's own session file
  // (sessions/ubot.session.enc) and UBOT_SESSION_STRING. It does NOT need to
  // match backend/utradebot — ubot reads no shared encrypted columns (unlike
  // backend<->utradebot, which MUST share one key for utrade sessions).
  encryptionKey: str(process.env.ENCRYPTION_KEY, ''),
  port: num(process.env.PORT, 3002),
  apiKey: str(process.env.UBOT_API_KEY, ''),
  databaseUrl: str(process.env.DATABASE_URL, ''),
  logLevel: str(process.env.LOG_LEVEL, 'info'),
  nodeEnv: str(process.env.NODE_ENV, 'development'),
  isProduction: process.env.NODE_ENV === 'production',

  // New tunable fields
  takeoverCooldownHours: num(
    (process.env.TAKEOVER_COOLDOWN_H ?? process.env.TAKEOVER_COOLDOWN_HOURS) as string | undefined,
    24,
  ),
  globalRateMs: num(process.env.GLOBAL_RATE_MS as string | undefined, 1300),
  cacheTtlSeconds: num((process.env.CACHE_TTL_S ?? process.env.CACHE_TTL_SECONDS) as string | undefined, 300),
  deviceModel: str(process.env.DEVICE_MODEL, 'Pixel 7'),
  systemVersion: str(process.env.SYSTEM_VERSION, '14'),
  appVersion: str(process.env.APP_VERSION, '10.2.1'),
  humanDelayMinMs: num((process.env.HUMAN_DELAY_MIN ?? process.env.HUMAN_DELAY_MIN_MS) as string | undefined, 800),
  humanDelayMaxMs: num((process.env.HUMAN_DELAY_MAX ?? process.env.HUMAN_DELAY_MAX_MS) as string | undefined, 2500),
  floodThreshold: num(process.env.FLOOD_THRESHOLD as string | undefined, 60),
  maxPromotePerMin: num(process.env.MAX_PROMOTE_PER_MIN as string | undefined, 10),
  maxTransferPerMin: num(process.env.MAX_TRANSFER_PER_MIN as string | undefined, 2),
  proxyUrl: str(
    (process.env.PROXY_URL ??
      process.env.HTTP_PROXY ??
      process.env.HTTPS_PROXY ??
      process.env.http_proxy ??
      process.env.https_proxy) as string | undefined,
    '',
  ),
  warmupEnabled: str(process.env.WARMUP, 'true').toLowerCase() !== 'false',
  // LAZY MODE (ban-risk reduction): do NOT connect to Telegram at boot and do NOT
  // poll checkAuthorization on a timer. Connect only on the first real channel/group
  // request; teleproto keep-alive + on-demand ensureClient keep it alive after that.
  // Opt back into eager boot with UBOT_PRECONNECT=true (debugging only).
  preconnect: str(process.env.UBOT_PRECONNECT, 'false').toLowerCase() === 'true',
  // Background auth poll interval (ms). 0 = OFF (default). Any positive value re-enables
  // the old periodic checkAuthorized loop — each tick is a Telegram API call, so keep off.
  authPollMs: num(process.env.UBOT_AUTH_POLL_MS as string | undefined, 0),
  // Idle auto-disconnect (ms): close the MTProto connection after this long with no
  // ensured activity. 0 = never (stay connected). disconnect() is local — zero TG calls.
  idleDisconnectMs: num(process.env.UBOT_IDLE_DISCONNECT_MS as string | undefined, 15 * 60 * 1000),
  // teleproto TCP keep-alive ping (ms). Was hardcoded 30s — far below the ~5min Docker
  // NAT idle timeout, so 120s default quarters ping traffic with no drop risk.
  keepAliveMs: num(process.env.UBOT_KEEPALIVE_MS as string | undefined, 120_000),
};

// Optional zod schema if zod is available
let zodSchema: any = null;
if (zod && typeof zod.object === 'function') {
  try {
    const z = zod;
    zodSchema = z.object({
      apiId: z.number().int().positive(),
      apiHash: z.string().min(1),
      encryptionKey: z
        .string()
        .regex(/^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/)
        .or(z.literal(''))
        .optional(),
      apiKey: z.string().min(32).or(z.literal('')).optional(),
      port: z.number().int().min(1024).max(65535),
      takeoverCooldownHours: z.number().min(0).max(720),
      globalRateMs: z.number().min(100).max(30000),
      cacheTtlSeconds: z.number().min(0).max(86400),
      humanDelayMinMs: z.number().min(0).max(10000),
      humanDelayMaxMs: z.number().min(0).max(30000),
      floodThreshold: z.number().min(0).max(1000),
      maxPromotePerMin: z.number().int().min(1).max(100),
      maxTransferPerMin: z.number().int().min(1).max(100),
      deviceModel: z.string(),
      systemVersion: z.string(),
      appVersion: z.string(),
    });
  } catch {
    zodSchema = null;
  }
}

export function validateConfig(): string[] {
  const errs: string[] = [];

  // If zod schema exists, use it for base validation and collect its errors
  if (zodSchema && typeof zodSchema.safeParse === 'function') {
    const result = zodSchema.safeParse({
      apiId: config.apiId,
      apiHash: config.apiHash,
      encryptionKey: config.encryptionKey,
      apiKey: config.apiKey,
      port: config.port,
      takeoverCooldownHours: config.takeoverCooldownHours,
      globalRateMs: config.globalRateMs,
      cacheTtlSeconds: config.cacheTtlSeconds,
      humanDelayMinMs: config.humanDelayMinMs,
      humanDelayMaxMs: config.humanDelayMaxMs,
      floodThreshold: config.floodThreshold,
      maxPromotePerMin: config.maxPromotePerMin,
      maxTransferPerMin: config.maxTransferPerMin,
      deviceModel: config.deviceModel,
      systemVersion: config.systemVersion,
      appVersion: config.appVersion,
    });
    if (!result.success) {
      for (const issue of result.error.issues || result.error.errors || []) {
        const path = issue.path ? issue.path.join('.') : 'config';
        errs.push(`${path}: ${issue.message}`);
      }
    }
    // Still run manual presence checks for required fields to keep original messages
    if (!config.apiId) errs.push('API_ID required (https://my.telegram.org)');
    if (!config.apiHash) errs.push('API_HASH required');
  } else {
    // Manual fallback
    if (!config.apiId) errs.push('API_ID required (https://my.telegram.org)');
    if (!config.apiHash) errs.push('API_HASH required');
    if (config.encryptionKey && !/^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(config.encryptionKey)) {
      errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes) or 128 hex (64 bytes, will be hashed to 32)');
    }
    if (config.apiKey && config.apiKey.length < 32) {
      errs.push('UBOT_API_KEY should be 32+ random chars (64 hex recommended)');
    }
    if (config.apiKey && /^[a-zA-Z0-9]{1,20}$/.test(config.apiKey)) {
      errs.push('UBOT_API_KEY is weak (too short/simple)');
    }
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
      errs.push('PORT must be 1024-65535');
    }
    if (
      !Number.isFinite(config.takeoverCooldownHours) ||
      config.takeoverCooldownHours < 0 ||
      config.takeoverCooldownHours > 720
    ) {
      errs.push('TAKEOVER_COOLDOWN_H must be 0-720 hours');
    }
    if (!Number.isFinite(config.globalRateMs) || config.globalRateMs < 100 || config.globalRateMs > 30000) {
      errs.push('GLOBAL_RATE_MS must be 100-30000 ms');
    }
    if (!Number.isFinite(config.cacheTtlSeconds) || config.cacheTtlSeconds < 0 || config.cacheTtlSeconds > 86400) {
      errs.push('CACHE_TTL_S must be 0-86400 seconds');
    }
    if (!Number.isFinite(config.humanDelayMinMs) || config.humanDelayMinMs < 0 || config.humanDelayMinMs > 10000) {
      errs.push('HUMAN_DELAY_MIN must be 0-10000 ms');
    }
    if (!Number.isFinite(config.humanDelayMaxMs) || config.humanDelayMaxMs < 0 || config.humanDelayMaxMs > 30000) {
      errs.push('HUMAN_DELAY_MAX must be 0-30000 ms');
    }
    if (config.humanDelayMinMs > config.humanDelayMaxMs) {
      errs.push('HUMAN_DELAY_MIN cannot exceed HUMAN_DELAY_MAX');
    }
    if (!Number.isFinite(config.floodThreshold) || config.floodThreshold < 0 || config.floodThreshold > 1000) {
      errs.push('FLOOD_THRESHOLD must be 0-1000');
    }
    if (!Number.isInteger(config.maxPromotePerMin) || config.maxPromotePerMin < 1 || config.maxPromotePerMin > 100) {
      errs.push('MAX_PROMOTE_PER_MIN must be 1-100');
    }
    if (!Number.isInteger(config.maxTransferPerMin) || config.maxTransferPerMin < 1 || config.maxTransferPerMin > 100) {
      errs.push('MAX_TRANSFER_PER_MIN must be 1-100');
    }
    if (
      !Number.isFinite(config.authPollMs) ||
      config.authPollMs < 0 ||
      (config.authPollMs > 0 && config.authPollMs < 30_000) ||
      config.authPollMs > 3_600_000
    ) {
      errs.push('UBOT_AUTH_POLL_MS must be 0 (off) or 30000-3600000 ms');
    }
    if (
      !Number.isFinite(config.idleDisconnectMs) ||
      config.idleDisconnectMs < 0 ||
      (config.idleDisconnectMs > 0 && config.idleDisconnectMs < 60_000) ||
      config.idleDisconnectMs > 86_400_000
    ) {
      errs.push('UBOT_IDLE_DISCONNECT_MS must be 0 (never) or 60000-86400000 ms');
    }
    if (!Number.isFinite(config.keepAliveMs) || config.keepAliveMs < 30_000 || config.keepAliveMs > 600_000) {
      errs.push('UBOT_KEEPALIVE_MS must be 30000-600000 ms');
    }
  }

  // Cross-field manual checks that zod may not cover fully when fallback
  if (!zodSchema) {
    // already pushed
  } else {
    // Also ensure cross-field human delay ordering even when zod passes
    if (config.humanDelayMinMs > config.humanDelayMaxMs && !errs.some((e) => e.includes('HUMAN_DELAY_MIN'))) {
      errs.push('HUMAN_DELAY_MIN cannot exceed HUMAN_DELAY_MAX');
    }
    // Ensure ENCRYPTION_KEY and API_KEY messages are user-friendly when zod gives generic regex error
    if (config.encryptionKey && !/^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(config.encryptionKey)) {
      if (!errs.some((e) => e.includes('ENCRYPTION_KEY'))) {
        errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes) or 128 hex (64 bytes, will be hashed to 32)');
      }
    }
    if (config.apiKey && config.apiKey.length > 0 && config.apiKey.length < 32) {
      if (!errs.some((e) => e.includes('UBOT_API_KEY'))) {
        errs.push('UBOT_API_KEY should be 32+ random chars (64 hex recommended)');
      }
    }
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
      if (!errs.some((e) => e.includes('PORT'))) errs.push('PORT must be 1024-65535');
    }
  }

  // Fail-closed ENCRYPTION_KEY in ALL environments (money/account-custody
  // service must never silently store sessions plaintext). Generate with
  // `openssl rand -hex 32`.
  if (!config.encryptionKey) {
    errs.push('ENCRYPTION_KEY is required (64 hex chars, openssl rand -hex 32) — refusing plaintext sessions');
  } else if (!/^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(config.encryptionKey)) {
    if (!errs.some((e) => e.includes('ENCRYPTION_KEY'))) {
      errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes) or 128 hex (64 bytes, will be hashed to 32)');
    }
  }

  // Deduplicate
  return [...new Set(errs)];
}
