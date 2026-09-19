// src/services/dealService.ts
import { db } from '../db/queries';
import { v4 as uuidv4 } from 'uuid';
import { QueryResult } from 'pg';
import { generateDealChatKey, encryptDealKey, decryptDealKey, encryptWithDealKey } from '../utils/encryption';
import { dealPricing, fromBaseUnits } from '../utils/money';

/** Canonical deal status strings.
 * RELEASE_PENDING / REFUND_PENDING are transient crash-safety states owned by the
 * payout path (see escrowService guardedTransition): a deal sits in PENDING only
 * between "payout attempt committed" and "on-chain send confirmed". They are never
 * final and never auto-retried — see reconcileStuckPayouts. Clients must treat any
 * unknown non-final status as "in progress".
 * CLOSED is the archival state: a RELEASED deal moves here ~5 min after the seller
 * payout finalizes (success-close scheduler in index.ts). CLOSED inherits every
 * post-success read/continue right of RELEASED (channel set-new-owner /
 * transfer-to-buyer, fee retry) — it only locks mutating pre-success actions.
 */
export const DEAL_STATUS = {
  AWAITING_DEPOSIT: 'AWAITING_DEPOSIT',
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
  ITEM_SENT: 'ITEM_SENT',
  BUYER_CONFIRMED: 'BUYER_CONFIRMED',
  RELEASE_PENDING: 'RELEASE_PENDING',
  REFUND_PENDING: 'REFUND_PENDING',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
  CLOSED: 'CLOSED',
} as const;

export const DEAL_TYPE = {
  P2P: 'P2P',
  CHANNEL: 'CHANNEL',
  GROUP: 'GROUP',
} as const;

const FINAL_STATUSES = new Set<string>([DEAL_STATUS.RELEASED, DEAL_STATUS.REFUNDED, DEAL_STATUS.CLOSED]);

/** Shape used by every Telegram notification helper (single source of truth). */
export function dealLike(deal: {
  id: number | string;
  amount: string | number | null;
  asset: string | null;
  terms?: string | null;
}): {
  id: number | string;
  amount: string | number;
  asset: string;
  terms?: string;
} {
  return {
    id: deal.id,
    amount: deal.amount != null ? String(deal.amount) : '0',
    asset: String(deal.asset ?? 'TON'),
    terms: deal.terms ?? undefined,
  };
}

/** True when the deal was flagged as disputed (confirmations JSONB). */
export function isDisputedDeal(d: { confirmations?: Record<string, unknown> | string | null }): boolean {
  try {
    let c: Record<string, unknown> | null = null;
    if (typeof d.confirmations === 'string' && d.confirmations) {
      c = JSON.parse(d.confirmations);
    } else if (d.confirmations && typeof d.confirmations === 'object') {
      c = d.confirmations as Record<string, unknown>;
    }
    return !!(c && (c as { disputed?: unknown }).disputed === true);
  } catch {
    // best-effort: unparsable confirmations JSON counts as "not disputed" (fail-open
    // would freeze deals; fail-closed here only skips the dispute badge, schedulers
    // still skip via the same helper consistently).
    return false;
  }
}

export function normalizeChannelUsername(v: unknown): string | null {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@/, '')
    .trim();
  s = s.split('/')[0].split('?')[0].trim();
  if (!s) return null;
  if (!/^[@A-Za-z0-9_]{1,64}$/.test(s.startsWith('@') ? s : `@${s}`)) return null;
  return s.startsWith('@') ? s : `@${s}`;
}

/** Create a new deal record with optional role telegram IDs.
 * NOTE: buyerId/sellerId (deals.buyer_id/seller_id) are DEPRECATED write-only columns —
 * ownership is buyer/seller_telegram_id. They are still written for backward-compat
 * (additive, harmless) but nothing reads them; do not add new readers.
 */
