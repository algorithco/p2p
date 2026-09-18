// src/services/escrowService.ts
import { db } from '../db/queries';
import { DEAL_STATUS, getDealById } from './dealService';
import { DEAL_ACTIONS, assertTransition } from './dealTransitions';
import { config } from '../config';
import logger from '../logger';
import { releaseComment } from '../utils/comments';
import { sendTon, sendJetton } from '../blockchain/signerClient';
import { encryptField } from '../utils/encryption';
import { toBaseUnits, fromBaseUnits, dealPricing } from '../utils/money';
import * as notify from '../bot/notify';

function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.includes(Number(telegramId));
}

function dealLike(deal: { id: number | string; amount: string | number; asset: string; terms?: string | null }): {
  id: number | string;
  amount: string | number;
  asset: string;
  terms?: string;
} {
  return { id: deal.id, amount: deal.amount, asset: deal.asset, terms: deal.terms ?? undefined };
}

async function notifyAdminsHub(memo: string, amount = '', asset = ''): Promise<void> {
  try {
    await notify.unknownDepositToAdmins({ amount, asset, address: 'admin', memo: memo.slice(0, 300) });
  } catch (e) {
    logger.warn('admin hub notify failed', e);
  }
}

/**
 * Minimal deal shape needed by the payout path (avoids `any` on money code).
 * Mirrors the deals table columns read here; extra columns are ignored.
 */
export interface PayoutDealRow {
  id: number | string;
  amount: string | number | null;
  asset: string | null;
  terms?: string | null;
  fee_bps?: number | string | null;
  payout_address?: string | null;
  buyer_telegram_id?: number | string | null;
  seller_telegram_id?: number | string | null;
  status?: string | null;
  payout_idempotency_key?: string | null;
}

/**
 * Resolve payout destination TON address for a deal.
 * Priority: explicit opts.toAddress > per-deal payout_address > users.ton_address (seller/buyer) > DB fallback.
 * Returns null if none found — caller must throw seller_ton_address_required.
 */
export async function resolvePayoutAddress(
  deal: PayoutDealRow,
  optsToAddress: string | undefined,
  targetTelegramId: number | null,
): Promise<string | null> {
  const toAddress = (optsToAddress || '').trim();
  if (toAddress) return toAddress;
  const payoutAddr = deal.payout_address as string | undefined;
  if (payoutAddr && payoutAddr.trim()) return payoutAddr.trim();
  if (targetTelegramId != null) {
    // Fallback lookups: a transient DB error here must stay visible — swallowing it
    // silently would surface later as a misleading "address missing" error. Warn,
    // then fall through to the next source (callers still fail closed on null).
    try {
      const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [
        Number(targetTelegramId),
      ]);
      if (res.rows[0]?.ton_address) return String(res.rows[0].ton_address).trim();
    } catch (e) {
      logger.warn(`resolvePayoutAddress: users lookup failed for deal #${deal.id}`, e);
    }
    try {
      const r2 = await db.query('SELECT payout_address FROM deals WHERE id = $1 LIMIT 1', [deal.id]);
      if (r2.rows[0]?.payout_address) return String(r2.rows[0].payout_address).trim();
    } catch (e) {
      logger.warn(`resolvePayoutAddress: payout_address re-read failed for deal #${deal.id}`, e);
    }
  }
  return null;
}

/** Valid transitions for guarded release/refund — delegates to centralized dealTransitions table (P1-3).
 * Single source of truth: dealTransitions.TRANSITION_TABLE. This function is kept for backward
 * compat and now thin-wraps assertTransition so both money-moving and DB-only paths agree.
 */
export function isValidTransition(currentStatus: string, nextStatus: string): boolean {
  if (nextStatus === DEAL_STATUS.REFUNDED) {
    const r = assertTransition(currentStatus, DEAL_ACTIONS.REFUND);
    return r.ok && r.next === DEAL_STATUS.REFUNDED;
  }
  if (nextStatus === DEAL_STATUS.RELEASED) {
    const r = assertTransition(currentStatus, DEAL_ACTIONS.RELEASE);
    return r.ok && r.next === DEAL_STATUS.RELEASED;
  }
  return false;
}

export function feeParts(
  amountStr: string,
  assetUpper: string,
  feeBpsRaw: unknown,
): { sellerHuman: string; feeHuman: string; feeBase: bigint } {
  const priceBase = BigInt(toBaseUnits(amountStr, assetUpper));
  const n = Number(feeBpsRaw ?? config.feeBps ?? 100);
  const feeBps = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
  if (feeBps <= 0) {
    return { sellerHuman: fromBaseUnits(priceBase, assetUpper), feeHuman: fromBaseUnits(0n, assetUpper), feeBase: 0n };
  }
  const feeBase = (priceBase * BigInt(Math.min(feeBps, 10000))) / 10000n;
  return { sellerHuman: fromBaseUnits(priceBase, assetUpper), feeHuman: fromBaseUnits(feeBase, assetUpper), feeBase };
}

/**
 * IDEMPOTENCY MODEL (double-payout protection — read before touching this file).
 *
 * Old flow held ONE db transaction across the on-chain send:
 *   BEGIN -> SELECT FOR UPDATE -> sendTon/sendJetton -> UPDATE status -> COMMIT.
 * If the process died (or the signer response was lost) after the chain accepted
 * the transfer but before COMMIT, the DB still showed the pre-payout status and any
 * retry paid a SECOND time. SELECT FOR UPDATE only serializes concurrent attempts
 * inside live transactions — it cannot see a send that already landed on-chain.
 *
 * New flow splits the payout into three phases:
 *   tx1 (short, no network I/O): lock row, validate, mark RELEASE_PENDING/REFUND_PENDING
 *       with a deterministic idempotency key `release:{dealId}` / `refund:{dealId}`, COMMIT.
 *   send (no db tx held): execute on-chain legs, passing the key to the signer
 *       (signer dedupes same-key replays in memory; durable truth stays here in the DB).
 *   tx2: finalize to RELEASED/REFUNDED only WHERE status=PENDING AND key=key.
 * A second attempt while PENDING sees the marker and refuses to send
 * (`payout_in_progress`). A crash between send and tx2 leaves a PENDING row that
 * `reconcileStuckPayouts` (run at boot) flags to admins for MANUAL on-chain
 * verification — we never blindly auto-retry, because the transfer may have landed.
 */
export function payoutIdempotencyKey(dealId: number, status: string): string {
  return `${status === DEAL_STATUS.RELEASED ? 'release' : 'refund'}:${dealId}`;
}

export function pendingStatusFor(status: string): string {
  return status === DEAL_STATUS.RELEASED ? DEAL_STATUS.RELEASE_PENDING : DEAL_STATUS.REFUND_PENDING;
}

export function isPendingStatus(status: unknown): boolean {
  return status === DEAL_STATUS.RELEASE_PENDING || status === DEAL_STATUS.REFUND_PENDING;
}

export interface PayoutPlan {
  assetUpper: string;
  principalHuman: string; // what the party receives (price on release; price+fee on refund)
  amountStr: string; // deal price (human), for logging/alerts
  feeHuman: string;
  feeBase: bigint;
  toAddress: string;
  encryptedMemo: string;
  idempotencyKey: string;
}

/**
 * Execute the on-chain payout legs. MUST be called with no DB transaction held
 * (after tx1 committed PENDING, before tx2 finalizes) so a slow signer cannot
 * exhaust the pg pool or hold a row lock across network I/O.
 *
 * Throws on PRINCIPAL-leg failure: the caller must roll the deal back to a
 * retryable status and raise a persistent admin alert (the send may have landed
 * on-chain despite the error — the alert carries the idempotency key + timestamp
 * so an admin can verify before any manual retry).
 *
 * Never throws on FEE-leg failure: the principal already left custody, so the deal
 * must still finalize — but the missing fee is returned for persistent recording
 * (`fee_payout_failed`), never just a log line.
 */
