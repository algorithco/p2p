import { describe, it, expect } from 'vitest';
import { DEAL_STATUS } from './dealService';
import { DEAL_ACTIONS, assertTransition } from './dealTransitions';
import { isValidTransition } from './escrowService';

describe('P1-3 transition consistency — single source of truth', () => {
  const cases: Array<{ from: string; next: string; action: (typeof DEAL_ACTIONS)[keyof typeof DEAL_ACTIONS] }> = [
    { from: DEAL_STATUS.AWAITING_DEPOSIT, next: DEAL_STATUS.DEPOSIT_CONFIRMED, action: DEAL_ACTIONS.DEPOSIT_DETECTED },
    { from: DEAL_STATUS.DEPOSIT_CONFIRMED, next: DEAL_STATUS.ITEM_SENT, action: DEAL_ACTIONS.MARK_SHIPPED },
    { from: DEAL_STATUS.ITEM_SENT, next: DEAL_STATUS.RELEASED, action: DEAL_ACTIONS.CONFIRM_RECEIPT },
    { from: DEAL_STATUS.DEPOSIT_CONFIRMED, next: DEAL_STATUS.RELEASED, action: DEAL_ACTIONS.RELEASE },
    { from: DEAL_STATUS.ITEM_SENT, next: DEAL_STATUS.RELEASED, action: DEAL_ACTIONS.RELEASE },
    { from: DEAL_STATUS.AWAITING_DEPOSIT, next: DEAL_STATUS.REFUNDED, action: DEAL_ACTIONS.EXPIRE },
    { from: DEAL_STATUS.DEPOSIT_CONFIRMED, next: DEAL_STATUS.REFUNDED, action: DEAL_ACTIONS.REFUND },
    { from: DEAL_STATUS.RELEASED, next: DEAL_STATUS.CLOSED, action: DEAL_ACTIONS.CLOSE },
  ];

  it('assertTransition and isValidTransition agree for RELEASE/REFUND', () => {
    for (const from of ['AWAITING_DEPOSIT', 'DEPOSIT_CONFIRMED', 'ITEM_SENT', 'RELEASED', 'REFUNDED']) {
      const viaTransitionRefund = assertTransition(from, DEAL_ACTIONS.REFUND).ok;
      const viaIsValidRefund = isValidTransition(from, DEAL_STATUS.REFUNDED);
      expect(viaIsValidRefund).toBe(viaTransitionRefund);

      const viaTransitionRelease = assertTransition(from, DEAL_ACTIONS.RELEASE).ok;
      const viaIsValidRelease = isValidTransition(from, DEAL_STATUS.RELEASED);
      expect(viaIsValidRelease).toBe(viaTransitionRelease);
    }
    // Legacy BUYER_CONFIRMED must NOT be valid as source for new writes (P2-8)
    expect(assertTransition('BUYER_CONFIRMED', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(isValidTransition('BUYER_CONFIRMED', DEAL_STATUS.RELEASED)).toBe(false);
  });

  it('every action via assertTransition produces same result regardless of caller path', () => {
    for (const { from, action } of cases) {
      const r = assertTransition(from, action);
      expect(r.ok).toBe(true);
    }
    // Invalid combos must be false everywhere
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.RELEASE).ok).toBe(false);
    expect(isValidTransition('AWAITING_DEPOSIT', DEAL_STATUS.RELEASED)).toBe(false);
    expect(assertTransition('AWAITING_DEPOSIT', DEAL_ACTIONS.REFUND).ok).toBe(false);
    expect(isValidTransition('AWAITING_DEPOSIT', DEAL_STATUS.REFUNDED)).toBe(false);
  });
});
