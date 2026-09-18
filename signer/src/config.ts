import dotenv from 'dotenv';
dotenv.config();

function requireMnemonic(): string[] {
  const raw = (process.env.SIGNER_MNEMONIC || '').trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function parsePort(): number {
  const n = Number(process.env.PORT || 3001);
  // NaN / out-of-range PORT used to crash app.listen with an obscure error.
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3001;
}

function parseWorkchain(): number {
  const n = Number(process.env.WALLET_WORKCHAIN || 0);
  // Only 0 (basechain) and -1 (masterchain) exist; anything else is a typo.
  return n === -1 || n === 0 ? n : 0;
}

export const config = {
  mnemonic: requireMnemonic(),
  network: (process.env.TON_NETWORK || 'testnet').trim().toLowerCase() as 'testnet' | 'mainnet',
  tonApiEndpoint: process.env.TON_API_ENDPOINT || '',
  toncenterApiKey: process.env.TONCENTER_API_KEY || '',
  apiKey: process.env.SIGNER_API_KEY || '',
  port: parsePort(),
  corsOrigin: process.env.CORS_ORIGIN || '',
  workchain: parseWorkchain(),
  // Optional per-transfer TON cap (human units, e.g. "50"). Unset/0 = unlimited.
  // Defense-in-depth against key-compromise drain; testnet safety net.
  maxSendTon: (process.env.MAX_SEND_TON || '').trim(),
};

export function validateMnemonic(mnemonic: string[]): { valid: boolean; reason?: string } {
  if (mnemonic.length === 0)
    return { valid: false, reason: 'SIGNER_MNEMONIC is empty — signer will run in read-only/no-wallet mode' };
  if (mnemonic.length !== 24)
    return { valid: false, reason: `SIGNER_MNEMONIC must be 24 words, got ${mnemonic.length}` };
  if (!mnemonic.every((w) => /^[a-z]+$/.test(w)))
    return { valid: false, reason: 'SIGNER_MNEMONIC words must be lowercase a-z only' };
  return { valid: true };
}
