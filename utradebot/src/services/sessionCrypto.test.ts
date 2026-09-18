// AGPL-3.0 — sessionCrypto: wrong-key decrypt must throw (never propagate blobs).
import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../config';
import { encryptSession, decryptSession } from './sessionCrypto';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const savedKey = config.encryptionKey;

afterEach(() => {
  config.encryptionKey = savedKey;
});

function withKey(key: string, fn: () => void): void {
  config.encryptionKey = key;
  fn();
}

/** Encrypt until the blob's first base64 char is not '1' (avoids the documented 1.5% legacy-plaintext ambiguity). */
function encryptUnambiguous(plain: string): string {
  config.encryptionKey = KEY_A;
  for (let i = 0; i < 500; i++) {
    const enc = encryptSession(plain);
    if (enc[0] !== '1') return enc;
  }
  throw new Error('test setup failed: could not produce unambiguous blob');
}

describe('decryptSession key handling', () => {
  it('round-trips with the same key', () => {
    const plain = '1' + 's'.repeat(200);
    let enc = '';
    withKey(KEY_A, () => {
      enc = encryptSession(plain);
    });
    withKey(KEY_A, () => {
      expect(decryptSession(enc)).toBe(plain);
    });
  });

  it('throws a diagnosable error on wrong-key decrypt (no silent blob propagation)', () => {
    const enc = encryptUnambiguous('seller-session-payload-' + 'x'.repeat(120));
    config.encryptionKey = KEY_B;
    expect(() => decryptSession(enc)).toThrow(/key mismatch/);
  });

  it('tolerates legacy plaintext sessions without throwing', () => {
    const legacyPlain = '1' + 'y'.repeat(150);
    config.encryptionKey = KEY_B;
    expect(decryptSession(legacyPlain)).toBe(legacyPlain);
  });

  it('passes through short / non-blob input', () => {
    config.encryptionKey = KEY_B;
    expect(decryptSession('phone:+1234567')).toBe('phone:+1234567');
    expect(decryptSession('')).toBe('');
  });

  it('passes through input when no key is configured (boot gate covers prod)', () => {
    const enc = encryptUnambiguous('whatever-' + 'z'.repeat(120));
    config.encryptionKey = '';
    expect(decryptSession(enc)).toBe(enc);
  });
});
