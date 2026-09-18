// AGPL-3.0 — tests for atomicJoinDeal SELECT FOR UPDATE race handling.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  db: { query: vi.fn(), connect: vi.fn() },
}));

import { db } from '../db/queries';
import { atomicJoinDeal } from './dealService';

const mockDb = vi.mocked(db);

beforeEach(() => vi.clearAllMocks());

/** Build a fake pg client whose query() answers in scripted order. */
function scriptedClient(script: Array<{ match: RegExp; rows: unknown[]; rowCount?: number }>) {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] });
    for (const step of script) {
      if (step.match.test(sql)) {
        // consume once
        script.splice(script.indexOf(step), 1);
        return Promise.resolve({ rowCount: step.rowCount ?? step.rows.length, rows: step.rows });
      }
    }
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  return { query, release: vi.fn() };
}

describe('atomicJoinDeal', () => {
  it('seller-created deal: joiner becomes buyer', async () => {
    const client = scriptedClient([
      {
        match: /FROM deals WHERE id.*FOR UPDATE/,
        rows: [{ buyer_telegram_id: null, seller_telegram_id: 111, status: 'AWAITING_DEPOSIT' }],
      },
      { match: /FROM deal_links WHERE token/, rows: [{ token: 'tok', deal_id: 1 }] },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    const role = await atomicJoinDeal(1, 'tok', 222);
    expect(role).toBe('buyer');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM deal_links'), expect.anything());
  });

  it('buyer-created deal: joiner becomes seller', async () => {
    const client = scriptedClient([
      {
        match: /FROM deals WHERE id/,
        rows: [{ buyer_telegram_id: 111, seller_telegram_id: null, status: 'AWAITING_DEPOSIT' }],
      },
      { match: /FROM deal_links WHERE token/, rows: [{ token: 'tok', deal_id: 1 }] },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    expect(await atomicJoinDeal(1, 'tok', 222)).toBe('seller');
  });

  it('second concurrent join sees full deal (deal_already_full)', async () => {
    const client = scriptedClient([
      {
        match: /FROM deals WHERE id/,
        rows: [{ buyer_telegram_id: 111, seller_telegram_id: 333, status: 'AWAITING_DEPOSIT' }],
      },
      { match: /FROM deal_links WHERE token/, rows: [{ token: 'tok', deal_id: 1 }] },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(atomicJoinDeal(1, 'tok', 222)).rejects.toThrow(/deal_already_full/);
  });

  it('cannot join finished/locked deals', async () => {
    for (const status of ['RELEASED', 'REFUNDED', 'RELEASE_PENDING', 'REFUND_PENDING']) {
      const client = scriptedClient([
        { match: /FROM deals WHERE id/, rows: [{ buyer_telegram_id: null, seller_telegram_id: 111, status }] },
      ]);
      mockDb.connect.mockResolvedValue(client as never);
      await expect(atomicJoinDeal(1, 'tok', 222)).rejects.toThrow(/deal_finished/);
    }
  });

  it('same party re-joining is rejected', async () => {
    const client = scriptedClient([
      {
        match: /FROM deals WHERE id/,
        rows: [{ buyer_telegram_id: 222, seller_telegram_id: null, status: 'AWAITING_DEPOSIT' }],
      },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(atomicJoinDeal(1, 'tok', 222)).rejects.toThrow(/already_party/);
  });

  it('expired/consumed link is rejected (invalid_token)', async () => {
    const client = scriptedClient([
      {
        match: /FROM deals WHERE id/,
        rows: [{ buyer_telegram_id: null, seller_telegram_id: 111, status: 'AWAITING_DEPOSIT' }],
      },
      { match: /FROM deal_links WHERE token/, rows: [] },
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(atomicJoinDeal(1, 'tok', 222)).rejects.toThrow(/invalid_token/);
  });

  it('rolls back and releases client on failure', async () => {
    const client = scriptedClient([
      { match: /FROM deals WHERE id/, rows: [] }, // deal_not_found
    ]);
    mockDb.connect.mockResolvedValue(client as never);
    await expect(atomicJoinDeal(999, 'tok', 222)).rejects.toThrow(/deal_not_found/);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
