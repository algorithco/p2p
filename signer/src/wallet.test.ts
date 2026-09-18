// AGPL-3.0 — strict jetton amount parsing tests.
import { describe, it, expect } from 'vitest';
import { parseJettonAmountToNano } from './wallet';

describe('parseJettonAmountToNano (USDT 6 decimals)', () => {
  it('parses valid amounts', () => {
    expect(parseJettonAmountToNano('1')).toBe(1000000n);
    expect(parseJettonAmountToNano('100.5')).toBe(100500000n);
    expect(parseJettonAmountToNano('0.000001')).toBe(1n);
    expect(parseJettonAmountToNano('  2 ')).toBe(2000000n);
  });

  it('rejects multi-dot strings (old code silently parsed "1.2.3" as 1.2)', () => {
    expect(() => parseJettonAmountToNano('1.2.3')).toThrow(/invalid jetton amount/);
  });

  it('rejects garbage, negatives, hex, zero, >6 decimals', () => {
    for (const bad of ['abc', '', '  ', '-5', '0', '0.000000', '0x10', '1.1234567', '1,5', '+']) {
      expect(() => parseJettonAmountToNano(bad), bad).toThrow();
    }
  });
});
