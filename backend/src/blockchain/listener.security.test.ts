// AGPL-3.0 — listener forgery-defense tests: fake jetton master, legacy-memo hold.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  db: { query: vi.fn(), connect: vi.fn() },
  saveAdminAlert: vi.fn().mockResolvedValue({}),
}));
vi.mock('./signerClient', () => ({
  sendTon: vi.fn(),
  sendJetton: vi.fn(),
}));
vi.mock('../bot/notify', () => ({
  unknownDepositToAdmins: vi.fn().mockResolvedValue(undefined),
  depositToSeller: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/tonPayload', () => ({
  decryptCommentString: (s: string | null) => s,
}));
vi.mock('../utils/encryption', () => ({
  encryptField: (s: string) => `enc(${s})`,
}));
vi.mock('../config', () => ({
  config: {
    feeBps: 100,
    jettonMasterAddress: '0:' + '44'.repeat(32),
    usdtJettonAddress: '',
  },
}));
vi.mock('./jettonUtils', () => ({
  computeJettonWalletAddress: vi.fn(),
}));

import { db } from '../db/queries';
import { processTonDeposit, processJettonDeposit } from './listener';
import { computeJettonWalletAddress } from './jettonUtils';
import { updateDealStatus } from '../services/dealService';

vi.mock('../services/dealService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/dealService')>();
  return { ...orig, updateDealStatus: vi.fn(), dealLike: (d: unknown) => d };
});

const mockUpdate = vi.mocked(updateDealStatus);
const mockDerive = vi.mocked(computeJettonWalletAddress);

const TOKEN = 'b2c3d4e5'.repeat(4);

function tonDeal(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    asset: 'TON',
    amount: '10',
    fee_bps: 100,
    buyer_telegram_id: 111,
    seller_telegram_id: 222,
    payment_address: 'UQ_wallet',
    terms: '',
    deposit_token: TOKEN,
    buyer_expected_address: null,
    ...over,
  };
}

const PAY_ADDR = '0:' + '77'.repeat(32);

function usdtDeal(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    asset: 'USDT',
    amount: '100',
    fee_bps: 100,
    buyer_telegram_id: 111,
    seller_telegram_id: 222,
    // Must be TON-parseable: the master check derives the payment address's
    // jetton wallet from it (unparsable test strings skip the check).
    payment_address: PAY_ADDR,
    terms: '',
    deposit_token: TOKEN,
    buyer_expected_address: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue(true);
  mockDerive.mockResolvedValue(null);
});

describe('legacy memo hold on token-issued deals', () => {
  it('holds legacy escrow# memo without proven sender (no auto-confirm)', async () => {
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE id/.test(sql)) return Promise.resolve({ rowCount: 1, rows: [tonDeal()] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', null, 10_100_000_000n, 'hash_hold', 'escrow#7');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('confirms legacy memo when sender provably matches known expectation', async () => {
    const { Address } = await import('@ton/core');
    const buyer = Address.parse('0:' + '33'.repeat(32));
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE id/.test(sql))
        return Promise.resolve({ rowCount: 1, rows: [tonDeal({ buyer_expected_address: buyer.toString() })] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', buyer, 10_100_000_000n, 'hash_proven', 'escrow#7');
    expect(mockUpdate).toHaveBeenCalledWith(7, 'DEPOSIT_CONFIRMED', 'hash_proven', ['AWAITING_DEPOSIT']);
  });
});

describe('jetton master forgery defense', () => {
  it('rejects notification from unexpected jetton wallet (fake master)', async () => {
    const { Address } = await import('@ton/core');
    const realWallet = Address.parse('0:' + '55'.repeat(32));
    const fakeWallet = Address.parse('0:' + '66'.repeat(32));
    mockDerive.mockResolvedValue(realWallet);
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE deposit_token/.test(sql))
        return Promise.resolve({ rowCount: 1, rows: [usdtDeal()] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processJettonDeposit(
      PAY_ADDR,
      { queryId: 0n, amount: 101_000_000n, sender: null },
      TOKEN,
      'jhash_forge',
      fakeWallet.toString(),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('confirms notification from the derived jetton wallet', async () => {
    const { Address } = await import('@ton/core');
    const realWallet = Address.parse('0:' + '55'.repeat(32));
    mockDerive.mockResolvedValue(realWallet);
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE deposit_token/.test(sql))
        return Promise.resolve({ rowCount: 1, rows: [usdtDeal()] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processJettonDeposit(
      PAY_ADDR,
      { queryId: 0n, amount: 101_000_000n, sender: null },
      TOKEN,
      'jhash_ok',
      realWallet.toString(),
    );
    expect(mockUpdate).toHaveBeenCalledWith(9, 'DEPOSIT_CONFIRMED', 'jhash_ok', ['AWAITING_DEPOSIT']);
  });
});
