// AGPL-3.0 — money-handling core tests. Bugs here cause real financial loss,
// so every state-transition edge is locked: wrong `from`, concurrent moves,
// idempotency reuse, partial fee failures.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede the SUT import) ──
vi.mock('../db/queries', () => ({
  db: { query: vi.fn(), connect: vi.fn() },
  saveAdminAlert: vi.fn().mockResolvedValue({}),
}));

vi.mock('../blockchain/signerClient', () => ({
  sendTon: vi.fn(),
  sendJetton: vi.fn(),
}));

vi.mock('../bot/notify', () => ({
  unknownDepositToAdmins: vi.fn().mockResolvedValue(undefined),
  adminDecisionToParty: vi.fn().mockResolvedValue(undefined),
  releasedToBuyer: vi.fn().mockResolvedValue(undefined),
  releasedToSeller: vi.fn().mockResolvedValue(undefined),
  depositToSeller: vi.fn().mockResolvedValue(undefined),
  shippedToBuyer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/encryption', () => ({
  encryptField: (s: string) => `enc(${s})`,
}));

vi.mock('../config', () => ({
  config: {
    feeAddress: 'UQ_fee_address_for_tests_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    feeBps: 100,
    jettonMasterAddress: 'UQ_jetton_master_for_tests_BBBBBBBBBBBBBBBBBBBB',
    usdtJettonAddress: '',
    adminTelegramIds: [] as number[],
    ubotUrl: 'http://ubot:3002',
    ubotApiKey: '',
  },
}));

import { db } from '../db/queries';
import { sendTon, sendJetton } from '../blockchain/signerClient';
import { DEAL_STATUS } from './dealService';
import {
  isValidTransition,
  feeParts,
  payoutIdempotencyKey,
  pendingStatusFor,
  isPendingStatus,
  executePayout,
  guardedTransition,
  adminRelease,
  adminRefund,
  buyerApproveReceipt,
  markItemSent,
  reconcileStuckPayouts,
} from './escrowService';

const mockDb = vi.mocked(db);
const mockSendTon = vi.mocked(sendTon);
const mockSendJetton = vi.mocked(sendJetton);

function mockClient(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] });
      if (/SELECT \* FROM deals WHERE id/i.test(sql)) return Promise.resolve({ rowCount: rows.length, rows });
      if (/UPDATE deals SET status/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [{ id: 1 }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendTon.mockReset();
  mockSendJetton.mockReset();
  mockSendTon.mockResolvedValue({ seqno: 1 });
  mockSendJetton.mockResolvedValue({ seqno: 1 });
  mockDb.query.mockReset();
  mockDb.query.mockResolvedValue({ rowCount: 0, rows: [] } as never);
  mockDb.connect.mockReset();
});

describe('isValidTransition', () => {
  it('RELEASED allowed only from CONFIRMED/ITEM_SENT (P2-8 BUYER_CONFIRMED removed)', () => {
    expect(isValidTransition('DEPOSIT_CONFIRMED', 'RELEASED')).toBe(true);
    expect(isValidTransition('ITEM_SENT', 'RELEASED')).toBe(true);
    expect(isValidTransition('BUYER_CONFIRMED', 'RELEASED')).toBe(false);
    expect(isValidTransition('AWAITING_DEPOSIT', 'RELEASED')).toBe(false);
    expect(isValidTransition('RELEASED', 'RELEASED')).toBe(false);
  });

  it('REFUNDED never from AWAITING_DEPOSIT (no backing funds in hot wallet)', () => {
    expect(isValidTransition('AWAITING_DEPOSIT', 'REFUNDED')).toBe(false);
    expect(isValidTransition('DEPOSIT_CONFIRMED', 'REFUNDED')).toBe(true);
    expect(isValidTransition('ITEM_SENT', 'REFUNDED')).toBe(true);
    expect(isValidTransition('BUYER_CONFIRMED', 'REFUNDED')).toBe(false);
  });

  it('rejects unknown targets', () => {
    expect(isValidTransition('ITEM_SENT', 'AWAITING_DEPOSIT')).toBe(false);
  });
});

describe('idempotency helpers', () => {
  it('deterministic key per deal+direction', () => {
    expect(payoutIdempotencyKey(42, 'RELEASED')).toBe('release:42');
    expect(payoutIdempotencyKey(42, 'REFUNDED')).toBe('refund:42');
    expect(payoutIdempotencyKey(42, 'RELEASED')).toBe(payoutIdempotencyKey(42, 'RELEASED'));
  });

  it('pending status mapping + guard', () => {
    expect(pendingStatusFor('RELEASED')).toBe('RELEASE_PENDING');
    expect(pendingStatusFor('REFUNDED')).toBe('REFUND_PENDING');
    expect(isPendingStatus('RELEASE_PENDING')).toBe(true);
    expect(isPendingStatus('REFUND_PENDING')).toBe(true);
    expect(isPendingStatus('ITEM_SENT')).toBe(false);
  });
});

