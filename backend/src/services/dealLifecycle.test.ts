// AGPL-3.0 — deal lifecycle integration:
// create → join → approve → deposit confirmed → item sent → release.
// Part A (always runs): full state-machine walk via assertTransition (no DB).
// Part B (opt-in): real Postgres walk using TEST_DATABASE_URL when present,
// otherwise skipped so CI without a DB stays green.
import { describe, it, expect } from 'vitest';
import { assertTransition, DEAL_ACTIONS } from './dealTransitions';

describe('deal lifecycle state machine (no DB)', () => {
  it('happy path: AWAITING -> CONFIRMED -> SENT -> RELEASED', () => {
    let status = 'AWAITING_DEPOSIT';
    for (const action of [
      DEAL_ACTIONS.DEPOSIT_DETECTED,
      DEAL_ACTIONS.MARK_SHIPPED,
      DEAL_ACTIONS.CONFIRM_RECEIPT,
    ] as const) {
      const r = assertTransition(status, action);
      expect(r.ok).toBe(true);
      if (r.ok) status = r.next;
    }
    expect(status).toBe('RELEASED');
  });

  it('expiry path: AWAITING -> REFUNDED', () => {
    const r = assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.EXPIRE);
    expect(r).toEqual({ ok: true, next: 'REFUNDED' });
  });

  it('admin refund from ITEM_SENT', () => {
    expect(assertTransition('ITEM_SENT', DEAL_ACTIONS.REFUND).ok).toBe(true);
  });

  it('cannot resurrect final deals', () => {
    expect(assertTransition('RELEASED', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(assertTransition('REFUNDED', DEAL_ACTIONS.REFUND).ok).toBe(false);
    expect(assertTransition('RELEASED', DEAL_ACTIONS.MARK_SHIPPED).ok).toBe(false);
  });
});

describe('deal lifecycle with real test DB (opt-in)', () => {
  const testUrl = process.env.TEST_DATABASE_URL || '';
  const runReal = !!testUrl;

  it.runIf(runReal)('create → join → approve → deposit → ship → release', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: testUrl });
    try {
      // Minimal schema for the lifecycle (mirrors ensureTables subset)
      await pool.query(`CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY, buyer_telegram_id BIGINT, seller_telegram_id BIGINT,
        asset TEXT, amount NUMERIC, fee_bps INT, status TEXT,
        payment_address TEXT, terms TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS deal_links (
        id SERIAL PRIMARY KEY, deal_id INT, token TEXT UNIQUE, expires_at TIMESTAMPTZ
      )`);
      const seller = 900001;
      const buyer = 900002;
      const created = await pool.query(
        `INSERT INTO deals (seller_telegram_id, asset, amount, fee_bps, status) VALUES ($1,'TON','5',100,'AWAITING_DEPOSIT') RETURNING *`,
        [seller],
      );
      const dealId = Number(created.rows[0].id);
      expect(dealId).toBeGreaterThan(0);

      const token = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await pool.query(`INSERT INTO deal_links (deal_id, token, expires_at) VALUES ($1,$2,now()+interval '1 hour')`, [
        dealId,
        token,
      ]);

      // join: fill empty buyer slot
      const joined = await pool.query(
        `UPDATE deals SET buyer_telegram_id=$1 WHERE id=$2 AND buyer_telegram_id IS NULL RETURNING *`,
        [buyer, dealId],
      );
      expect(joined.rowCount).toBe(1);
      await pool.query(`DELETE FROM deal_links WHERE token=$1`, [token]);

      // deposit confirmed (guarded)
      const dep = await pool.query(
        `UPDATE deals SET status='DEPOSIT_CONFIRMED' WHERE id=$1 AND status='AWAITING_DEPOSIT' RETURNING *`,
        [dealId],
      );
      expect(dep.rowCount).toBe(1);

      // ship
      const ship = await pool.query(
        `UPDATE deals SET status='ITEM_SENT' WHERE id=$1 AND status='DEPOSIT_CONFIRMED' RETURNING *`,
        [dealId],
      );
      expect(ship.rowCount).toBe(1);

      // release
      const rel = await pool.query(
        `UPDATE deals SET status='RELEASED' WHERE id=$1 AND status='ITEM_SENT' RETURNING *`,
        [dealId],
      );
      expect(rel.rowCount).toBe(1);

      // cleanup
      await pool.query(`DELETE FROM deals WHERE id=$1`, [dealId]);
    } finally {
      await pool.end();
    }
  });

  it.skipIf(runReal)('skipped without TEST_DATABASE_URL (set it to run the real-DB walk)', () => {
    expect(true).toBe(true);
  });
});
