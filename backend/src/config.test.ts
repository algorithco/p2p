// AGPL-3.0 — fail-closed ENCRYPTION_KEY validation (all envs).
import { describe, it, expect } from 'vitest';
import { isValidEncryptionKey } from './config';

describe('isValidEncryptionKey', () => {
  it('accepts 64 hex', () => {
    expect(isValidEncryptionKey('a'.repeat(64))).toBe(true);
    expect(isValidEncryptionKey('A1'.repeat(32))).toBe(true);
  });

  it('accepts 128 hex (hashed to 32B)', () => {
    expect(isValidEncryptionKey('b'.repeat(128))).toBe(true);
  });

  it('rejects missing/short/non-hex', () => {
    expect(isValidEncryptionKey('')).toBe(false);
    expect(isValidEncryptionKey('abc')).toBe(false);
    expect(isValidEncryptionKey('z'.repeat(64))).toBe(false);
    // NOTE: no-arg call falls back to process ENCRYPTION_KEY on purpose
    // (assertEncryptionKey() boot gate), so it is not asserted here.
  });
});