describe('feeParts', () => {
  it('splits price vs fee (1% default shape)', () => {
    const f = feeParts('10', 'TON', 100);
    expect(f.sellerHuman).toBe('10');
    expect(f.feeHuman).toBe('0.1');
    expect(f.feeBase).toBe(100_000_000n);
  });

  it('zero fee', () => {
    const f = feeParts('10', 'TON', 0);
    expect(f.feeBase).toBe(0n);
  });
});

describe('executePayout', () => {
  it('TON release sends principal + fee leg', async () => {
    mockSendTon.mockResolvedValue({ seqno: 1 });
    const r = await executePayout(
      {
        assetUpper: 'TON',
        principalHuman: '10',
        amountStr: '10',
        feeHuman: '0.1',
        feeBase: 100_000_000n,
        toAddress: 'UQ_test',
        encryptedMemo: 'enc(memo)',
        idempotencyKey: 'release:1',
      },
      1,
    );
    expect(r.feeFailed).toBe(false);
    expect(mockSendTon).toHaveBeenCalledTimes(2);
    expect(mockSendTon.mock.calls[0][0]).toMatchObject({ to: 'UQ_test', value: '10' });
  });

  it('fee-leg failure never throws — deal must still finalize with fee_payout_failed', async () => {
    mockSendTon.mockResolvedValueOnce({ seqno: 1 }).mockRejectedValueOnce(new Error('fee send boom'));
    const r = await executePayout(
      {
        assetUpper: 'TON',
        principalHuman: '10',
        amountStr: '10',
        feeHuman: '0.1',
        feeBase: 100_000_000n,
        toAddress: 'UQ_test',
        encryptedMemo: 'enc(memo)',
        idempotencyKey: 'release:2',
      },
      2,
    );
    expect(r.feeFailed).toBe(true);
    expect(r.feeError).toMatch(/fee send boom/);
  });

  it('principal-leg failure throws (caller rolls back + alerts)', async () => {
    mockSendTon.mockRejectedValueOnce(new Error('chain down'));
    await expect(
      executePayout(
        {
          assetUpper: 'TON',
          principalHuman: '10',
          amountStr: '10',
          feeHuman: '0.1',
          feeBase: 100_000_000n,
          toAddress: 'UQ_test',
          encryptedMemo: 'enc(memo)',
          idempotencyKey: 'release:3',
        },
        3,
      ),
    ).rejects.toThrow(/chain down/);
  });

  it('refund sends full price+fee as principal with NO separate fee leg when feeBase=0', async () => {
    mockSendTon.mockResolvedValue({ seqno: 5 });
    const r = await executePayout(
      {
        assetUpper: 'TON',
        principalHuman: '10.1',
        amountStr: '10',
        feeHuman: '0.1',
        feeBase: 0n, // refund model: fee returns inside principal
        toAddress: 'UQ_buyer',
        encryptedMemo: 'enc(refund)',
        idempotencyKey: 'refund:4',
      },
      4,
    );
    expect(r.feeFailed).toBe(false);
    expect(mockSendTon).toHaveBeenCalledTimes(1);
  });

  it('USDT path uses sendJetton', async () => {
    mockSendJetton.mockResolvedValue({ seqno: 9 });
    await executePayout(
      {
        assetUpper: 'USDT',
        principalHuman: '100',
        amountStr: '100',
        feeHuman: '0',
        feeBase: 0n,
        toAddress: 'UQ_buyer',
        encryptedMemo: 'enc(m)',
        idempotencyKey: 'release:5',
      },
      5,
    );
    expect(mockSendJetton).toHaveBeenCalledOnce();
  });
});

