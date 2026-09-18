// AGPL-3.0 — error→status mapping tests (client vs network failures must differ).
import { describe, it, expect } from 'vitest';
import { mapSendError } from './errors';

describe('mapSendError', () => {
  it('maps wallet/config states', () => {
    expect(mapSendError('wallet_not_configured: ...').status).toBe(503);
    expect(mapSendError('already_deployed').status).toBe(409);
    expect(mapSendError('idempotency_conflict: ...').status).toBe(409);
    expect(mapSendError('insufficient_balance: ...').status).toBe(402);
  });

  it('maps client input errors to 400 (were 500 before)', () => {
    for (const m of [
      'memo_required: ...',
      'memo_too_long',
      'forward_comment_too_long: ...',
      'invalid_value: cannot parse TON value "abc"',
      'value must be > 0',
      'invalid jetton amount: ...',
      'jetton amount must be > 0',
      'send_cap_exceeded: ...',
      'invalid_state_init_boc: ...',
      'invalid bodyBoc: ...',
      'empty batch',
      'batch too large (max 255)',
      'requests array required',
      'invalid to address',
    ]) {
      expect(mapSendError(m).status, m).toBe(400);
    }
  });

  it('maps TON-network failures to 502 (were 500 before)', () => {
    for (const m of [
      'seqno_fetch_failed: ...',
      'jetton_wallet_resolve_failed: ...',
      'jetton_wallet_not_found',
      'fetch failed',
      'socket hang up',
    ]) {
      expect(mapSendError(m).status, m).toBe(502);
    }
  });

  it('maps FloodWait to 429 with parsed retryAfter', () => {
    const r = mapSendError('FLOOD_WAIT_42: ...');
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe(42);
  });

  it('falls back to 500 for unknown errors', () => {
    expect(mapSendError('something totally new').status).toBe(500);
  });
});
