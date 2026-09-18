// services/dealTransitions.ts
//
// THE Deal state machine — one module, one transition table.
//
// This is the single owner of "what may a Deal become, and from where".
// Everything that moves a Deal (HTTP routes, bot commands, the on-chain
// listener, the 10h expiry scheduler) goes through assertTransition() before
// touching the DB, and through guardedStatusUpdate() to write it. That
// closes the race where the auto-close scheduler used to call the
// unguarded updateDealStatus() and could refund a deal an admin had just
// released.
//
// Pure module: no DB imports at the top level, so it is unit-testable
// without Postgres (see ./dealTransitions.test.ts).
import { DEAL_STATUS } from './dealService';

export const DEAL_ACTIONS = {
  /** On-chain deposit detected by the listener. */
  DEPOSIT_DETECTED: 'DEPOSIT_DETECTED',
  /** Seller signals the item/session/channel hand-off happened. */
  MARK_SHIPPED: 'MARK_SHIPPED',
  /** Buyer confirms receipt → money goes to the seller. */
  CONFIRM_RECEIPT: 'CONFIRM_RECEIPT',
  /** Admin release (escrow → seller). */
  RELEASE: 'RELEASE',
  /** Admin refund (escrow → buyer). */
  REFUND: 'REFUND',
  /** 10h auto-close of a deal with no deposit (record kept on server, shown as closed). */
  EXPIRE: 'EXPIRE',
} as const;

export type DealAction = (typeof DEAL_ACTIONS)[keyof typeof DEAL_ACTIONS];

/**
 * Allowed transitions. Each action maps to the set of statuses it may LEAVE.
 * The resulting status is derived from the action (single next-state per action).
 */
export const TRANSITION_TABLE: Record<DealAction, ReadonlyArray<string>> = {
  [DEAL_ACTIONS.DEPOSIT_DETECTED]: [DEAL_STATUS.AWAITING_DEPOSIT],
  [DEAL_ACTIONS.MARK_SHIPPED]: [DEAL_STATUS.DEPOSIT_CONFIRMED],
  [DEAL_ACTIONS.CONFIRM_RECEIPT]: [DEAL_STATUS.ITEM_SENT],
  // P2-8: BUYER_CONFIRMED removed — dead state no longer produced, kept only for legacy row tolerance in DB but not as valid transition source.
  [DEAL_ACTIONS.RELEASE]: [DEAL_STATUS.DEPOSIT_CONFIRMED, DEAL_STATUS.ITEM_SENT],
  // REFUND with money movement must NOT be from AWAITING_DEPOSIT (no funds to return on-chain).
  // Use EXPIRE for DB-only close of AWAITING_DEPOSIT (no on-chain leg). Strict consolidation P1-3.
  [DEAL_ACTIONS.REFUND]: [DEAL_STATUS.DEPOSIT_CONFIRMED, DEAL_STATUS.ITEM_SENT],
  [DEAL_ACTIONS.EXPIRE]: [DEAL_STATUS.AWAITING_DEPOSIT],
};

/** The status a Deal lands on once an action succeeds. */
export const NEXT_STATUS: Record<DealAction, string> = {
  [DEAL_ACTIONS.DEPOSIT_DETECTED]: DEAL_STATUS.DEPOSIT_CONFIRMED,
  [DEAL_ACTIONS.MARK_SHIPPED]: DEAL_STATUS.ITEM_SENT,
  [DEAL_ACTIONS.CONFIRM_RECEIPT]: DEAL_STATUS.RELEASED,
  [DEAL_ACTIONS.RELEASE]: DEAL_STATUS.RELEASED,
  [DEAL_ACTIONS.REFUND]: DEAL_STATUS.REFUNDED,
  [DEAL_ACTIONS.EXPIRE]: DEAL_STATUS.REFUNDED,
};

/** Pure guard: is `action` legal from `currentStatus`? Returns the next status or an error. */
export function assertTransition(
  currentStatus: string | null | undefined,
  action: DealAction,
): { ok: true; next: string } | { ok: false; error: string; from: string } {
  const from = String(currentStatus || '');
  const allowed = TRANSITION_TABLE[action];
  if (!allowed) return { ok: false, error: `unknown_action`, from };
  if (!allowed.includes(from)) {
    return {
      ok: false,
      error: `invalid_transition: ${from} -> ${action} (allowed from: ${allowed.join(', ')})`,
      from,
    };
  }
  return { ok: true, next: NEXT_STATUS[action] as string };
}

/**
 * Optimistic guarded status write. Returns rowCount so callers can detect a
 * concurrent transition (0 rows = the row moved while we were deciding).
 */
export function guardedStatusUpdate(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> },
  dealId: number,
  fromStatus: string,
  nextStatus: string,
  extraSets?: string[],
  extraParams?: unknown[],
): Promise<number> {
  const sets: string[] = ['status = $1', 'updated_at = now()'];
  const params: unknown[] = [nextStatus];
  if (extraSets) {
    for (const s of extraSets) {
      sets.push(s);
    }
  }
  if (extraParams) params.push(...extraParams);
  params.push(dealId, fromStatus);
  return client
    .query(
      `UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND status = $${params.length}`,
      params,
    )
    .then((r) => r.rowCount);
}