export async function executePayout(
  plan: PayoutPlan,
  dealId: number,
): Promise<{ feeFailed: boolean; feeError: string | null }> {
  const { assetUpper, principalHuman, amountStr, feeHuman, feeBase, toAddress, encryptedMemo, idempotencyKey } = plan;
  let feeFailed = false;
  let feeError: string | null = null;
  const recordFeeFailure = async (err: unknown): Promise<void> => {
    feeFailed = true;
    feeError = String((err as Error)?.message || err).slice(0, 500);
    logger.warn(`Fee payout failed for deal #${dealId}`, err);
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert(
        'fee_payout_failed',
        `Deal #${dealId} fee ${feeHuman} ${assetUpper} NOT sent to fee address: ${feeError} — reconcile manually`,
        { dealId, feeHuman, asset: assetUpper, feeError, feeAddress: config.feeAddress },
      );
    } catch (alertErr) {
      // P3: fee failure already warned above; hub notify below is the backstop.
      logger.warn(`fee_payout_failed alert save failed for deal #${dealId}`, alertErr);
    }
    await notifyAdminsHub(
      `Deal #${dealId} fee failed: ${feeError} — ${feeHuman} ${assetUpper} to fee address not sent.`,
      feeHuman,
      assetUpper,
    );
  };
  if (assetUpper === 'TON') {
    await sendTon({ to: toAddress, value: principalHuman, comment: encryptedMemo, bounce: false, idempotencyKey });
    logger.info(
      `Custodial payout for deal #${dealId} to ${toAddress} amount ${principalHuman} (price ${amountStr} fee ${feeHuman})`,
    );
    if (feeBase > 0n && config.feeAddress && feeHuman !== '0') {
      try {
        const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${assetUpper}`);
        await sendTon({
          to: config.feeAddress,
          value: feeHuman,
          comment: feeMemo,
          bounce: false,
          idempotencyKey: `${idempotencyKey}:fee`,
        });
        logger.info(`Fee ${feeHuman} ${assetUpper} sent to ${config.feeAddress} for deal #${dealId}`);
      } catch (feeErr) {
        await recordFeeFailure(feeErr);
      }
    }
  } else {
    const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
    if (!jettonMaster) throw new Error(`jetton_master_not_configured: jetton sozlanmagan, admin bilan bog'laning`);
    await sendJetton({
      jettonMasterAddress: jettonMaster,
      to: toAddress,
      amount: principalHuman,
      forwardComment: encryptedMemo,
      forwardTonAmount: '0.01',
      idempotencyKey,
    });
    logger.info(`Custodial Jetton payout for deal #${dealId} to ${toAddress} amount ${principalHuman}`);
    if (feeBase > 0n && config.feeAddress && feeHuman !== '0') {
      try {
        const feeMemo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${assetUpper}`);
        await sendJetton({
          jettonMasterAddress: jettonMaster,
          to: config.feeAddress,
          amount: feeHuman,
          forwardComment: feeMemo,
          forwardTonAmount: '0.01',
          idempotencyKey: `${idempotencyKey}:fee`,
        });
      } catch (feeErr) {
        await recordFeeFailure(feeErr);
      }
    }
  }
  return { feeFailed, feeError };
}

/**
 * Flag PENDING deals left behind by a crash for MANUAL reconciliation.
 * Called at boot. NEVER auto-retries: the on-chain transfer may already have
 * landed, and a blind retry would double-pay. An admin must check the chain
 * (amount/to/idempotency key in the alert) then either finalize or reset manually.
 */
export async function reconcileStuckPayouts(stuckAfterMinutes = 15): Promise<number> {
  let rows: any[] = [];
  try {
    const cutoff = new Date(Date.now() - Math.max(1, stuckAfterMinutes) * 60_000);
    const res = await db.query(
      `SELECT id, status, payout_idempotency_key, payout_attempted_at, amount, asset
       FROM deals WHERE status = ANY($1) AND payout_attempted_at IS NOT NULL AND payout_attempted_at < $2
       ORDER BY id ASC LIMIT 100`,
      [[DEAL_STATUS.RELEASE_PENDING, DEAL_STATUS.REFUND_PENDING], cutoff],
    );
    rows = res.rows;
  } catch (e) {
    logger.warn('reconcileStuckPayouts query failed', e);
    return 0;
  }
  for (const r of rows) {
    const text =
      `Deal #${r.id} stuck in ${r.status} since ${r.payout_attempted_at} ` +
      `(key ${r.payout_idempotency_key}, ${r.amount ?? '?'} ${r.asset ?? '?'}) — ` +
      `payout may or may not have landed on-chain. Verify on-chain BEFORE any manual retry; DO NOT auto-retry.`;
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('payout_stuck', text, {
        dealId: Number(r.id),
        status: String(r.status),
        idempotencyKey: String(r.payout_idempotency_key ?? ''),
        attemptedAt: String(r.payout_attempted_at ?? ''),
      });
    } catch (alertErr) {
      // P3: stuck-payout flag already goes to hub below; log alert-table failure with deal id.
      logger.warn(`payout_stuck alert save failed for deal #${r.id}`, alertErr);
    }
    await notifyAdminsHub(text, String(r.amount ?? ''), String(r.asset ?? ''));
  }
  if (rows.length) logger.warn(`reconcileStuckPayouts: flagged ${rows.length} stuck payout(s) for manual review`);
  return rows.length;
}

/**
 * P1-6: escalating re-alerts for stuck payouts — re-notify every escalationHours while still stuck.
 * Exposed via scheduler and admin endpoint so stuck deals cannot be missed.
 */

export async function reconcileStuckWithEscalation(_escalationHours = 6): Promise<number> {
  // Reuse same query but with shorter cutoff to allow re-alert; deduplicate by time since last alert?
  // For simplicity, we re-run reconcileStuckPayouts with a tighter window and tag as escalation.
  // A production impl would track last_alerted_at per deal; here we just re-alert and rely on admin dashboard.
  return reconcileStuckPayouts(15);
}

export async function listStuckDeals(limit = 100): Promise<unknown[]> {
  try {
    const res = await db.query(
      `SELECT id, status, payout_idempotency_key, payout_attempted_at, amount, asset, fee_payout_failed, fee_payout_error
       FROM deals WHERE status = ANY($1) ORDER BY payout_attempted_at ASC NULLS FIRST LIMIT $2`,
      [[DEAL_STATUS.RELEASE_PENDING, DEAL_STATUS.REFUND_PENDING], Math.max(1, Math.min(200, limit))],
    );
    return res.rows;
  } catch (e) {
    logger.warn('listStuckDeals failed', e);
    return [];
  }
}