export async function createDealRecord(params: {
  buyerId?: number | null;
  sellerId?: number | null;
  buyerTelegramId?: number | null;
  sellerTelegramId?: number | null;
  asset: string;
  amount: number | string;
  feeBps: number;
  status: string;
  contractAddress?: string;
  paymentAddress?: string;
  terms?: string;
  deadline?: Date | null;
  dealType?: string; // P2P | CHANNEL | GROUP
  channelUsername?: string | null;
  channelId?: string | null;
  channelTitle?: string | null;
  channelSnapshot?: Record<string, unknown> | null;
  escrowHolderId?: number | null;
  depositToken?: string | null;
  buyerExpectedAddress?: string | null;
}) {
  // P2-9: legacy buyerId/sellerId params intentionally ignored (never read, stored NULL).
  const {
    buyerTelegramId = null,
    sellerTelegramId = null,
    asset,
    amount,
    feeBps,
    status,
    contractAddress = '',
    paymentAddress = '',
    terms = '',
    deadline = null,
    dealType = DEAL_TYPE.P2P,
    channelUsername = null,
    channelId = null,
    channelTitle = null,
    channelSnapshot = null,
    escrowHolderId = null,
    depositToken: suppliedToken = null,
    buyerExpectedAddress: suppliedBuyerAddr = null,
  } = params;

  const normalizedType = ['P2P', 'CHANNEL', 'GROUP'].includes(String(dealType).toUpperCase())
    ? String(dealType).toUpperCase()
    : DEAL_TYPE.P2P;
  // Single source for fee + expected-deposit math (see utils/money.dealPricing).
  const assetUpper = String(asset || 'TON').toUpperCase();
  const feeBase = dealPricing(amount, assetUpper, feeBps).feeBase;
  const feeAmount = Number(fromBaseUnits(feeBase, assetUpper));

  // Generate per-deal E2E chat key (32 bytes base64, encrypted at rest if ENCRYPTION_KEY set)
  const chatKeyPlain = generateDealChatKey();
  const chatKeyStored = encryptDealKey(chatKeyPlain);

  // P0-1: unguessable deposit memo token
  let depositToken = suppliedToken ? String(suppliedToken).trim().toLowerCase() : null;
  if (!depositToken) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as typeof import('node:crypto');
    depositToken = crypto.randomBytes(16).toString('hex');
  }

  const buyerExpectedAddress = suppliedBuyerAddr ? String(suppliedBuyerAddr).trim() : null;

  // P2-9: stop writing legacy buyer_id/seller_id (never read) — store NULL
  const res: QueryResult = await db.query(
    `INSERT INTO deals (
        buyer_id,
        seller_id,
        buyer_telegram_id,
        seller_telegram_id,
        asset,
        amount,
        fee_bps,
        fee_amount,
        status,
        contract_address,
        payment_address,
        terms,
        deadline,
        chat_key,
        chat_key_created_at,
        created_at,
        deal_type,
        channel_username,
        channel_id,
        channel_title,
        channel_snapshot,
        channel_verified,
        escrow_holder_id,
        deposit_token,
        buyer_expected_address
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now(),$15,$16,$17,$18,$19::jsonb,false,$20,$21,$22) RETURNING *`,
    [
      null,
      null,
      buyerTelegramId,
      sellerTelegramId,
      asset,
      amount,
      feeBps,
      feeAmount,
      status,
      contractAddress,
      paymentAddress,
      terms,
      deadline,
      chatKeyStored,
      normalizedType,
      channelUsername,
      channelId,
      channelTitle,
      channelSnapshot ? JSON.stringify(channelSnapshot) : '{}',
      escrowHolderId,
      depositToken,
      buyerExpectedAddress,
    ],
  );
  return res.rows[0];
}

export async function getDealById(id: number | string) {
  const res = await db.query('SELECT * FROM deals WHERE id = $1 LIMIT 1', [Number(id)]);
  return res.rows[0] || null;
}

/** Get plaintext per-deal chat key (only for parties/admin). Returns null if not found.
 * Backfill path is atomic: the row is locked with SELECT ... FOR UPDATE (same pattern
 * as atomicJoinDeal) so two concurrent first-time chat opens cannot generate two
 * different keys where only one wins in storage while the other party's client
 * caches the losing one.
 */
export async function getDealChatKey(dealId: number | string): Promise<string | null> {
  const id = Number(dealId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT chat_key FROM deals WHERE id = $1 FOR UPDATE', [id]);
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const stored = locked.rows[0].chat_key as string | null;
    if (stored) {
      await client.query('COMMIT');
      return decryptDealKey(String(stored));
    }
    // Backfill: generate & persist if missing (legacy deals) — still under the lock.
    const newKey = generateDealChatKey();
    const enc = encryptDealKey(newKey);
    await client.query(
      'UPDATE deals SET chat_key = $1, chat_key_created_at = now(), updated_at = now() WHERE id = $2',
      [enc, id],
    );
    await client.query('COMMIT');
    return newKey;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {} // best-effort: already handling a failure; a rollback error must not mask it.
    throw e;
  } finally {
    client.release();
  }
}

