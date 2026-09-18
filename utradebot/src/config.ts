import dotenv from 'dotenv';
import nodeCrypto from 'crypto';
dotenv.config();

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  botToken: process.env.UTRADE_BOT_TOKEN || process.env.BOT_TOKEN || '',
  apiId: num(process.env.API_ID, 0),
  apiHash: process.env.API_HASH || '',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number).filter(Boolean),
  databaseUrl: process.env.DATABASE_URL || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  port: num(process.env.PORT, 3003),
  apiKey: process.env.UTRADE_API_KEY || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export function validateConfig(): string[] {
  const errs: string[] = [];
  if (!config.botToken) errs.push('UTRADE_BOT_TOKEN required (@BotFather)');
  if (!config.apiId) errs.push('API_ID required (https://my.telegram.org)');
  if (!config.apiHash) errs.push('API_HASH required');
  if (!config.databaseUrl) errs.push('DATABASE_URL required');
  // Fail-closed ENCRYPTION_KEY in ALL environments (openssl rand -hex 32).
  // Accept 64 hex (32B) or 128 hex (hashed to 32B, same as backend/ubot).
  // SHARING MODEL: this MUST be the SAME value as backend's ENCRYPTION_KEY —
  // backend writes utrade_trades.session_encrypted and this service decrypts
  // it (accountService/sessionCrypto). Mismatched keys = undecryptable webapp-
  // created trades. ubot's key is independent (own session file only).
  if (!config.encryptionKey) {
    errs.push('ENCRYPTION_KEY is required (64 hex chars, openssl rand -hex 32) — refusing plaintext sessions');
  } else if (!/^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(config.encryptionKey)) {
    errs.push('ENCRYPTION_KEY must be 64 hex chars (32 bytes) or 128 hex (64 bytes, will be hashed to 32)');
  }
  return errs;
}

/**
 * Non-secret key fingerprint for cross-service comparison (sha256, first 16
 * hex chars; safe to log). Operator check: this MUST equal backend's
 * fingerprint at boot — a mismatch means this service cannot decrypt
 * backend-written utrade sessions (live breakage, see sessionCrypto).
 */
export function encryptionKeyFingerprint(v?: string): string {
  const s = String(v ?? config.encryptionKey ?? '').trim();
  if (!s) return 'unset';
  return nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}