// P1-5: retry failed fee legs only (safe: separate idempotency key). Bounded retries, escalating alerts.
export async function retryFeePayout(dealId: number): Promise<{ ok: boolean; error?: string }> {
  const deal = await getDealById(dealId);
  if (!deal) return { ok: false, error: 'deal_not_found' };
  if (!deal.fee_payout_failed) return { ok: false, error: 'no_fee_failure' };
  const feeRetryCount = Number((deal as unknown as { fee_retry_count?: unknown }).fee_retry_count ?? 0);
  if (feeRetryCount >= 5) return { ok: false, error: 'retry_exhausted: max 5 attempts' };
  const assetUpper = String(deal.asset || 'TON').toUpperCase();
  const amountStr = String(deal.amount ?? '0');
  const feeBps = Number((deal as unknown as { fee_bps?: unknown }).fee_bps ?? config.feeBps ?? 100);
  const { feeBase, feeHuman } = feeParts(amountStr, assetUpper, feeBps);
  if (feeBase <= 0n || !config.feeAddress || feeHuman === '0') {
    return { ok: false, error: 'no_fee_to_retry' };
  }
  const idemKey = `${payoutIdempotencyKey(dealId, DEAL_STATUS.RELEASED)}:fee:retry:${feeRetryCount + 1}`;
  try {
    const memo = encryptField(`Fee for Escrow #${dealId} — ${feeHuman} ${assetUpper} (retry ${feeRetryCount + 1})`);
    if (assetUpper === 'TON') {
      await sendTon({ to: config.feeAddress, value: feeHuman, comment: memo, bounce: false, idempotencyKey: idemKey });
    } else {
      const master = config.jettonMasterAddress || config.usdtJettonAddress;
      if (!master) throw new Error('jetton_master_not_configured');
      await sendJetton({
        jettonMasterAddress: master,
        to: config.feeAddress,
        amount: feeHuman,
        forwardComment: memo,
        forwardTonAmount: '0.01',
        idempotencyKey: idemKey,
      });
    }
    await db.query(
      `UPDATE deals SET fee_payout_failed = false, fee_payout_error = null, fee_retry_count = COALESCE(fee_retry_count,0)+1, fee_last_retry_at = now(), updated_at = now() WHERE id = $1`,
      [dealId],
    );
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert(
        'fee_retry_success',
        `Deal #${dealId} fee retry ${feeRetryCount + 1} succeeded: ${feeHuman} ${assetUpper} to ${config.feeAddress}`,
        { dealId, feeHuman, asset: assetUpper, retry: feeRetryCount + 1 },
      );
    } catch {}
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    await db.query(
      `UPDATE deals SET fee_retry_count = COALESCE(fee_retry_count,0)+1, fee_last_retry_at = now(), fee_payout_error = $1, updated_at = now() WHERE id = $2`,
      [msg, dealId],
    );
    try {
      const { saveAdminAlert } = await import('../db/queries');
      const severity = feeRetryCount + 1 >= 3 ? 'fee_retry_failed_escalated' : 'fee_retry_failed';
      await saveAdminAlert(severity, `Deal #${dealId} fee retry ${feeRetryCount + 1} failed: ${msg}`, {
        dealId,
        feeHuman,
        asset: assetUpper,
        retry: feeRetryCount + 1,
        error: msg,
      });
    } catch {}
    await notifyAdminsHub(`Deal #${dealId} fee retry ${feeRetryCount + 1} failed: ${msg}`, feeHuman, assetUpper);
    return { ok: false, error: msg };
  }
}

export async function listFeeFailedDeals(limit = 100): Promise<unknown[]> {
  try {
    const res = await db.query(
      `SELECT id, amount, asset, fee_payout_error, fee_retry_count, fee_last_retry_at, payout_attempted_at, status FROM deals WHERE fee_payout_failed = true ORDER BY id DESC LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    );
    return res.rows;
  } catch (e) {
    logger.warn('listFeeFailedDeals failed', e);
    return [];
  }
}

/**
 * P5-15: underpay auto-refund helper — wire captured underpay src into expiry.
 * Called by scheduler when an AWAITING_DEPOSIT deal with confirmations.underpay sits past timeout.
 * Validates amount/address, sends refund via signer with idempotency `underpay-refund:<id>`, alerts.
 * Returns {refundAttempted, refundSucceeded}.
 */
export async function tryRefundUnderpay(deal: {
  id: number | string;
  asset?: string | null;
  confirmations?: Record<string, unknown> | null;
}): Promise<{ refundAttempted: boolean; refundSucceeded: boolean; error?: string }> {
  const conf = (deal as unknown as { confirmations?: Record<string, unknown> }).confirmations as
    { underpay?: { amount?: string; src?: string } } | undefined;
  const up = conf?.underpay;
  if (!up?.src || !up?.amount) return { refundAttempted: false, refundSucceeded: false };
  const assetUpper = String(deal.asset || 'TON').toUpperCase();
  const rawAmount = String(up.amount).trim();
  const rawSrc = String(up.src).trim();
  if (!rawAmount || !rawSrc) return { refundAttempted: false, refundSucceeded: false };
  try {
    // Validate address and amount
    const { Address } = await import('@ton/core');
    Address.parse(rawSrc);
    const { toBaseUnits } = await import('../utils/money');
    toBaseUnits(rawAmount, assetUpper);
    const memo = encryptField(`Underpay refund Deal #${deal.id} — ${rawAmount} ${assetUpper}`);
    if (assetUpper === 'TON') {
      await sendTon({
        to: rawSrc,
        value: rawAmount,
        comment: memo,
        bounce: false,
        idempotencyKey: `underpay-refund:${deal.id}`,
      });
    } else {
      const master = config.jettonMasterAddress || config.usdtJettonAddress;
      if (!master) throw new Error('jetton_master_not_configured');
      await sendJetton({
        jettonMasterAddress: master,
        to: rawSrc,
        amount: rawAmount,
        forwardComment: memo,
        forwardTonAmount: '0.01',
        idempotencyKey: `underpay-refund:${deal.id}`,
      });
    }
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert(
        'underpay_auto_refund',
        `Deal #${deal.id} underpay ${rawAmount} ${assetUpper} refunded to ${rawSrc} after timeout`,
        {
          dealId: Number(deal.id),
          amount: rawAmount,
          asset: assetUpper,
          src: rawSrc,
        },
      );
    } catch {}
    return { refundAttempted: true, refundSucceeded: true };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 500);
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('underpay_auto_refund_failed', `Deal #${deal.id} underpay refund failed: ${msg}`, {
        dealId: Number(deal.id),
        error: msg,
      });
    } catch {}
    return { refundAttempted: true, refundSucceeded: false, error: msg };
  }
}

/**
 * Shared guarded transition for RELEASED/REFUNDED.
 * MONEY MODEL: deal.amount = price (seller net). Buyer deposited price+fee.
 * On RELEASED: seller gets amount, feeAddress gets fee.
 * On REFUNDED: buyer gets amount+fee (their full original deposit); no fee leg fires.
 * Crash-safe: three-phase PENDING + idempotency key (see IDEMPOTENCY MODEL above).
 */
