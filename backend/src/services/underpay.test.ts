import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  db: { query: vi.fn(), connect: vi.fn() },
  saveAdminAlert: vi.fn().mockResolvedValue({}),
}));
vi.mock('../blockchain/signerClient', () => ({
  sendTon: vi.fn().mockResolvedValue({ seqno: 1 }),
  sendJetton: vi.fn().mockResolvedValue({ seqno: 1 }),
}));
vi.mock('../utils/encryption', () => ({
  encryptField: (s: string) => `enc(${s})`,
}));
vi.mock('../config', () => ({
  config: {
    feeAddress: '',
    feeBps: 100,
    jettonMasterAddress: '',
    usdtJettonAddress: '',
    adminTelegramIds: [],
  },
}));

import { sendTon } from '../blockchain/signerClient';
import { tryRefundUnderpay } from './escrowService';

describe('P5-15 tryRefundUnderpay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refundAttempted false when no underpay', async () => {
    const r = await tryRefundUnderpay({ id: 1, asset: 'TON', confirmations: {} });
    expect(r.refundAttempted).toBe(false);
  });

  it('sends TON refund to captured src with idempotency underpay-refund:<id>', async () => {
    // Use a valid TON address (raw 0:<64 hex> parsed)
    const { Address } = await import('@ton/core');
    const src = Address.parse('0:' + '11'.repeat(32)).toString({ urlSafe: true, bounceable: false });
    const deal = {
      id: 42,
      asset: 'TON',
      confirmations: { underpay: { amount: '1.5', src } },
    };
    const r = await tryRefundUnderpay(deal);
    expect(r.refundAttempted).toBe(true);
    expect(r.refundSucceeded).toBe(true);
    expect(vi.mocked(sendTon)).toHaveBeenCalledOnce();
    const arg = vi.mocked(sendTon).mock.calls[0][0] as { to: string; value: string; idempotencyKey: string };
    expect(arg.to).toBe(src);
    expect(arg.value).toBe('1.5');
    expect(arg.idempotencyKey).toBe('underpay-refund:42');
  });

  it('simulates underpay sitting past timeout — refund is sent (P5-15 integration)', async () => {
    const { Address } = await import('@ton/core');
    const src = Address.parse('0:' + '22'.repeat(32)).toString({ urlSafe: true, bounceable: false });
    const deal = {
      id: 99,
      asset: 'TON',
      // Simulate listener captured underpay that sat past 10h
      confirmations: { underpay: { amount: '0.8', src, at: new Date(Date.now() - 11 * 3600 * 1000).toISOString() } },
    };
    const r = await tryRefundUnderpay(deal);
    expect(r.refundSucceeded).toBe(true);
    expect(vi.mocked(sendTon)).toHaveBeenCalled();
  });

  it('handles missing src gracefully (no refund)', async () => {
    const r = await tryRefundUnderpay({ id: 2, asset: 'TON', confirmations: { underpay: { amount: '1', src: '' } } });
    expect(r.refundAttempted).toBe(false);
  });
});
