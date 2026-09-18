// AGPL-3.0 — ubot config helper tests.
import { describe, it, expect } from 'vitest';
import { num, str } from './config';

describe('ubot config helpers', () => {
  it('num falls back on empty/invalid', () => {
    expect(num(undefined, 5)).toBe(5);
    expect(num('', 5)).toBe(5);
    expect(num('abc', 5)).toBe(5);
    expect(num('42', 5)).toBe(42);
  });

  it('str trims and falls back on empty', () => {
    expect(str(undefined, 'd')).toBe('d');
    expect(str('   ', 'd')).toBe('d');
    expect(str('  x  ', 'd')).toBe('x');
  });
});