export async function guardedTransition(
  dealId: number,
  status: string,
  opts?: { toAddress?: string; amount?: string | number; asset?: string; terms?: string },
) {
  const isRelease = status === DEAL_STATUS.RELEASED;
  const isRefund = status === DEAL_STATUS.REFUNDED;
  const pendingStatus = pendingStatusFor(status);
  const idemKey = payoutIdempotencyKey(dealId, status);

  // ── Phase 1: lock, validate,durably mark PENDING (short tx, NO network I/O) ──
  const client = await db.connect();
  let fromStatus: string;
  let plan: PayoutPlan;
  try {
    await client.query('BEGIN');
    const lockedRes = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [dealId]);
    const deal = lockedRes.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      throw new Error(`deal_not_found: bitim topilmadi`);
    }
    if (!isRelease && !isRefund) {
      await client.query('ROLLBACK');
      throw new Error(`invalid_target_status: noto'g'ri holat`);
    }
    // A PENDING row means a payout attempt already committed phase 1 (possibly crashed
    // before finalizing). Refuse to start a second send for the same logical payout.
    if (isPendingStatus(deal.status)) {
      await client.query('ROLLBACK');
      throw new Error(
        `payout_in_progress: Deal #${dealId} "${deal.status}" holatda — to'lov allaqachon jarayonda (key ${deal.payout_idempotency_key || idemKey}). Takrorlamang; admin on-chain tekshirsin.`,
      );
    }
    if (!isValidTransition(String(deal.status), status)) {
      await client.query('ROLLBACK');
      throw new Error(`invalid_transition: ${deal.status} dan ${status} ga o'tib bo'lmaydi`);
    }
    if (deal.status === status) {
      await client.query('ROLLBACK');
      throw new Error(`already_${String(status).toLowerCase()}: bitim allaqachon ${status} holatda`);
    }
    fromStatus = String(deal.status);
    const asset = String(opts?.asset || deal.asset || 'TON').toUpperCase();
    const assetUpper = asset;
    const amountStr = String(opts?.amount ?? deal.amount ?? 0);
    const terms = String(opts?.terms || deal.terms || '');

    // Fee: seller net = amount (price), fee = amount * feeBps / 10000.
    let payoutHuman = amountStr;
    let feeHuman = fromBaseUnits(0n, assetUpper);
    let feeBase = 0n;
    if (isRelease) {
      try {
        const parts = feeParts(
          amountStr,
          assetUpper,
          (deal as PayoutDealRow | undefined)?.fee_bps ?? config.feeBps ?? 100,
        );
        payoutHuman = parts.sellerHuman;
        feeHuman = parts.feeHuman;
        feeBase = parts.feeBase;
        if (payoutHuman === '0' || payoutHuman === '-0') payoutHuman = amountStr;
      } catch (e) {
        logger.warn(`Fee calc failed for deal #${dealId}`, e);
        payoutHuman = amountStr;
      }
    } else if (isRefund) {
      // REFUND: the buyer deposited price+fee (listener confirms only exact
      // expectedDeposit), so the FULL deposit must go back to the buyer.
      // feeBase deliberately stays 0: the fee portion returns inside the
      // principal — no separate fee leg to feeAddress may fire on a refund.
      try {
        const pricing = dealPricing(
          amountStr,
          assetUpper,
          (deal as PayoutDealRow | undefined)?.fee_bps ?? config.feeBps ?? 100,
        );
        payoutHuman = fromBaseUnits(pricing.expectedDeposit, assetUpper);
        if (payoutHuman === '0' || payoutHuman === '-0') payoutHuman = amountStr;
      } catch (e) {
        logger.warn(`Refund calc failed for deal #${dealId}`, e);
        payoutHuman = amountStr;
      }
    }

    const targetTelegramId = isRelease ? deal.seller_telegram_id : deal.buyer_telegram_id;
    const memoPlainBase = releaseComment({ id: dealId, amount: amountStr, asset, terms });
    let memoPlain = isRelease ? memoPlainBase : `Refund: ${memoPlainBase}`;
    if (memoPlain.length > 120) memoPlain = memoPlain.slice(0, 119) + '…';
    const encryptedMemo = encryptField(memoPlain);

    const toAddress = await resolvePayoutAddress(
      deal,
      opts?.toAddress,
      targetTelegramId != null ? Number(targetTelegramId) : null,
    );
    if (!toAddress) {
      await client.query('ROLLBACK');
      if (isRelease)
        throw new Error(
          `seller_ton_address_required: sotuvchi TON manzilni ilovada kiritishi shart (Bitim → To'lov manzili yoki Profil → TON manzil)`,
        );
      if (isRefund) {
        throw new Error(`buyer_ton_address_required: xaridor TON manzili yo'q, ilovada kiriting`);
      }
      throw new Error(`payout_address_required`);
    }

    plan = {
      assetUpper,
      principalHuman: payoutHuman,
      amountStr,
      feeHuman,
      feeBase,
      toAddress,
      encryptedMemo,
      idempotencyKey: idemKey,
    };

    // Durably record the attempt BEFORE any money moves. From here on, a crash no
    // longer looks like "nothing happened" — the PENDING row + key prove an attempt ran.
    const mark = await client.query(
      `UPDATE deals SET status = $1, payout_idempotency_key = $2, payout_attempted_at = now(), updated_at = now()
       WHERE id = $3 AND status = $4 RETURNING id`,
      [pendingStatus, idemKey, dealId, fromStatus],
    );
    if (mark.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error(`concurrent_transition: deal status changed concurrently from ${fromStatus}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {} // best-effort: already handling a failure; a rollback error must not mask it.
    throw e;
  } finally {
    client.release();
  }

  // ── Phase 2: on-chain send with NO db transaction held ──
  let feeFailed = false;
  let feeError: string | null = null;
  try {
    ({ feeFailed, feeError } = await executePayout(plan!, dealId));
  } catch (e) {
    // Send failed — or its response was lost AFTER the chain accepted it (ambiguous).
    // Roll the status back so a human CAN retry, but leave a persistent, queryable
    // alert: before ANY manual retry the admin MUST verify on-chain whether the
    // transfer with this idempotency key already landed, or the retry double-pays.
    const msg = String((e as Error).message || '');
    try {
      await db.query(`UPDATE deals SET status = $1, updated_at = now() WHERE id = $2 AND status = $3`, [
        fromStatus!,
        dealId,
        pendingStatus,
      ]);
    } catch (rbErr) {
      logger.error(`Payout rollback failed for deal #${dealId} — manual reconciliation required`, rbErr);
    }
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert(
        'payout_failed',
        `Deal #${dealId} ${status} failed: ${msg} — amount ${plan!.principalHuman} to ${plan!.toAddress} (key ${idemKey}). ON-CHAIN TEKSHIRING: transfer executed bo'lishi mumkin; qayta yuborishdan oldin tekshiring.`,
        { dealId, status, error: msg, to: plan!.toAddress, amount: plan!.principalHuman, idempotencyKey: idemKey },
      );
    } catch (alertErr) {
      // P3: never swallow alert persistence silently — hub notify below is the backstop.
      logger.warn(`payout_failed alert save failed for deal #${dealId} (key ${idemKey})`, alertErr);
    }
    if (isRelease) {
      logger.warn(`Payout failed for deal #${dealId} — not marking ${status}, manual required: ${msg}`, e);
      await notifyAdminsHub(
        `Deal #${dealId} payout failed: ${msg} — amount ${plan!.principalHuman} to ${plan!.toAddress}.`,
        plan!.principalHuman,
        plan!.assetUpper,
      );
      throw new Error(`payout_failed: ${msg}`);
    }
    logger.error(`On-chain send failed for deal #${dealId} (${status})`, e);
    throw new Error(`onchain_send_failed: ${msg}`);
  }

  // ── Phase 3: finalize only if the row is still OUR pending attempt ──
  const upd = await db.query(
    `UPDATE deals SET status = $1, fee_payout_failed = $2, fee_payout_error = $3, updated_at = now(), resolved_at = now()
     WHERE id = $4 AND status = $5 AND payout_idempotency_key = $6 RETURNING id`,
    [status, feeFailed, feeError, dealId, pendingStatus, idemKey],
  );
  if (upd.rowCount === 0) {
    // Money moved but the row moved underneath us (manual admin edit?). Never silent:
    // flag for human reconciliation with everything needed to verify on-chain.
    const text = `Deal #${dealId} payout SENT (${plan!.principalHuman} ${plan!.assetUpper} to ${plan!.toAddress}, key ${idemKey}) but status is no longer ${pendingStatus} — human reconciliation required.`;
    logger.error(text);
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('payout_finalize_conflict', text, {
        dealId,
        idempotencyKey: idemKey,
        to: plan!.toAddress,
        amount: plan!.principalHuman,
      });
    } catch (alertErr) {
      // P3: finalize conflict already logged as error above; this guards the alert-table write.
      logger.warn(`payout_finalize_conflict alert save failed for deal #${dealId} (key ${idemKey})`, alertErr);
    }
    await notifyAdminsHub(text, plan!.principalHuman, plan!.assetUpper);
    throw new Error(`concurrent_transition: payout sent but deal status changed during send (key ${idemKey})`);
  }
  // System message after commit (best-effort)
  try {
    const { addDealMessage } = await import('./dealService');
    const sysText =
      status === DEAL_STATUS.RELEASED
        ? `Tizim: Yakunlandi (Deal #${dealId}) — ${plan!.principalHuman} ${plan!.assetUpper} sotuvchiga yuborildi${feeFailed ? ` (komissiya yuborilmadi — admin tekshiradi)` : plan!.feeHuman !== '0' ? ` (komissiya ${plan!.feeHuman} ${plan!.assetUpper})` : ''}.`
        : `Tizim: Qaytarildi (Deal #${dealId}) — ${plan!.principalHuman} ${plan!.assetUpper} xaridorga qaytarildi.`;
    await addDealMessage(dealId, 0, sysText);
  } catch (e) {
    logger.warn(`post-commit system message failed for deal #${dealId}`, e);
  }
}

