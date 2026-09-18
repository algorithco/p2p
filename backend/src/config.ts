import dotenv from 'dotenv';
import nodeCrypto from 'crypto';
dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  botUsername: process.env.BOT_USERNAME || 'savdochi_uzbot',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && Number.isSafeInteger(n)),
  databaseUrl: process.env.DATABASE_URL || '',
  tonApiEndpoint: process.env.TON_API_ENDPOINT || 'https://tonapi.io',
  tonNetwork: process.env.TON_NETWORK || 'mainnet',
  // Signer microservice (W5 wallet) — holds SIGNER_MNEMONIC isolated
  signerUrl: process.env.SIGNER_URL || 'http://signer:3001',
  signerApiKey: process.env.SIGNER_API_KEY || '',
  escrowContractCodeHex: process.env.ESCROW_CONTRACT_CODE_HEX || '',
  jettonMasterAddress: process.env.JETTON_MASTER_ADDRESS,
  jettonWalletCodeHash: (() => {
    try {
      return BigInt(process.env.JETTON_WALLET_CODE_HASH || '0');
    } catch {
      return BigInt(0);
    }
  })(),
  feeAddress: process.env.FEE_ADDRESS || '',
  feeBps: (() => {
    const n = Number(process.env.FEE_BPS ?? 100);
    if (!Number.isFinite(n)) return 100;
    return Math.min(10000, Math.max(0, Math.floor(n)));
  })(),
  feePercentage: Number(process.env.FEE_PERCENTAGE || 1), // percent
  usdtJettonAddress: process.env.USDT_JETTON_ADDRESS || '',
  minConfirmations: (() => {
    const n = Number(process.env.MIN_CONFIRMATIONS ?? 3);
    if (!Number.isFinite(n)) return 3;
    return Math.min(30, Math.max(1, Math.floor(n)));
  })(),
  adminAddress: process.env.ADMIN_ADDRESS || '',
  apiKey: process.env.API_KEY || undefined,
  adminApiKey: process.env.ADMIN_API_KEY || undefined,
  webappUrl: process.env.WEBAPP_URL || '',
  frontendUrl: process.env.FRONTEND_URL || process.env.WEBAPP_URL || 'http://localhost:8080',
  serveStatic: process.env.SERVE_STATIC === 'true',
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  requireOnchain: process.env.REQUIRE_ONCHAIN === 'true',
  walletAddress: process.env.WALLET_ADDRESS || '',
  // ENCRYPTION_KEY sharing model (do not "fix" by giving each service its own key):
  // - MUST equal utradebot's ENCRYPTION_KEY: backend writes
  //   utrade_trades.session_encrypted (POST /api/utrade/trades) and utradebot
  //   decrypts it (sellFlow/codeHandler via sessionCrypto.decryptSession).
  //   Mismatched keys = undecryptable sessions = broken webapp-created trades.
  // - ubot's key is INDEPENDENT (protects only ubot's own session file).
  // Generate ONE value with `openssl rand -hex 32` and put the SAME value in
  // backend/.env and utradebot/.env (64 hex chars; 128 hex also accepted).
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  // Internal microservices (proxied via backend, keep host-bound)
  ubotUrl: process.env.UBOT_URL || 'http://ubot:3002',
  ubotApiKey: process.env.UBOT_API_KEY || process.env.UBOT_API_KEY || '',
  utradeUrl: process.env.UTRADE_URL || 'http://utradebot:3003',
  utradeApiKey: process.env.UTRADE_API_KEY || '',
  // Fix 3.3: dev auth requires explicit opt-in, never in production by accident
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
};

// Startup validation (fix: config.ts ! assertions had no runtime effect, enabling 3.3)
if (!config.databaseUrl) {
  console.warn('[config] DATABASE_URL not set — backend will fail to connect to Postgres');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[config] DATABASE_URL is required in production — refusing to boot fail-open');
  }
}
export function isValidEncryptionKey(v?: string): boolean {
  const s = String(v ?? config.encryptionKey ?? '').trim();
  return /^[0-9a-fA-F]{64}$/.test(s) || /^[0-9a-fA-F]{128}$/.test(s);
}
/**
 * Fail-closed ENCRYPTION_KEY gate for boot — ALL environments (not just prod).
 * Chat keys, memos and phone fields must never silently fall back to plaintext
 * in a money-moving service. Generate with `openssl rand -hex 32` (64 hex).
 * Throws on missing/malformed key; call at service boot (not at import so
 * unit tests can import config without a real key).
 */
export function assertEncryptionKey(): void {
  if (!isValidEncryptionKey()) {
    throw new Error(
      '[config] ENCRYPTION_KEY is required and must be 64 hex chars (openssl rand -hex 32; 128 hex also accepted and hashed) — refusing to boot rather than store chat keys/memos in plaintext',
    );
  }
}
/**
 * Non-secret key fingerprint for cross-service comparison (sha256, first 16
 * hex chars). Logging the fingerprint is safe (no preimage from 256-bit key
 * material). Operator check: backend and utradebot fingerprints MUST match;
 * compare the two services' boot logs. A mismatch means utradebot cannot
 * decrypt backend-written utrade sessions (live breakage).
 */
export function encryptionKeyFingerprint(v?: string): string {
  const s = String(v ?? config.encryptionKey ?? '').trim();
  if (!s) return 'unset';
  return nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}
if (
  config.encryptionKey &&
  !/^[0-9a-fA-F]{64}$/.test(config.encryptionKey) &&
  !/^[0-9a-fA-F]{128}$/.test(config.encryptionKey)
) {
  console.warn(
    '[config] ENCRYPTION_KEY is set but not 64 or 128 hex chars — encryption will be disabled (fail-closed for utrade)',
  );
}
if (config.feeBps < 0 || config.feeBps > 10000) {
  console.warn(`[config] FEE_BPS ${config.feeBps} out of range 0-10000, clamping may occur`);
}
