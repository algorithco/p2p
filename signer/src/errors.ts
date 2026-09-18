// AGPL-3.0 — maps signer-domain errors to HTTP statuses (pure, unit-tested).
// Keeps client errors (400/402/409) distinct from TON-network failures (502) and
// FloodWait backpressure (429) so the backend can decide retry vs fix-request.

export interface MappedError {
  status: number;
  error: string;
  retryAfter?: number;
}

export function mapSendError(msg: unknown): MappedError {
  const m = String((msg as Error)?.message ?? msg ?? '');

  if (/wallet_not_configured/.test(m)) return { status: 503, error: m };
  if (/already_deployed/.test(m)) return { status: 409, error: m };
  if (/idempotency_conflict/.test(m)) return { status: 409, error: m };
  if (/insufficient_balance/.test(m)) return { status: 402, error: m };

  if (
    /memo_required|memo_too_long|forward_comment_too_long|invalid_value|value must be > 0|invalid jetton amount|jetton amount must be|send_cap_exceeded|invalid_state_init_boc|invalid bodyBoc|empty batch|batch too large|requests array required|Cell overflow|cell overflow|invalid BOC|to and value required|invalid to address|invalid address/.test(
      m,
    )
  ) {
    return { status: 400, error: m };
  }

  const flood = m.match(/FLOOD_WAIT_(\d+)|FLOOD_PREMIUM_WAIT_(\d+)/i);
  if (flood) {
    const secs = parseInt(flood[1] || flood[2] || '30', 10);
    return { status: 429, error: m, retryAfter: secs };
  }

  if (
    /seqno_fetch_failed|jetton_wallet_resolve_failed|jetton_wallet_not_found|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(
      m,
    )
  ) {
    return { status: 502, error: m };
  }

  return { status: 500, error: m };
}
