import dotenv from 'dotenv';
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
  // Seller-buyer chat E2E encryption: 64 hex chars (32 bytes) for AES-256-GCM. Must match ubot/utradebot when shared.
  // Generate: openssl rand -hex 32  (or PowerShell: -join (0..31 | % { "{0:X2}" -f (Get-Random -Max 256) }))
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