/** Ensure a deal has a chat_key, return plaintext. */
export async function ensureDealChatKey(dealId: number | string): Promise<string> {
  const k = await getDealChatKey(dealId);
  if (!k) throw new Error('chat_key_unavailable');
  return k;
}

/** Update deal status; writes tx_hash when provided and stamps resolved_at on final statuses.
 *  When `onlyFrom` is given, the write is guarded: it only applies if the current
 *  status is one of `onlyFrom` (prevents resurrecting RELEASED/REFUNDED deals).
 *  Returns true if a row was updated. */
export async function updateDealStatus(
  dealId: number | string,
  status: string,
  txHash?: string,
  onlyFrom?: string[],
): Promise<boolean> {
  const id = Number(dealId);
  const sets: string[] = ['status = $1'];
  const params: unknown[] = [status];
  if (txHash) {
    params.push(txHash);
    sets.push(`tx_hash = $${params.length}`);
  }
  if (FINAL_STATUSES.has(status)) {
    sets.push('resolved_at = now()');
  }
  sets.push('updated_at = now()');
  params.push(id);
  let sql = `UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}`;
  if (onlyFrom && onlyFrom.length > 0) {
    params.push(onlyFrom);
    sql += ` AND status = ANY($${params.length}::text[])`;
  }
  const res = await db.query(sql, params);
  return (res.rowCount ?? 0) > 0;
}

/** Generate a one-time link token for a deal */
export async function generateDealLink(dealId: number, ttlSeconds: number = 86400) {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.query(`INSERT INTO deal_links (deal_id, token, expires_at) VALUES ($1,$2,$3)`, [dealId, token, expiresAt]);
  return token;
}

/** Validate a deal link and return the associated unexpired deal (or null). */
export async function validateDealLink(token: string) {
  const res = await db.query(
    `SELECT d.* FROM deal_links dl JOIN deals d ON dl.deal_id = d.id
     WHERE dl.token = $1 AND dl.expires_at > now()`,
    [token],
  );
  return res.rows[0] || null;
}

export async function getDealLink(token: string) {
  const res = await db.query('SELECT * FROM deal_links WHERE token = $1 LIMIT 1', [token]);
  return res.rows[0] || null;
}

/** Consume a link after successful join. */
export async function markDealLinkUsed(token: string) {
  await db.query('DELETE FROM deal_links WHERE token = $1', [token]);
}

/** Assign role telegram ID to a deal after link validation — guarded: only if slot is empty */
export async function assignRoleToDeal(dealId: number | string, role: 'buyer' | 'seller', telegramId: number) {
  const column = role === 'buyer' ? 'buyer_telegram_id' : 'seller_telegram_id';
  const res = await db.query(
    `UPDATE deals SET ${column} = $1, updated_at = now() WHERE id = $2 AND ${column} IS NULL RETURNING id`,
    [telegramId, Number(dealId)],
  );
  if (res.rowCount === 0) {
    const deal = await getDealById(dealId);
    if (!deal) throw new Error('deal_not_found');
    throw new Error('deal_already_full');
  }
}

/** Atomic join: joiner fills the EMPTY slot (creator keeps theirs) + consume link.
 *  Either side can be the creator: buyer-created → joiner becomes seller,
 *  seller-created → joiner becomes buyer. */
export async function atomicJoinDeal(dealId: number, token: string, telegramId: number): Promise<'buyer' | 'seller'> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock deal row
    const dealRes = await client.query(
      'SELECT buyer_telegram_id, seller_telegram_id, status FROM deals WHERE id = $1 FOR UPDATE',
      [dealId],
    );
    if (dealRes.rows.length === 0) throw new Error('deal_not_found');
    const deal = dealRes.rows[0];
    const dealStatus = String(deal.status || '').toUpperCase();
    if (['RELEASED', 'REFUNDED', 'RELEASE_PENDING', 'REFUND_PENDING', 'CLOSED'].includes(dealStatus))
      throw new Error('deal_finished: cannot join a closed or locked deal');
    if (
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === Number(telegramId)) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === Number(telegramId))
    )
      throw new Error('already_party_to_deal');
    const linkRes = await client.query(
      'SELECT * FROM deal_links WHERE token = $1 AND deal_id = $2 AND expires_at > now() FOR UPDATE',
      [token, dealId],
    );
    if (linkRes.rows.length === 0) throw new Error('invalid_token');
    let role: 'buyer' | 'seller';
    if (deal.buyer_telegram_id != null && deal.seller_telegram_id == null) role = 'seller';
    else if (deal.seller_telegram_id != null && deal.buyer_telegram_id == null) role = 'buyer';
    else if (deal.buyer_telegram_id == null && deal.seller_telegram_id == null) throw new Error('deal_has_no_creator');
    else throw new Error('deal_already_full');
    const col = role === 'buyer' ? 'buyer_telegram_id' : 'seller_telegram_id';
    await client.query(`UPDATE deals SET ${col} = $1, updated_at = now() WHERE id = $2`, [telegramId, dealId]);
    await client.query('DELETE FROM deal_links WHERE token = $1', [token]);
    await client.query('COMMIT');
    return role;
  } catch (e) {
    // best-effort: never let a rollback failure mask the original join error.
    try {
      await client.query('ROLLBACK');
    } catch {} // best-effort: already handling a failure; a rollback error must not mask it.
    throw e;
  } finally {
    client.release();
  }
}