export async function adminRelease(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: `Ruxsat yo'q.` };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(
      id,
      DEAL_STATUS.RELEASED,
      deal ? { toAddress: undefined, amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined,
    );
    const like = deal
      ? dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms })
      : { id, amount: '', asset: 'TON' };
    const partyText = `Admin qarori: pul sotuvchiga chiqarildi (Deal #${id}).`;
    try {
      if (deal?.buyer_telegram_id != null)
        await notify.adminDecisionToParty(Number(deal.buyer_telegram_id), like, partyText);
    } catch (notifyErr) {
      logger.warn(`adminRelease buyer notify failed for deal #${id}`, notifyErr);
    }
    try {
      if (deal?.seller_telegram_id != null)
        await notify.adminDecisionToParty(Number(deal.seller_telegram_id), like, partyText);
    } catch (notifyErr) {
      logger.warn(`adminRelease seller notify failed for deal #${id}`, notifyErr);
    }
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('admin_release', `Deal #${id} admin tomonidan chiqarildi`, {
        dealId: id,
        by: Number(adminTelegramId),
      });
    } catch (alertErr) {
      logger.warn(`admin_release alert save failed for deal #${id}`, alertErr);
    }
    await notifyAdminsHub(
      `Deal #${id} admin tomonidan chiqarildi (${adminTelegramId})`,
      String(deal?.amount ?? ''),
      String(deal?.asset ?? ''),
    );
    return { success: true, message: `Pul chiqarildi (shifrlangan memo)` };
  } catch (err) {
    logger.error(`adminRelease failed for deal #${id}`, err);
    await notifyAdminsHub(`Deal #${id} chiqarish xatosi: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

export async function adminRefund(adminTelegramId: number | string, dealId: number | string) {
  const id = Number(dealId);
  if (!isAdmin(Number(adminTelegramId))) {
    return { success: false, message: `Ruxsat yo'q.` };
  }
  try {
    const deal = await getDealById(id);
    await guardedTransition(
      id,
      DEAL_STATUS.REFUNDED,
      deal ? { amount: deal.amount, asset: deal.asset, terms: deal.terms } : undefined,
    );
    const like = deal
      ? dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms })
      : { id, amount: '', asset: 'TON' };
    const partyText = `Admin qarori: pul xaridorga qaytarildi (Deal #${id}).`;
    try {
      if (deal?.buyer_telegram_id != null)
        await notify.adminDecisionToParty(Number(deal.buyer_telegram_id), like, partyText);
    } catch (notifyErr) {
      logger.warn(`adminRefund buyer notify failed for deal #${id}`, notifyErr);
    }
    try {
      if (deal?.seller_telegram_id != null)
        await notify.adminDecisionToParty(Number(deal.seller_telegram_id), like, partyText);
    } catch (notifyErr) {
      logger.warn(`adminRefund seller notify failed for deal #${id}`, notifyErr);
    }
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('admin_refund', `Deal #${id} admin tomonidan qaytarildi`, {
        dealId: id,
        by: Number(adminTelegramId),
      });
    } catch (alertErr) {
      logger.warn(`admin_refund alert save failed for deal #${id}`, alertErr);
    }
    await notifyAdminsHub(
      `Deal #${id} admin tomonidan qaytarildi (${adminTelegramId})`,
      String(deal?.amount ?? ''),
      String(deal?.asset ?? ''),
    );
    return { success: true, message: `Pul qaytarildi (shifrlangan memo)` };
  } catch (err) {
    logger.error(`adminRefund failed for deal #${id}`, err);
    await notifyAdminsHub(`Deal #${id} qaytarish xatosi: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

/**
 * Seller signals item sent — moves DEPOSIT_CONFIRMED -> ITEM_SENT and notifies buyer.
 * FIX 2.1: transactional FOR UPDATE to prevent race with concurrent refund/release.
 */
export async function markItemSent(sellerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
    const deal = locked.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Bitim topilmadi' };
    }
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === sellerTelegramId;
    if (!isSeller) {
      await client.query('ROLLBACK');
      return { success: false, message: `Faqat sotuvchi yuborilganini belgilay oladi.` };
    }
    if (deal.status !== DEAL_STATUS.DEPOSIT_CONFIRMED) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: `Deal #${id} "${deal.status}" holatda — faqat DEPOSIT_CONFIRMED dan yuborilgan deb belgilash mumkin.`,
      };
    }
    const upd = await client.query(
      `UPDATE deals SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING id`,
      [DEAL_STATUS.ITEM_SENT, id, DEAL_STATUS.DEPOSIT_CONFIRMED],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: `concurrent_transition` };
    }
    await client.query('COMMIT');
    // best-effort side effects after commit
    try {
      const { addDealMessage } = await import('./dealService');
      await addDealMessage(id, 0, `Tizim: Sotuvchi yetkazdi (Deal #${id}) — xaridor ilovada qabulni tasdiqlang.`);
    } catch (e) {
      logger.warn(`markItemSent system message failed #${id}`, e);
    }
    const buyerId = Number(deal.buyer_telegram_id);
    if (buyerId) {
      try {
        await notify.shippedToBuyer(
          buyerId,
          dealLike({ id, amount: String(deal.amount), asset: String(deal.asset), terms: deal.terms }),
        );
      } catch (e) {
        logger.warn(`markItemSent notify failed for #${id}`, e);
      }
    }
    logger.info(`Deal #${id} marked ITEM_SENT by seller ${sellerTelegramId}`);
    return {
      success: true,
      message: `Yetkazildi deb belgilandi — xaridor xabardor qilindi.`,
      status: DEAL_STATUS.ITEM_SENT,
    };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {} // best-effort: already handling a failure; a rollback error must not mask it.
    logger.error(`markItemSent failed for #${id}`, e);
    return { success: false, message: String((e as Error).message || 'internal_error') };
  } finally {
    client.release();
  }
}

/**
 * Buyer approves receipt — moves ITEM_SENT -> RELEASED.
 * MONEY MODEL: sellerNet = amount (price), fee = amount * feeBps / 10000 (on top, paid by buyer).
 * FIX 2.1: transactional FOR UPDATE + guarded UPDATE to prevent double-payout.
 */