describe('guardedTransition', () => {
  function dealRow(over: Record<string, unknown> = {}) {
    return {
      id: 1,
      status: 'ITEM_SENT',
      asset: 'TON',
      amount: '10',
      fee_bps: 100,
      seller_telegram_id: 111,
      buyer_telegram_id: 222,
      payout_address: 'UQ_seller',
      terms: '',
      ...over,
    };
  }

  it('throws invalid_transition when from-status is wrong', async () => {
    const client = mockClient([dealRow({ status: 'AWAITING_DEPOSIT' })]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(guardedTransition(1, DEAL_STATUS.RELEASED)).rejects.toThrow(/invalid_transition/);
  });

  it('refuses second send while PENDING (payout_in_progress)', async () => {
    const client = mockClient([dealRow({ status: 'RELEASE_PENDING', payout_idempotency_key: 'release:1' })]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(guardedTransition(1, DEAL_STATUS.RELEASED)).rejects.toThrow(/payout_in_progress/);
    expect(mockSendTon).not.toHaveBeenCalled();
  });

  it('throws deal_not_found for missing row', async () => {
    const client = mockClient([]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(guardedTransition(999, DEAL_STATUS.RELEASED)).rejects.toThrow(/deal_not_found/);
  });

  it('concurrent move between lock and mark surfaces as concurrent_transition', async () => {
    const client = mockClient([dealRow()]);
    // Second query (the guarded UPDATE ... WHERE status=from) affects 0 rows
    let calls = 0;
    client.query.mockImplementation((sql: string) => {
      if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] });
      if (/SELECT \* FROM deals/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [dealRow()] });
      if (/UPDATE deals SET status/i.test(sql) && ++calls >= 1) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    mockDb.connect.mockResolvedValue(client as never);
    await expect(guardedTransition(1, DEAL_STATUS.RELEASED)).rejects.toThrow(/concurrent_transition/);
  });

  it('missing payout address fails closed without sending', async () => {
    const client = mockClient([dealRow({ payout_address: null })]);
    mockDb.connect.mockResolvedValue(client as never);
    // resolvePayoutAddress falls back to db.query users lookup — make it empty
    mockDb.query.mockResolvedValue({ rowCount: 0, rows: [] } as never);
    await expect(guardedTransition(1, DEAL_STATUS.RELEASED)).rejects.toThrow(
      /seller_ton_address_required|payout_address_required/,
    );
  });
});

describe('admin guards', () => {
  it('non-admin cannot release/refund', async () => {
    // admin list comes from env; in test env it is empty so any id is non-admin
    const r1 = await adminRelease(999999999, 1);
    expect(r1.success).toBe(false);
    const r2 = await adminRefund(999999999, 1);
    expect(r2.success).toBe(false);
  });
});

describe('buyerApproveReceipt guards', () => {
  it('wrong buyer cannot approve', async () => {
    const client = mockClient([
      { id: 1, status: 'ITEM_SENT', asset: 'TON', amount: '5', seller_telegram_id: 111, buyer_telegram_id: 222 },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    const r = await buyerApproveReceipt(999, 1);
    expect(r.success).toBe(false);
  });

  it('requires ITEM_SENT (DEPOSIT_CONFIRMED asks seller to ship first)', async () => {
    const client = mockClient([
      {
        id: 1,
        status: 'DEPOSIT_CONFIRMED',
        asset: 'TON',
        amount: '5',
        seller_telegram_id: 111,
        buyer_telegram_id: 222,
      },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    const r = await buyerApproveReceipt(222, 1);
    expect(r.success).toBe(false);
    expect(String(r.message)).toMatch(/DEPOSIT_CONFIRMED|Yetkazdim|ship/i);
  });

  it('refuses while PENDING', async () => {
    const client = mockClient([
      { id: 1, status: 'RELEASE_PENDING', asset: 'TON', amount: '5', seller_telegram_id: 111, buyer_telegram_id: 222 },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    const r = await buyerApproveReceipt(222, 1);
    expect(r.success).toBe(false);
    expect(String(r.message)).toMatch(/jarayonda|progress/i);
  });
});

describe('markItemSent guards', () => {
  it('only seller can mark shipped and only from DEPOSIT_CONFIRMED', async () => {
    const notSeller = mockClient([
      { id: 1, status: 'DEPOSIT_CONFIRMED', seller_telegram_id: 111, buyer_telegram_id: 222 },
    ]);
    mockDb.connect.mockResolvedValue(notSeller as never);
    expect((await markItemSent(999, 1)).success).toBe(false);

    const wrongStatus = mockClient([
      { id: 1, status: 'AWAITING_DEPOSIT', seller_telegram_id: 111, buyer_telegram_id: 222 },
    ]);
    mockDb.connect.mockResolvedValue(wrongStatus as never);
    expect((await markItemSent(111, 1)).success).toBe(false);
  });
});

describe('reconcileStuckPayouts', () => {
  it('returns 0 when query fails (never throws at boot)', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('db down'));
    await expect(reconcileStuckPayouts()).resolves.toBe(0);
  });
});
