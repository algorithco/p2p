import { describe, it, expect } from 'vitest';
import {
  generateDepositToken,
  isDepositTokenFormat,
  depositComment,
  parseDepositToken,
  parseDepositComment,
} from './comments';

describe('P0-1 deposit token', () => {
  it('generateDepositToken returns 32 lower hex chars', () => {
    const t = generateDepositToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('isDepositTokenFormat accepts 32 and 64 hex, rejects short/digits', () => {
    expect(isDepositTokenFormat('a'.repeat(32))).toBe(true);
    expect(isDepositTokenFormat('A'.repeat(32))).toBe(true);
    expect(isDepositTokenFormat('0'.repeat(64))).toBe(true);
    expect(isDepositTokenFormat('abc')).toBe(false);
    expect(isDepositTokenFormat('escrow#123')).toBe(false);
    expect(isDepositTokenFormat('')).toBe(false);
  });

  it('depositComment uses token when valid, else legacy escrow#id', () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    expect(depositComment(42, token)).toBe(token);
    expect(depositComment(42, null)).toBe('escrow#42');
    expect(depositComment(42, 'bad')).toBe('escrow#42');
    expect(depositComment('99', token)).toBe(token);
  });

  it('parseDepositToken extracts bare token and escrow#token', () => {
    const token = 'deadbeef'.repeat(4); // 32 hex
    expect(parseDepositToken(token)).toBe(token.toLowerCase());
    expect(parseDepositToken(`escrow#${token}`)).toBe(token);
    expect(parseDepositToken(`Escrow:${token}`)).toBe(token);
    expect(parseDepositToken('escrow#123')).toBe(null); // digits-only legacy should not be token
    expect(parseDepositToken(null)).toBe(null);
  });

  it('legacy parseDepositComment still works for escrow#<id>', () => {
    expect(parseDepositComment('escrow#7')).toBe(7);
    expect(parseDepositComment('Escrow #123')).toBe(123);
    expect(parseDepositComment('thanks for #123')).toBe(null);
    expect(parseDepositComment('escrow#abc')).toBe(null);
  });

  it('token memo does not falsely parse as legacy id', () => {
    const token = generateDepositToken();
    expect(parseDepositComment(token)).toBe(null);
    expect(parseDepositToken(token)).toBe(token);
  });
});