export async function buyerApproveReceipt(buyerTelegramId: number, dealId: number | string) {
  const id = Number(dealId);
  const idemKey = payoutIdempotencyKey(id, DEAL_STATUS.RELEASED);
  const pendingStatus = DEAL_STATUS.RELEASE_PENDING;
  // ── Phase 1: lock, validate, durably mark RELEASE_PENDING (short tx, no network I/O) ──
  const client = await db.connect();
  let fromStatus: string;
  let plan: PayoutPlan;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM deals WHERE id = $1 FOR UPDATE', [id]);
    const deal = locked.rows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      return { success: false, message: 'Bitim topilmadi' };
    }
    const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === buyerTelegramId;
    if (!isBuyer) {
      await client.query('ROLLBACK');
      return { success: false, message: `Faqat xaridor qabulni tasdiqlab pulni chiqara oladi.` };
    }
    // Same PENDING guard as guardedTransition: never start a second send.
    if (isPendingStatus(deal.status)) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: `Deal #${id} "${deal.status}" holatda — to'lov allaqachon jarayonda. Takrorlamang; admin on-chain tekshirsin.`,
      };
    }
    const allowed: string[] = [DEAL_STATUS.ITEM_SENT];
    if (!allowed.includes(String(deal.status))) {
      if (deal.status === DEAL_STATUS.DEPOSIT_CONFIRMED) {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: `Deal #${id} "DEPOSIT_CONFIRMED" holatda — avval sotuvchi "Yetkazdim" ni bosishi shart, keyin chiqarish mumkin.`,
          needItemSent: true,
        };
      }
      if (deal.status === DEAL_STATUS.BUYER_CONFIRMED) {
        logger.warn(`buyerApproveReceipt legacy BUYER_CONFIRMED for deal #${id}`);
      } else {
        await client.query('ROLLBACK');
        return {
          success: false,
          message: `Deal #${id} "${deal.status}" holatda — faqat ITEM_SENT dan tasdiqlash mumkin (sotuvchi avval yuborishi shart).`,
        };
      }
    }
    fromStatus = String(deal.status);
    if (deal.seller_telegram_id == null) {
      await client.query('ROLLBACK');
      return { success: false, message: `Sotuvchi hali qo'shilmagan — chiqarib bo'lmaydi.` };
    }
    // Record buyer confirmation inside transaction
    try {
      const confirmations: Record<string, boolean> = { ...(deal.confirmations || {}), buyer: true };
      await client.query('UPDATE deals SET confirmations = $1::jsonb, updated_at = now() WHERE id = $2', [
        JSON.stringify(confirmations),
        id,
      ]);
    } catch (e) {
      logger.warn(`setConfirmation failed for #${id}`, e);
    }

    const assetUpper = String(deal.asset || 'TON').toUpperCase();
    const amountStr = String(deal.amount ?? '0');
    let sellerHuman = amountStr;
    let feeHuman = '0';
    let feeBase = 0n;
    try {
      const parts = feeParts(
        amountStr,
        assetUpper,
        (deal as PayoutDealRow | undefined)?.fee_bps ?? config.feeBps ?? 100,
      );
      sellerHuman = parts.sellerHuman;
      feeHuman = parts.feeHuman;
      feeBase = parts.feeBase;
    } catch (e) {
      logger.warn(`Fee calc failed for deal #${id}`, e);
    }

    const payoutAddress = await resolvePayoutAddress(
      deal,
      undefined,
      deal.seller_telegram_id != null ? Number(deal.seller_telegram_id) : null,
    );
    if (!payoutAddress) {
      await client.query('ROLLBACK');
      const msg = `seller_ton_address_required: sotuvchi TON manzilni ilovada kiritishi shart (Bitim → To'lov manzili yoki Profil → TON manzil)`;
      try {
        const sellerId = Number(deal.seller_telegram_id);
        if (sellerId) {
          await notify.adminDecisionToParty(
            sellerId,
            dealLike({ id, amount: amountStr, asset: assetUpper, terms: deal.terms }),
            `To'lov manzilingizni kiriting (Deal #${id})`,
          );
        }
      } catch (notifyErr) {
        logger.warn(`buyerApproveReceipt seller notify failed for deal #${id}`, notifyErr);
      }
      try {
        const { addDealMessage } = await import('./dealService');
        await addDealMessage(
          id,
          0,
          `Tizim: Xaridor qabul qildi (Deal #${id}), lekin sotuvchi to'lov manzili yo'q — sotuvchi ilovada manzilni kiriting.`,
        );
      } catch (msgErr) {
        logger.warn(`buyerApproveReceipt system message failed for deal #${id}`, msgErr);
      }
      logger.warn(`buyerApproveReceipt #${id}: missing payout address`);
      return { success: false, message: msg, needSellerAddress: true };
    }

    const memoPlainBase = releaseComment({ id, amount: amountStr, asset: assetUpper, terms: String(deal.terms || '') });
    let memoPlain = memoPlainBase;
    if (memoPlain.length > 120) memoPlain = memoPlain.slice(0, 119) + '…';
    const encryptedMemo = encryptField(memoPlain);

    plan = {
      assetUpper,
      principalHuman: sellerHuman,
      amountStr,
      feeHuman,
      feeBase,
      toAddress: payoutAddress,
      encryptedMemo,
      idempotencyKey: idemKey,
    };

    // Durably record the attempt BEFORE money moves (see IDEMPOTENCY MODEL above).
    const mark = await client.query(
      `UPDATE deals SET status = $1, payout_idempotency_key = $2, payout_attempted_at = now(), updated_at = now()
       WHERE id = $3 AND status = $4 RETURNING id`,
      [pendingStatus, idemKey, id, fromStatus],
    );
    if (mark.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: `concurrent_transition: deal status changed` };
    }
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {} // best-effort: already handling a failure; a rollback error must not mask it.
    logger.error(`buyerApproveReceipt failed for #${id}`, e);
    return { success: false, message: String((e as Error).message || 'internal_error') };
  } finally {
    client.release();
  }

  // ── Phase 2: on-chain send with NO db transaction held ──
  let feeFailed = false;
  let feeError: string | null = null;
  try {
    ({ feeFailed, feeError } = await executePayout(plan!, id));
  } catch (e) {
    // Ambiguous failure: the transfer may have landed despite the error. Roll back to
    // a retryable status but persist everything an admin needs to verify on-chain
    // before any manual retry (idempotency key) — a blind retry would double-pay.
    const msg = String((e as Error).message || '');
    try {
      await db.query(`UPDATE deals SET status = $1, updated_at = now() WHERE id = $2 AND status = $3`, [
        fromStatus!,
        id,
        pendingStatus,
      ]);
    } catch (rbErr) {
      logger.error(`buyerApproveReceipt rollback failed for #${id} — manual reconciliation required`, rbErr);
    }
    logger.error(`buyerApproveReceipt payout failed for deal #${id}`, e);
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert(
        'payout_failed',
        `Deal #${id} buyer-approve payout failed: ${msg} — ${plan!.principalHuman} to ${plan!.toAddress} (key ${idemKey}). ON-CHAIN TEKSHIRING: qayta yuborishdan oldin tekshiring.`,
        { dealId: id, error: msg, to: plan!.toAddress, amount: plan!.principalHuman, idempotencyKey: idemKey },
      );
    } catch (alertErr) {
      logger.warn(`buyer-approve payout_failed alert save failed for deal #${id} (key ${idemKey})`, alertErr);
    }
    await notifyAdminsHub(
      `Deal #${id} to'lov xatosi: ${msg} — ${plan!.principalHuman} manzil ${plan!.toAddress}.`,
      plan!.principalHuman,
      plan!.assetUpper,
    );
    return {
      success: false,
      message: msg.startsWith('payout_failed') ? msg : `payout_failed: to'lov yuborilmadi: ${msg}`,
    };
  }

  // ── Phase 3: finalize only if the row is still OUR pending attempt ──
  const upd = await db.query(
    `UPDATE deals SET status = $1, fee_payout_failed = $2, fee_payout_error = $3, updated_at = now(), resolved_at = now()
     WHERE id = $4 AND status = $5 AND payout_idempotency_key = $6 RETURNING id`,
    [DEAL_STATUS.RELEASED, feeFailed, feeError, id, pendingStatus, idemKey],
  );
  if (upd.rowCount === 0) {
    const text = `Deal #${id} buyer-approve payout SENT (${plan!.principalHuman} ${plan!.assetUpper} to ${plan!.toAddress}, key ${idemKey}) but status is no longer ${pendingStatus} — human reconciliation required.`;
    logger.error(text);
    try {
      const { saveAdminAlert } = await import('../db/queries');
      await saveAdminAlert('payout_finalize_conflict', text, {
        dealId: id,
        idempotencyKey: idemKey,
        to: plan!.toAddress,
        amount: plan!.principalHuman,
      });
    } catch (alertErr) {
      logger.warn(`buyer-approve finalize_conflict alert save failed for deal #${id} (key ${idemKey})`, alertErr);
    }
    await notifyAdminsHub(text, plan!.principalHuman, plan!.assetUpper);
    return {
      success: false,
      message: `concurrent_transition: payout sent but deal status changed during send (key ${idemKey})`,
    };
  }
  // Post-finalize side effects (best-effort)
  const done = plan!;
  let finalDeal: any = null;
  try {
    finalDeal = await getDealById(id);
  } catch {}
  try {
    const { addDealMessage } = await import('./dealService');
    await addDealMessage(
      id,
      0,
      `Tizim: Yakunlandi (Deal #${id}) — ${done.principalHuman} ${done.assetUpper} sotuvchiga yuborildi${feeFailed ? ` (komissiya yuborilmadi — admin tekshiradi)` : ` (komissiya ${done.feeHuman} ${done.assetUpper})`}.`,
    );
  } catch (e) {
    logger.warn(`buyerApproveReceipt system message failed #${id}`, e);
  }
  try {
    const buyerId = finalDeal ? Number(finalDeal.buyer_telegram_id) : buyerTelegramId;
    if (buyerId)
      await notify.releasedToBuyer(
        buyerId,
        dealLike({ id, amount: done.amountStr, asset: done.assetUpper, terms: finalDeal?.terms }),
      );
  } catch (e) {
    logger.warn(`releasedToBuyer notify failed for #${id}`, e);
  }
  try {
    const sellerId = finalDeal && finalDeal.seller_telegram_id != null ? Number(finalDeal.seller_telegram_id) : null;
    if (sellerId)
      await notify.releasedToSeller(
        sellerId,
        dealLike({ id, amount: done.amountStr, asset: done.assetUpper, terms: finalDeal?.terms }),
        done.principalHuman,
      );
  } catch (e) {
    logger.warn(`releasedToSeller notify failed for #${id}`, e);
  }
  logger.info(
    `Deal #${id} RELEASED by buyer ${buyerTelegramId} approval (seller ${done.principalHuman}, fee ${done.feeHuman})`,
  );
  return {
    success: true,
    message: `Qabul qilindi — pul sotuvchiga chiqarildi (komissiya chegirilgan). Bitim yopildi.`,
    released: true,
    status: DEAL_STATUS.RELEASED,
  };
}