/** Record a party confirmation in the confirmations JSONB column. */
export async function setConfirmation(
  dealId: number | string,
  party: 'buyer' | 'seller',
  confirmations: Record<string, boolean>,
) {
  await db.query('UPDATE deals SET confirmations = $1::jsonb, updated_at = now() WHERE id = $2', [
    JSON.stringify(confirmations),
    Number(dealId),
  ]);
}

/** Retrieve chat messages for a deal — returns newest N in chronological order */
export async function getDealMessages(dealId: number, limit: number = 100) {
  const res = await db.query(
    `SELECT * FROM (
       SELECT id, deal_id, sender_telegram_id, content, encrypted_content, is_encrypted, created_at
       FROM messages WHERE deal_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
     ) sub ORDER BY created_at ASC, id ASC`,
    [dealId, limit],
  );
  return res.rows;
}

/** Add a message to a deal chat (legacy plaintext path — encrypts at rest if ENCRYPTION_KEY set) */
export async function addDealMessage(dealId: number, senderTelegramId: number, content: string) {
  const chatKey = await getDealChatKey(dealId);
  if (chatKey) {
    // E2E encrypt with per-deal key so DB never sees plaintext
    const encrypted = encryptWithDealKey(content, chatKey);
    await db.query(
      `INSERT INTO messages (deal_id, sender_telegram_id, content, encrypted_content, is_encrypted) VALUES ($1,$2,$3,$4,true)`,
      [dealId, senderTelegramId, '', encrypted],
    );
  } else {
    await db.query(`INSERT INTO messages (deal_id, sender_telegram_id, content) VALUES ($1,$2,$3)`, [
      dealId,
      senderTelegramId,
      content,
    ]);
  }
}

/** Add an already-encrypted message (ciphertext from client) — SERVER NEVER SEES PLAINTEXT */
export async function addEncryptedMessage(dealId: number, senderTelegramId: number, encryptedContentB64: string) {
  if (!encryptedContentB64 || typeof encryptedContentB64 !== 'string' || encryptedContentB64.length < 10) {
    throw new Error('invalid_ciphertext');
  }
  // Basic base64 validation + length check (iv 12 + tag 16 + at least 1 byte)
  let buf: Buffer;
  try {
    buf = Buffer.from(encryptedContentB64, 'base64');
    if (buf.length < 28) throw new Error('ciphertext_too_short');
  } catch {
    throw new Error('invalid_ciphertext');
  }
  await db.query(
    `INSERT INTO messages (deal_id, sender_telegram_id, content, encrypted_content, is_encrypted) VALUES ($1,$2,$3,$4,true)`,
    [dealId, senderTelegramId, '', encryptedContentB64],
  );
}

/** Build bot deep link for deal invite — t.me bot link, not website */
export function getBotDeepLink(dealId: number | string, token: string, botUsername?: string): string {
  const username = (botUsername || process.env.BOT_USERNAME || 'savdochi_uzbot').replace(/^@/, '');
  // Telegram start param max 64 chars, allowed A-Za-z0-9_- ; token is uuid with hyphens, so use join_<id>_<token>
  return `https://t.me/${username}?start=join_${dealId}_${token}`;
}

/** Create a pending join request (creator approves from the mini-app deal chat).
 *  Returns `{ request, created }` — `created=false` on duplicate re-clicks so the
 *  caller can skip re-notifying the creator (no DM spam on double taps).
 *  `requesterPhotoFileId` is a Telegram file_id (NOT a file URL — URLs embed the
 *  bot token and must never be stored/served; the photo proxy resolves it server-side).
 */
