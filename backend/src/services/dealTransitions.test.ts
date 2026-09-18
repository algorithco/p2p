// AGPL-3.0 — unit tests for the Deal state machine.
// Resolves the dangling reference in dealTransitions.ts:14.
// NOTE: dealTransitions.ts is currently NOT wired into the payout path
// (see PLAN.md / SECURITY_FIXES.md — imported by nothing). These tests lock
// the intended transition table so a future P4 wiring refactor is verifiable
// and cannot silently widen/narrow allowed transitions.
import { describe, it, expect, vi } from 'vitest';
import { DEAL_ACTIONS, TRANSITION_TABLE, NEXT_STATUS, assertTransition, guardedStatusUpdate } from './dealTransitions';
import { DEAL_STATUS } from './dealService';

describe('TRANSITION_TABLE shape', () => {
  it('covers every action with a next status', () => {
    for (const k of Object.values(DEAL_ACTIONS)) {
      expect(TRANSITION_TABLE[k]).toBeDefined();
      expect(NEXT_STATUS[k]).toBeDefined();
    }
  });

  it('never lands in a transient PENDING state via this table', () => {
    for (const next of Object.values(NEXT_STATUS)) {
      expect(next).not.toBe(DEAL_STATUS.RELEASE_PENDING);
      expect(next).not.toBe(DEAL_STATUS.REFUND_PENDING);
    }
  });
});

describe('assertTransition', () => {
  it('allows DEPOSIT_DETECTED only from AWAITING_DEPOSIT', () => {
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.DEPOSIT_DETECTED)).toEqual({
      ok: true,
      next: 'DEPOSIT_CONFIRMED',
    });
    const bad = assertTransition('DEPOSIT_CONFIRMED', DEAL_ACTIONS.DEPOSIT_DETECTED);
    expect(bad.ok).toBe(false);
  });

  it('allows MARK_SHIPPED only from DEPOSIT_CONFIRMED', () => {
    expect(assertTransition('DEPOSIT_CONFIRMED', DEAL_ACTIONS.MARK_SHIPPED).ok).toBe(true);
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.MARK_SHIPPED).ok).toBe(false);
    expect(assertTransition('ITEM_SENT', DEAL_ACTIONS.MARK_SHIPPED).ok).toBe(false);
  });

  it('allows CONFIRM_RECEIPT only from ITEM_SENT', () => {
    expect(assertTransition('ITEM_SENT', DEAL_ACTIONS.CONFIRM_RECEIPT)).toEqual({
      ok: true,
      next: 'RELEASED',
    });
    expect(assertTransition('DEPOSIT_CONFIRMED', DEAL_ACTIONS.CONFIRM_RECEIPT).ok).toBe(false);
  });

  it('RELEASE allowed from CONFIRMED/ITEM_SENT (P2-8 BUYER_CONFIRMED removed)', () => {
    for (const from of ['DEPOSIT_CONFIRMED', 'ITEM_SENT']) {
      const r = assertTransition(from, DEAL_ACTIONS.RELEASE);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.next).toBe('RELEASED');
    }
    expect(assertTransition('BUYER_CONFIRMED', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(assertTransition('RELEASED', DEAL_ACTIONS.RELEASE).ok).toBe(false);
  });

  it('REFUND allowed only from CONFIRMED/ITEM_SENT, never from AWAITING_DEPOSIT or final (P1-3 strict, P2-8)', () => {
    for (const from of ['DEPOSIT_CONFIRMED', 'ITEM_SENT']) {
      expect(assertTransition(from, DEAL_ACTIONS.REFUND).ok).toBe(true);
    }
    expect(assertTransition('BUYER_CONFIRMED', DEAL_ACTIONS.REFUND).ok).toBe(false);
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.REFUND).ok).toBe(false);
    expect(assertTransition('RELEASED', DEAL_ACTIONS.REFUND).ok).toBe(false);
    expect(assertTransition('REFUNDED', DEAL_ACTIONS.REFUND).ok).toBe(false);
  });

  it('EXPIRE allowed only from AWAITING_DEPOSIT', () => {
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.EXPIRE)).toEqual({
      ok: true,
      next: 'REFUNDED',
    });
    expect(assertTransition('DEPOSIT_CONFIRMED', DEAL_ACTIONS.EXPIRE).ok).toBe(false);
  });

  it('rejects unknown actions and empty status', () => {
    expect(assertTransition('AWAITING_DEPOSIT', 'BOGUS' as never).ok).toBe(false);
    expect(assertTransition('', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(assertTransition(null, DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(assertTransition(undefined, DEAL_ACTIONS.RELEASE).ok).toBe(false);
  });
});

describe('guardedStatusUpdate', () => {
  it('writes status + updated_at with guarded WHERE id+status', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const n = await guardedStatusUpdate({ query } as never, 42, 'AWAITING_DEPOSIT', 'DEPOSIT_CONFIRMED');
    expect(n).toBe(1);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('UPDATE deals SET');
    expect(sql).toContain('WHERE id =');
    expect(params).toContain(42);
    expect(params).toContain('AWAITING_DEPOSIT');
    expect(params).toContain('DEPOSIT_CONFIRMED');
  });

  it('returns 0 when concurrent transition moved the row (caller must treat as conflict)', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    const n = await guardedStatusUpdate({ query } as never, 7, 'ITEM_SENT', 'RELEASED');
    expect(n).toBe(0);
  });

  it('appends extraSets/extraParams for payout markers', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await guardedStatusUpdate({ query } as never, 9, 'ITEM_SENT', 'RELEASE_PENDING', ['payout_idempotency_key = $9']);
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('payout_idempotency_key');
  });
});