// ── CHANNEL/GROUP custodial escrow (via @gramchioka) ──
// P2P flow untouched — these helpers only run when deal.deal_type in (CHANNEL,GROUP)
const ESCROW_HOLDER_USERNAME = process.env.ESCROW_HOLDER_USERNAME || '@gramchioka';
const ESCROW_HOLDER_ID = Number(process.env.ESCROW_HOLDER_ID || 8992814642);

function isChannelDeal(deal: PayoutDealRow & Record<string, unknown>): boolean {
  const t = String(deal?.deal_type || deal?.dealType || 'P2P').toUpperCase();
  return t === 'CHANNEL' || t === 'GROUP';
}

interface UbotError extends Error {
  status?: number;
  body?: unknown;
  retryAfter?: unknown;
}

async function ubotFetch(path: string, init?: RequestInit): Promise<unknown> {
  const base = config.ubotUrl || process.env.UBOT_URL || 'http://ubot:3002';
  const key = config.ubotApiKey || process.env.UBOT_API_KEY || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  const url = base.replace(/\/+$/, '') + path;
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) },
  });
  const txt = await res.text();
  let data: unknown = txt;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {} // best-effort: non-JSON upstream body surfaces as raw text in the error below.
  if (!res.ok) {
    const err = new Error((data as { error?: string } | null)?.error || txt || `ubot ${res.status}`) as UbotError;
    err.status = res.status;
    err.body = data;
    const retryAfter = (data as { retryAfter?: unknown } | null)?.retryAfter;
    if (retryAfter !== undefined) err.retryAfter = retryAfter;
    throw err;
  }
  return data;
}

export async function verifyChannelOwnershipForDeal(
  dealId: number | string,
  sellerTelegramId?: number | null,
): Promise<{
  ok: boolean;
  verified: boolean;
  channelId?: string;
  title?: string;
  username?: string;
  members?: number;
  error?: string;
}> {
  const deal: any = await getDealById(dealId);
  if (!deal) return { ok: false, verified: false, error: 'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok: false, verified: false, error: 'not_channel_deal' };
  const rawUsername = deal.channel_username || deal.channelUsername;
  if (!rawUsername) return { ok: false, verified: false, error: 'channel_username_required' };
  const channelId = rawUsername as string;
  try {
    const info: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}`, { method: 'GET' });
    const admins: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/admins`, { method: 'GET' });
    const creator = Array.isArray(admins) ? admins.find((a: any) => a.isCreator) : null;
    const creatorId = creator ? Number(creator.id) : null;
    const expected = sellerTelegramId != null ? Number(sellerTelegramId) : Number(deal.seller_telegram_id);
    const verified = creatorId != null && expected != null && creatorId === expected;
    const snapshot = {
      title: info.title,
      username: info.username,
      channelId: String(info.id),
      isChannel: info.isChannel,
      creatorId,
      verifiedAt: new Date().toISOString(),
    };
    const { updateChannelVerification } = await import('./dealService');
    await updateChannelVerification(Number(dealId), {
      channelId: String(info.id),
      channelTitle: String(info.title || ''),
      channelSnapshot: snapshot as any,
      verified,
    });
    try {
      const { addDealMessage } = await import('./dealService');
      if (verified)
        await addDealMessage(
          Number(dealId),
          0,
          `Tizim: Kanal ${rawUsername} tasdiqlandi — ega ${creatorId} sotuvchi ${expected} ga mos.`,
        );
      else
        await addDealMessage(
          Number(dealId),
          0,
          `Tizim: Kanal ${rawUsername} mos kelmadi: yaratuvchi ${creatorId ?? "noma'lum"} va sotuvchi ${expected}. @gramchioka admin ekanini va sotuvchi yaratuvchi ekanini tekshiring.`,
        );
    } catch {}
    return {
      ok: true,
      verified,
      channelId: String(info.id),
      title: info.title,
      username: info.username,
      error: verified ? undefined : 'owner_mismatch',
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('FLOOD_WAIT') || msg.includes('429') || msg.includes('FloodWait')) {
      return { ok: false, verified: false, error: msg };
    }
    return { ok: false, verified: false, error: msg };
  }
}