export async function createJoinRequest(params: {
  dealId: number;
  token: string;
  requesterTelegramId: number;
  requesterUsername?: string | null;
  requesterFirstName?: string | null;
  requesterPhotoUrl?: string | null;
  requesterPhotoFileId?: string | null;
}): Promise<{ request: any; created: boolean }> {
  const {
    dealId,
    token,
    requesterTelegramId,
    requesterUsername,
    requesterFirstName,
    requesterPhotoUrl,
    requesterPhotoFileId,
  } = params;
  // Upsert: if same requester already pending for same deal+token, return existing
  const existing = await db.query(
    `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND requester_telegram_id = $3 AND status = 'pending' LIMIT 1`,
    [dealId, token, requesterTelegramId],
  );
  if (existing.rows[0]) return { request: existing.rows[0], created: false };
  try {
    const res = await db.query(
      `INSERT INTO deal_join_requests (deal_id, token, requester_telegram_id, requester_username, requester_first_name, requester_photo_url, requester_photo_file_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
      [
        dealId,
        token,
        requesterTelegramId,
        requesterUsername || null,
        requesterFirstName || null,
        requesterPhotoUrl || null,
        requesterPhotoFileId || null,
      ],
    );
    return { request: res.rows[0], created: true };
  } catch (e) {
    // Concurrent double-click race: partial unique index uq_join_requests_pending
    // rejected the second INSERT — return the winner's row as a clean "already
    // requested" instead of a raw DB error.
    if ((e as { code?: string }).code === '23505') {
      const winner = await db.query(
        `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND requester_telegram_id = $2 AND status = 'pending' ORDER BY id ASC LIMIT 1`,
        [dealId, requesterTelegramId],
      );
      if (winner.rows[0]) return { request: winner.rows[0], created: false };
    }
    throw e;
  }
}

export async function getJoinRequestById(id: number) {
  const res = await db.query('SELECT * FROM deal_join_requests WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function getPendingRequest(dealId: number, token: string, requesterId: number) {
  const res = await db.query(
    `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND requester_telegram_id = $3 AND status = 'pending' LIMIT 1`,
    [dealId, token, requesterId],
  );
  return res.rows[0] || null;
}

export async function updateJoinRequestStatus(id: number, status: 'approved' | 'rejected' | 'pending') {
  await db.query('UPDATE deal_join_requests SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
}

/** Latest join request of one requester for a deal+token (any status).
 *  Powers GET /join-status so the joiner sees pending/approved/rejected
 *  instead of polling blindly forever after a rejection.
 */
export async function getMyJoinStatus(dealId: number, token: string, requesterId: number) {
  const res = await db.query(
    `SELECT * FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND requester_telegram_id = $3 ORDER BY id DESC LIMIT 1`,
    [dealId, token, requesterId],
  );
  return res.rows[0] || null;
}

/** Reject every OTHER pending request for a deal once it fills.
 *  Returns the auto-rejected rows so the route can notify those requesters
 *  (their invite is dead — the link was consumed by the winner).
 */
export async function rejectOtherPendingRequests(dealId: number, exceptId: number) {
  const res = await db.query(
    `UPDATE deal_join_requests SET status = 'rejected', updated_at = now()
     WHERE deal_id = $1 AND status = 'pending' AND id <> $2 RETURNING *`,
    [dealId, exceptId],
  );
  return res.rows;
}

/** Approve a join request — atomic: assign role + consume link + mark request approved.
 *  Either side can create a deal, so the CREATOR (whichever slot is occupied)
 *  approves from the mini-app deal chat. The joiner fills the empty slot.
 *  Also closes sibling pending requests (deal is full after this) and reports
 *  them so the caller can notify the losers.
 */
export async function approveJoinRequest(
  requestId: number,
  approverTelegramId: number,
  expectedDealId?: number,
): Promise<{ role: 'buyer' | 'seller'; autoRejected: any[] }> {
  const req = await getJoinRequestById(requestId);
  if (!req) throw new Error('request_not_found');
  if (expectedDealId != null && Number(req.deal_id) !== Number(expectedDealId))
    throw new Error('deal_mismatch: request does not belong to this deal');
  if (req.status !== 'pending') throw new Error('request_already_handled');
  const deal = await getDealById(req.deal_id);
  if (!deal) throw new Error('deal_not_found');
  const st = String((deal as any).status || '').toUpperCase();
  if (['RELEASED', 'REFUNDED', 'RELEASE_PENDING', 'REFUND_PENDING', 'CLOSED'].includes(st))
    throw new Error('deal_finished: cannot join a closed or locked deal');
  // Only the creator (the already-joined party) can approve.
  const isCreator =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === approverTelegramId) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === approverTelegramId);
  if (!isCreator) throw new Error('not_authorized_to_approve: only_creator_can_approve');
  if (Number(req.requester_telegram_id) === approverTelegramId) throw new Error('cannot_approve_own_request');
  // The invite link must still be alive — otherwise the join below fails with a
  // cryptic invalid_token. Fail early with a clear, mappable error instead.
  const link = await getDealLink(String(req.token)).catch(() => null);
  if (!link || Number(link.deal_id) !== Number(req.deal_id))
    throw new Error('link_expired: invite link already used or revoked');
  if (new Date(link.expires_at).getTime() <= Date.now()) throw new Error('link_expired: invite link expired');
  // Perform atomic join (assigns the empty slot; still the final race guard)
  const role = await atomicJoinDeal(req.deal_id, req.token, req.requester_telegram_id);
  await updateJoinRequestStatus(requestId, 'approved');
  const autoRejected = await rejectOtherPendingRequests(req.deal_id, requestId);
  return { role, autoRejected };
}

export async function rejectJoinRequest(requestId: number, approverTelegramId: number, expectedDealId?: number) {
  const req = await getJoinRequestById(requestId);
  if (!req) throw new Error('request_not_found');
  if (expectedDealId != null && Number(req.deal_id) !== Number(expectedDealId))
    throw new Error('deal_mismatch: request does not belong to this deal');
  if (req.status !== 'pending') throw new Error('request_already_handled');
  const deal = await getDealById(req.deal_id);
  if (!deal) throw new Error('deal_not_found');
  const isCreator =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === approverTelegramId) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === approverTelegramId);
  if (!isCreator) throw new Error('not_authorized_to_approve: only_creator_can_approve');
  await updateJoinRequestStatus(requestId, 'rejected');
}

/** Cleanup expired deal links */
export async function purgeExpiredLinks() {
  await db.query('DELETE FROM deal_links WHERE expires_at < now()');
}

/** Cleanup stale pending join requests (older than maxAgeHours, default 48).
 *  Their links are long dead — keeping them only confuses counts and badges.
 */
export async function purgeStaleJoinRequests(maxAgeHours = 48) {
  await db.query(
    `DELETE FROM deal_join_requests WHERE status = 'pending' AND created_at < now() - ($1 || ' hours')::interval`,
    [String(Math.max(1, Math.floor(maxAgeHours)))],
  );
}

// ── CHANNEL/GROUP escrow helpers (custodial via @gramchioka) ──
export async function updateChannelVerification(
  dealId: number,
  opts: {
    channelId?: string | null;
    channelTitle?: string | null;
    channelSnapshot?: Record<string, unknown> | null;
    verified?: boolean;
  },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts.channelId !== undefined) {
    sets.push(`channel_id = $${idx++}`);
    params.push(opts.channelId);
  }
  if (opts.channelTitle !== undefined) {
    sets.push(`channel_title = $${idx++}`);
    params.push(opts.channelTitle);
  }
  if (opts.channelSnapshot !== undefined) {
    sets.push(`channel_snapshot = $${idx++}::jsonb`);
    params.push(JSON.stringify(opts.channelSnapshot || {}));
  }
  if (opts.verified !== undefined) {
    sets.push(`channel_verified = $${idx++}`);
    params.push(!!opts.verified);
    if (opts.verified) sets.push(`channel_verified_at = now()`);
  }
  if (!sets.length) return;
  sets.push(`updated_at = now()`);
  params.push(dealId);
  await db.query(`UPDATE deals SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}
export async function setEscrowHolder(dealId: number, holderId: number) {
  await db.query('UPDATE deals SET escrow_holder_id = $1, updated_at = now() WHERE id = $2', [holderId, dealId]);
}
export async function setTransferToEscrow(dealId: number) {
  await db.query('UPDATE deals SET transfer_to_escrow_at = now(), updated_at = now() WHERE id = $1', [dealId]);
}
export async function setTransferToBuyer(dealId: number, newOwner: string) {
  await db.query(
    'UPDATE deals SET transfer_to_buyer_at = now(), pending_new_owner = $1, updated_at = now() WHERE id = $2',
    [newOwner, dealId],
  );
}
export async function setPendingNewOwner(dealId: number, newOwner: string) {
  await db.query('UPDATE deals SET pending_new_owner = $1, updated_at = now() WHERE id = $2', [newOwner, dealId]);
}
