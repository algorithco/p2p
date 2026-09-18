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

import { db } from '../db/queries';
import { processTonDeposit } from './listener';
import { updateDealStatus } from '../services/dealService';

vi.mock('../services/dealService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/dealService')>();
  return { ...orig, updateDealStatus: vi.fn(), dealLike: (d: unknown) => d };
});

const mockUpdate = vi.mocked(updateDealStatus);

describe('P0-1 deposit token attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue(true);
  });

  it('token-based deposit confirms via deposit_token lookup', async () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    vi.mocked(db.query).mockImplementation((sql: string, params?: unknown[]) => {
      if (/FROM deals WHERE deposit_token/.test(sql)) {
        expect(params?.[0]).toBe(token);
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 10,
              asset: 'TON',
              amount: '10',
              fee_bps: 100,
              buyer_telegram_id: 1,
              seller_telegram_id: 2,
              payment_address: 'UQ_wallet',
              terms: '',
              deposit_token: token,
              buyer_expected_address: null,
            },
          ],
        } as never);
      }
      if (/FROM users WHERE telegram_id/.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', null, 10_100_000_000n, 'hash_tok', token);
    expect(mockUpdate).toHaveBeenCalledWith(10, 'DEPOSIT_CONFIRMED', 'hash_tok', ['AWAITING_DEPOSIT']);
  });

  it('legacy escrow#<id> still works (backward compat)', async () => {
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE id/.test(sql))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 7,
              asset: 'TON',
              amount: '10',
              fee_bps: 100,
              buyer_telegram_id: 1,
              seller_telegram_id: 2,
              payment_address: 'UQ_wallet',
              terms: '',
              deposit_token: 'someoldtoken',
              buyer_expected_address: null,
            },
          ],
        } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', null, 10_100_000_000n, 'hash_legacy', 'escrow#7');
    expect(mockUpdate).toHaveBeenCalledWith(7, 'DEPOSIT_CONFIRMED', 'hash_legacy', ['AWAITING_DEPOSIT']);
  });

  it('unknown token does not confirm', async () => {
    const token = 'ffffffffffffffffffffffffffffffff';
    vi.mocked(db.query).mockImplementation((sql: string) => {
      if (/FROM deals WHERE deposit_token/.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', null, 10_100_000_000n, 'hash_unknown', token);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sender mismatch does NOT auto-confirm (flagged for manual review)', async () => {
    const token = '11112222333344445555666677778888';
    const { Address } = await import('@ton/core');
    // Use valid TON addresses: buyer expected vs attacker sender (raw format avoids checksum issues)
    const buyerAddr = Address.parse('0:' + '11'.repeat(32)).toString({ urlSafe: true, bounceable: false });
    const attackerAddr = Address.parse('0:' + '22'.repeat(32));
    vi.mocked(db.query).mockImplementation((sql: string, _params?: unknown[]) => {
      if (/FROM deals WHERE deposit_token/.test(sql))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 20,
              asset: 'TON',
              amount: '5',
              fee_bps: 100,
              buyer_telegram_id: 999,
              seller_telegram_id: 2,
              payment_address: 'UQ_wallet',
              terms: '',
              deposit_token: token,
              buyer_expected_address: buyerAddr,
            },
          ],
        } as never);
      if (/FROM users WHERE telegram_id/.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', attackerAddr, 5_050_000_000n, 'hash_mismatch', token);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sender match allows confirm', async () => {
    const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { Address } = await import('@ton/core');
    const buyerAddr = Address.parse('0:' + '33'.repeat(32)).toString({ urlSafe: true, bounceable: false });
    const src = Address.parse(buyerAddr);
    vi.mocked(db.query).mockImplementation((sql: string, _args?: unknown[]) => {
      if (/FROM deals WHERE deposit_token/.test(sql))
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              id: 21,
              asset: 'TON',
              amount: '5',
              fee_bps: 100,
              buyer_telegram_id: 1,
              seller_telegram_id: 2,
              payment_address: 'UQ_wallet',
              terms: '',
              deposit_token: token,
              buyer_expected_address: buyerAddr,
            },
          ],
        } as never);
      if (/FROM users WHERE telegram_id/.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] } as never);
      return Promise.resolve({ rowCount: 0, rows: [] } as never);
    });
    await processTonDeposit('UQ_wallet', src, 5_050_000_000n, 'hash_match', token);
    expect(mockUpdate).toHaveBeenCalledWith(21, 'DEPOSIT_CONFIRMED', 'hash_match', ['AWAITING_DEPOSIT']);
  });
});
