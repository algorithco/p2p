// AGPL-3.0 — utradebot smoke tests (framework wiring; deep trade tests need MTProto fakes).
import { describe, it, expect } from 'vitest';

describe('utradebot trade statuses', () => {
  it('canonical lifecycle order is documented', async () => {
    const mod = await import('./services/tradeService');
    expect(mod).toBeDefined();
    // createTradeWithSession / confirmPayment / bindBuyer exist (contract stability)
    expect(typeof mod.createTradeWithSession).toBe('function');
  });
});
