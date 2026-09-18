import * as crypto from 'crypto';
import { config } from '../config';

function getKey(): Buffer | null {
  if (!config.encryptionKey) return null;
  try {
    return Buffer.from(config.encryptionKey, 'hex');
  } catch {
    return null;
  }
}

export function encryptSession(plain: string): string {
  const key = getKey();
  if (!key) {
    // Fail-closed in production: never silently persist a plaintext session.
    if (process.env.NODE_ENV === 'production' || process.env.STRICT_ENCRYPTION === 'true') {
      throw new Error(
        'encryption_not_configured: ENCRYPTION_KEY missing or invalid — refusing to store plaintext session in production',
      );
    }
    // No key: return plain with warning marker (caller should ensure key is set in prod)
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSession(encB64: string): string {
  const key = getKey();
  if (!key) return encB64;
  const raw = String(encB64 || '');
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return raw;
  }
  // Too short to be one of our blobs (iv 12 + tag 16 + >=1 cipher byte) —
  // treat as plaintext (phone numbers, short placeholders).
  if (buf.length < 28) return raw;
  try {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    const res = dec.toString('utf8');
    if (res) return res;
    return raw;
  } catch {
    // GCM auth failed: either a legacy PLAINTEXT session or a blob encrypted
    // under a DIFFERENT key (backend and utradebot MUST share ENCRYPTION_KEY —
    // see ../config.ts). Plaintext StringSessions always start with '1' and are
    // long; anything else that fails auth is undecryptable here. Throw instead
    // of returning the ciphertext — propagating the blob into StringSession()
    // fails later at Telegram with a misleading error and hides key mismatches.
    if (raw.length > 100 && raw.startsWith('1')) return raw;
    throw new Error(
      'session decryption failed — key mismatch or invalid session ' +
        '(AES-256-GCM auth failed; backend and utradebot MUST share the same ENCRYPTION_KEY)',
    );
  }
}

export function hasEncryption(): boolean {
  return !!getKey();
}

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}
