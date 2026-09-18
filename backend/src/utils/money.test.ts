// AGPL-3.0 — unit tests for the single source of truth for pricing.
import { describe, it, expect } from 'vitest';
import { dealPricing, toBaseUnits, fromBaseUnits } from './money';

describe('toBaseUnits / fromBaseUnits', () => {
  it('converts TON 9 decimals', () => {
    expect(toBaseUnits('1', 'TON')).toBe('1000000000');
    expect(toBaseUnits('2.5', 'TON')).toBe('2500000000');
    expect(fromBaseUnits('2500000000', 'TON')).toBe('2.5');
  });

  it('converts USDT 6 decimals', () => {
    expect(toBaseUnits('1', 'USDT')).toBe('1000000');
    expect(toBaseUnits('0.000001', 'USDT')).toBe('1');
    expect(fromBaseUnits('1000000', 'USDT')).toBe('1');
  });

  it('rejects unknown asset', () => {
    expect(() => toBaseUnits('1', 'BTC')).toThrow(/Unsupported asset/);
    expect(() => fromBaseUnits('1', 'BTC')).toThrow(/Unsupported asset/);
  });

  it('rejects silent truncation (too many decimals)', () => {
    // TON has 9 decimals — 10 fractional digits must throw, not truncate
    expect(() => toBaseUnits('1.1234567899', 'TON')).toThrow(/Too many decimals/);
    expect(() => toBaseUnits('1.1234567', 'USDT')).toThrow(/Too many decimals/);
  });

  it('rejects invalid decimal strings', () => {
    expect(() => toBaseUnits('abc', 'TON')).toThrow(/Invalid decimal/);
    expect(() => toBaseUnits('', 'TON')).toThrow();
  });

  it('round-trips zero', () => {
    expect(fromBaseUnits('0', 'TON')).toBe('0');
    expect(toBaseUnits('0', 'TON')).toBe('0');
  });
});

describe('dealPricing', () => {
  it('buyer pays price+fee, seller gets price (100bps = 1%)', () => {
    const p = dealPricing('10', 'TON', 100);
    expect(p.priceBase).toBe(10_000_000_000n);
    expect(p.feeBase).toBe(100_000_000n);
    expect(p.expectedDeposit).toBe(10_100_000_000n);
    expect(p.sellerHuman).toBe('10');
    expect(p.feeHuman).toBe('0.1');
  });

  it('zero feeBps means no fee', () => {
    const p = dealPricing('5', 'TON', 0);
    expect(p.feeBase).toBe(0n);
    expect(p.expectedDeposit).toBe(p.priceBase);
  });

  it('defaults to 100bps when fee missing/invalid', () => {
    expect(dealPricing('1', 'TON', null).feeBase).toBe(dealPricing('1', 'TON', 100).feeBase);
    expect(dealPricing('1', 'TON', undefined).feeBase).toBe(dealPricing('1', 'TON', 100).feeBase);
    expect(dealPricing('1', 'TON', NaN).feeBase).toBe(dealPricing('1', 'TON', 100).feeBase);
    expect(dealPricing('1', 'TON', -5).feeBase).toBe(dealPricing('1', 'TON', 100).feeBase);
  });

  it('floors fractional feeBps and caps at 10000', () => {
    const floored = dealPricing('100', 'TON', 150.9);
    const exact150 = dealPricing('100', 'TON', 150);
    expect(floored.feeBase).toBe(exact150.feeBase);
    const capped = dealPricing('1', 'TON', 20000);
    // 100% fee max
    expect(capped.feeBase).toBe(capped.priceBase);
  });

  it('handles USDT 6-decimal math', () => {
    const p = dealPricing('100', 'USDT', 100);
    expect(p.priceBase).toBe(100_000_000n);
    expect(p.feeBase).toBe(1_000_000n);
    expect(p.expectedDeposit).toBe(101_000_000n);
  });

  it('case-insensitive asset, small amounts do not lose dust to fee floor', () => {
    const p = dealPricing('0.000000001', 'ton', 100);
    // 1 nanotons * 1% = 0 (integer division) — documented dust behavior
    expect(p.priceBase).toBe(1n);
    expect(p.feeBase).toBe(0n);
    expect(p.expectedDeposit).toBe(1n);
  });

  it('throws on unsupported asset or bad amount', () => {
    expect(() => dealPricing('1', 'BTC', 100)).toThrow();
    expect(() => dealPricing('not-a-number', 'TON', 100)).toThrow();
  });
});