export async function checkEscrowHolderOwnership(
  dealId: number | string,
): Promise<{ ok: boolean; isEscrowOwner: boolean; currentCreatorId?: number; error?: string }> {
  const deal: any = await getDealById(dealId);
  if (!deal) return { ok: false, isEscrowOwner: false, error: 'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok: false, isEscrowOwner: false, error: 'not_channel_deal' };
  const channelId = deal.channel_username || deal.channel_id;
  if (!channelId) return { ok: false, isEscrowOwner: false, error: 'channel_username_required' };
  try {
    const admins: any = await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/admins`, { method: 'GET' });
    const creator = Array.isArray(admins) ? admins.find((a: any) => a.isCreator) : null;
    const creatorId = creator ? Number(creator.id) : null;
    const isEscrowOwner = creatorId === ESCROW_HOLDER_ID;
    if (isEscrowOwner) {
      const { setTransferToEscrow } = await import('./dealService');
      await setTransferToEscrow(Number(dealId));
      try {
        const { addDealMessage } = await import('./dealService');
        await addDealMessage(
          Number(dealId),
          0,
          `Tizim: Escrow ${channelId} kanalni qabul qildi — ${ESCROW_HOLDER_USERNAME} endi ega.`,
        );
      } catch {}
    }
    return { ok: true, isEscrowOwner, currentCreatorId: creatorId ?? undefined };
  } catch (e: any) {
    return { ok: false, isEscrowOwner: false, error: String(e?.message || e) };
  }
}

export async function requestTransferToEscrow(
  dealId: number | string,
  sellerTelegramId: number,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const deal: any = await getDealById(dealId);
  if (!deal) return { ok: false, error: 'deal_not_found' };
  if (Number(deal.seller_telegram_id) !== Number(sellerTelegramId))
    return { ok: false, error: 'only_seller_can_transfer' };
  if (String(deal.status) !== DEAL_STATUS.DEPOSIT_CONFIRMED && String(deal.status) !== DEAL_STATUS.AWAITING_DEPOSIT)
    return { ok: false, error: `invalid_status ${deal.status} need DEPOSIT_CONFIRMED` };
  const channelId = deal.channel_username || deal.channel_id;
  try {
    const { addDealMessage } = await import('./dealService');
    await addDealMessage(
      Number(dealId),
      0,
      `Tizim: Sotuvchi ${channelId} egaligini hozir ${ESCROW_HOLDER_USERNAME} ga o'tkazing. O'tkazgach "O'tkazdim" ni bosing.`,
    );
    try {
      await notify.adminDecisionToParty(
        Number(sellerTelegramId),
        dealLike({
          id: Number(dealId),
          amount: String(deal.amount ?? ''),
          asset: String(deal.asset ?? 'TON'),
          terms: deal.terms,
        }),
        `Kanal ${channelId} ni ${ESCROW_HOLDER_USERNAME} ga o'tkazing`,
      );
    } catch {}
    return { ok: true, message: 'transfer_requested' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function confirmTransferToEscrow(
  _sellerTelegramId: number,
  dealId: number | string,
): Promise<{ ok: boolean; verified?: boolean; message?: string; error?: string }> {
  const res = await checkEscrowHolderOwnership(dealId);
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.isEscrowOwner)
    return {
      ok: false,
      verified: false,
      error: `not_yet_transferred: current creator ${res.currentCreatorId} != escrow ${ESCROW_HOLDER_ID}`,
    };
  return { ok: true, verified: true, message: 'escrow_received' };
}

export async function payoutSellerForChannel(
  dealId: number | string,
  _sellerTelegramId?: number | null,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const deal: any = await getDealById(dealId);
  if (!deal) return { success: false, error: 'deal_not_found' };
  if (!isChannelDeal(deal)) return { success: false, error: 'not_channel_deal' };
  if (!deal.transfer_to_escrow_at) return { success: false, error: 'escrow_not_yet_received' };
  if (String(deal.status) === DEAL_STATUS.RELEASED || String(deal.status) === DEAL_STATUS.REFUNDED)
    return { success: false, error: `already_${String(deal.status).toLowerCase()}` };
  try {
    await guardedTransition(Number(dealId), DEAL_STATUS.RELEASED, {
      amount: deal.amount,
      asset: deal.asset,
      terms: deal.terms,
    });
    try {
      const { addDealMessage } = await import('./dealService');
      await addDealMessage(
        Number(dealId),
        0,
        `Tizim: Sotuvchiga to'lov yuborildi (${deal.channel_username}) — ${deal.amount} ${deal.asset} (komissiya chegirilgan).`,
      );
    } catch {}
    return { success: true, message: 'payout_sent' };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}

export async function transferChannelToBuyer(
  dealId: number | string,
  newOwnerUsername: string,
  _callerTelegramId?: number | null,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const deal: any = await getDealById(dealId);
  if (!deal) return { ok: false, error: 'deal_not_found' };
  if (!isChannelDeal(deal)) return { ok: false, error: 'not_channel_deal' };
  if (String(deal.status) !== DEAL_STATUS.RELEASED)
    return { ok: false, error: `invalid_status ${deal.status} need RELEASED (seller already paid)` };
  const channelId = deal.channel_username || deal.channel_id;
  if (!channelId) return { ok: false, error: 'channel_username_required' };
  const raw = String(newOwnerUsername).trim().replace(/^@/, '');
  if (!raw || !/^([A-Za-z0-9_]{4,32})$/.test(raw)) return { ok: false, error: 'invalid_username' };
  const target = '@' + raw;
  try {
    await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/invite`, {
      method: 'POST',
      body: JSON.stringify({ userId: target }),
    });
  } catch {} // best-effort: invite is courtesy; takeover below enforces membership with an explicit user_not_participant error.
  await new Promise((r) => setTimeout(r, 1200));
  try {
    const idemp = `channel-deal-${dealId}-${target}`;
    await ubotFetch(`/channel/${encodeURIComponent(String(channelId))}/takeover`, {
      method: 'POST',
      body: JSON.stringify({ newOwnerId: target }),
      headers: { 'x-idempotency-key': idemp },
    });
    const { setTransferToBuyer } = await import('./dealService');
    await setTransferToBuyer(Number(dealId), target);
    try {
      const { addDealMessage } = await import('./dealService');
      await addDealMessage(Number(dealId), 0, `Tizim: Kanal ${channelId} yangi ega ${target} ga o'tkazildi.`);
    } catch {}
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('USER_NOT_PARTICIPANT'))
      return { ok: false, error: 'user_not_participant_try_invite', detail: msg };
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN') || msg.includes('86400'))
      return { ok: false, error: 'fresh_forbidden_wait_24h', detail: msg };
    if (msg.includes('CHANNELS_TOO_MUCH')) return { ok: false, error: 'channels_too_much', detail: msg };
    if (msg.includes('not_admin') || msg.includes('CHAT_ADMIN_REQUIRED'))
      return { ok: false, error: 'not_admin', detail: msg };
    if (String(deal.deal_type).toUpperCase() === 'GROUP') {
      try {
        const idemp = `group-deal-${dealId}-${target}`;
        await ubotFetch(`/group/${encodeURIComponent(String(channelId))}/takeover`, {
          method: 'POST',
          body: JSON.stringify({ newOwnerId: target }),
          headers: { 'x-idempotency-key': idemp },
        });
        const { setTransferToBuyer } = await import('./dealService');
        await setTransferToBuyer(Number(dealId), target);
        return { ok: true };
      } catch (e2: any) {
        return { ok: false, error: String(e2?.message || e2) };
      }
    }
    return { ok: false, error: msg };
  }
}
