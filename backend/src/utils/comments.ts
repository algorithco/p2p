/**
 * Comment helpers for escrow deposits & releases.
 * - Buyer -> escrow: short machine-parseable comment for bot to detect the deal
 * - Escrow -> seller: human-readable comment for the seller to see what it's for
 */

import { Cell, Slice } from '@ton/core';

/** Generate unguessable per-deal deposit token (32 hex chars = 128 bits). */
export function generateDepositToken(): string {
  // Use Node crypto at call site to avoid top-level import cycle
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.randomBytes(16).toString('hex');
}

/** Detect whether a string looks like a deposit token (32-64 hex chars). */
export function isDepositTokenFormat(s: string): boolean {
  const t = String(s || '').trim();
  return /^[0-9a-fA-F]{32,64}$/.test(t);
}

/** Short, deterministic deposit comment for a deal. Buyer must include this when paying.
 * P0-1: new deals use unguessable deposit_token (return token directly); legacy deals still use escrow#<id>.
 * Keep backward compat: if token looks like a deposit token, return it; otherwise fall back to escrow#<id>.
 */
export function depositComment(dealId: number | string, depositToken?: string | null): string {
  if (depositToken && isDepositTokenFormat(String(depositToken).trim())) {
    return String(depositToken).trim().toLowerCase();
  }
  return `escrow#${dealId}`;
}

/** Extract deposit token from a comment if it looks like one. */
export function parseDepositToken(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const s = String(comment).trim().toLowerCase();
  // token may be bare 32 hex or prefixed with escrow#? handle both
  // If comment is exactly token
  if (isDepositTokenFormat(s)) return s;
  // If comment is escrow#<token> where token is hex
  const m = s.match(/^(?:escrow|deal)\s*[:#]\s*([0-9a-f]{32,64})\b/i);
  if (m && isDepositTokenFormat(m[1])) return m[1].toLowerCase();
  return null;
}

/** Try to extract deal id from a deposit comment. Strict: requires escrow/deal prefix.
 * Supports: escrow#123, escrow:123, escrow:deal#123, deal#123, Escrow #123.
 * Bare "#123" or "thanks for #123" no longer matches (fix 3.2) to avoid mis-attribution.
 */
export function parseDepositComment(comment: string | null | undefined): number | null {
  if (!comment) return null;
  const s = String(comment).trim();
  // Require escrow/deal literal + separator : or # (not optional) — prevents `thanks for #123 pizza` misparse
  const m = s.match(/(?:escrow|deal)\s*[:#]\s*(\d{1,10})\b/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** Human-readable release comment for seller. Example: `For Vintage Watch — 2.5 TON — Escrow #42` */
export function releaseComment(deal: {
  id: number | string;
  amount: string | number;
  asset: string;
  terms?: string | null;
}): string {
  const id = String(deal.id);
  const asset = String(deal.asset || 'TON').toUpperCase();
  const amt = String(deal.amount);
  const rawTerms = String(deal.terms || '').trim();

  let item: string;
  if (!rawTerms || rawTerms.toLowerCase() === 'no special terms') {
    item = 'deal';
  } else {
    // Take first line/sentence, strip trailing punctuation, limit to 40 chars
    const first = rawTerms
      .split(/[\n\r]+/)[0]
      .split(/[.]+/)[0]
      .trim();
    item =
      first
        .slice(0, 40)
        .replace(/[,;:]+$/, '')
        .trim() || 'deal';
    // If item is just a generic word like "deal", keep it lower, else capitalize first letter
    if (item.toLowerCase() === 'deal') item = 'deal';
  }

  // Keep comment under 120 chars (TON comment limit ~123)
  let comment = `For ${item} — ${amt} ${asset} — Escrow #${id}`;
  if (comment.length > 120) {
    // Truncate item part
    const overhead = `For  — ${amt} ${asset} — Escrow #${id}`.length;
    const maxItem = Math.max(10, 120 - overhead);
    const truncated = item.slice(0, maxItem - 1) + '…';
    comment = `For ${truncated} — ${amt} ${asset} — Escrow #${id}`;
  }
  return comment;
}

/** Parse a TON simple comment (op 0) from a body Cell. Returns null if not a comment. */
export function parseTonComment(body: Cell | Slice | null | undefined): string | null {
  if (!body) return null;
  try {
    const slice: Slice = body instanceof Cell ? body.beginParse() : body;
    if (slice.remainingBits < 32) return null;
    const op = slice.loadUint(32);
    if (op !== 0) return null;
    // Remaining bits are the comment string (may be empty)
    // Use loadStringTail if available, else manual
    if (slice.remainingBits === 0 && slice.remainingRefs === 0) return '';
    // @ton/core Slice has loadStringTail()
    const comment = (slice as unknown as { loadStringTail: () => string }).loadStringTail?.() ?? '';
    // Fallback: try to read as string tail manually
    if (typeof comment === 'string') return comment;
    // Manual fallback: read remaining bytes as utf8
    let s = '';
    while (slice.remainingBits >= 8) {
      s += String.fromCharCode(slice.loadUint(8));
    }
    return s;
  } catch {
    // best-effort: malformed on-chain comment parses as "no memo", never crashes the listener.
    return null;
  }
}

/** Parse jetton forward payload comment. The forwardPayload is the remaining slice after transfer_notification fields. */
export function parseJettonForwardComment(forwardPayload: Slice | Cell | null | undefined): string | null {
  if (!forwardPayload) return null;
  try {
    const slice: Slice = forwardPayload instanceof Cell ? forwardPayload.beginParse() : forwardPayload;
    if (slice.remainingBits === 0 && slice.remainingRefs === 0) return null;
    // Forward payload may be either a simple comment cell (op 0 + string) or empty
    // Try to parse as TON comment first
    const c = parseTonComment(slice);
    if (c !== null) return c;
    // If not op 0, it may be a raw string without op (some wallets)
    // Try to read as string tail
    if (slice.remainingBits >= 8) {
      try {
        return (slice as unknown as { loadStringTail: () => string }).loadStringTail?.() ?? null;
      } catch {
        // best-effort: raw tail unreadable — treat as no memo.
        return null;
      }
    }
    return null;
  } catch {
    // best-effort: malformed forward payload parses as "no memo", never crashes the listener.
    return null;
  }
}
