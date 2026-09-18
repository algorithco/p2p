import { client } from './tonClient';
import { Address, Cell } from '@ton/core';
import type { Transaction } from '@ton/core';
import { updateDealStatus, dealLike } from '../services/dealService';
import { db } from '../db/queries';
import { fromBaseUnits, dealPricing } from '../utils/money';
import {
  parseDepositComment,
  parseDepositToken,
  isDepositTokenFormat,
  parseTonComment,
  parseJettonForwardComment,
} from '../utils/comments';
import { decryptCommentString } from '../utils/tonPayload';
import { encryptField } from '../utils/encryption';
import { config } from '../config';
import { sendTon, sendJetton } from './signerClient';
import * as notify from '../bot/notify';
import logger from '../logger';

const JETTON_TRANSFER_NOTIFICATION_OP = 0x7362d09c;

const monitoredAddresses = new Set<string>();
/** Per-address cursor so only NEW transactions (higher lt) are processed. */
const cursors = new Map<string, { lt: string; hash: string }>();

// Expected jetton-wallet cache: (master|paymentAddr) -> wallet raw address.
// Derivation is deterministic on-chain data — cache forever (process lifetime).
const jettonWalletCache = new Map<string, string>();
let lastJettonMasterWarnAt = 0;

/**
 * P0 fake-jetton defense: resolve the payment address's jetton wallet from the
 * CONFIGURED master. A transfer_notification for a real USDT deposit always
 * arrives with inMessage.src == this wallet. A notification minted through an
 * attacker's fake master arrives from a DIFFERENT wallet and must never
 * confirm a deal. Returns null when verification is impossible (master
 * unconfigured or RPC failure) — callers fail OPEN with a loud warn in that
 * case (status quo), but fail CLOSED on positive mismatch.
 */
export async function expectedJettonWalletForPayment(paymentAddr: string): Promise<Address | null> {
  const masterRaw = (config.jettonMasterAddress || config.usdtJettonAddress || '').trim();
  if (!masterRaw) {
    const now = Date.now();
    if (now - lastJettonMasterWarnAt > 5 * 60 * 1000) {
      lastJettonMasterWarnAt = now;
      logger.warn(
        'Listener: JETTON_MASTER_ADDRESS/USDT_JETTON_ADDRESS unset — jetton master forgery check DISABLED. Set the master to stop fake-master notifications confirming USDT deposits.',
      );
    }
    return null;
  }
  let master: Address;
  let pay: Address;
  try {
    master = Address.parse(masterRaw);
    pay = Address.parse(paymentAddr);
  } catch {
    return null;
  }
  const key = `${master.toRawString()}|${pay.toRawString()}`;
  const cached = jettonWalletCache.get(key);
  if (cached) {
    try {
      return Address.parse(cached);
    } catch {
      jettonWalletCache.delete(key);
    }
  }
  try {
    const { computeJettonWalletAddress } = await import('./jettonUtils');
    const w = await computeJettonWalletAddress(master, pay);
    if (!w) return null;
    jettonWalletCache.set(key, w.toRawString());
    return w;
  } catch {
    // RPC blip (toncenter 429s happen): do NOT strand real deposits on a
    // failed derivation — skip this check for now, keep polling.
    return null;
  }
}

/** True when a knowable buyer wallet expectation exists for sender checks. */
async function hasKnownSenderExpectation(deal: DealRow): Promise<boolean> {
  if (deal.buyer_expected_address && String(deal.buyer_expected_address).trim()) return true;
  if (deal.buyer_telegram_id == null) return false;
  try {
    const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [
      Number(deal.buyer_telegram_id),
    ]);
    return !!(res.rows[0]?.ton_address && String(res.rows[0].ton_address).trim());
  } catch {
    return false;
  }
}

/**
 * Legacy escrow#<id> memos are guessable (sequential ids). Deals that were
 * issued an unguessable deposit_token must use it: a legacy memo on such a
 * deal is a stale client or a forgery probe. Confirm only when the sender
 * provably matches a KNOWN buyer expectation, otherwise hold for review.
 * Returns true when the deposit must be held (caller alerts + returns).
 */
async function holdLegacyMemoOnTokenDeal(
  deal: DealRow,
  src: Address | null,
  txHash: string,
  amountHuman: string,
  asset: string,
  addr: string,
): Promise<boolean> {
  const tok = deal.deposit_token ? String(deal.deposit_token).trim().toLowerCase() : '';
  if (!tok || !isDepositTokenFormat(tok)) return false; // pre-token deal: legacy path unchanged
  let match = false;
  if (src) {
    try {
      if (await hasKnownSenderExpectation(deal)) match = !(await isSenderMismatch(deal, src));
    } catch {
      match = false;
    }
  }
  if (match) return false;
  const msg = `Legacy memo hold Deal #${deal.id}: escrow#${deal.id} used on a token-issued deal without proven sender — flagged for manual review, NOT auto-confirmed`;
  logger.warn(msg);
  try {
    const { saveAdminAlert } = await import('../db/queries');
    await saveAdminAlert('legacy_memo_hold', msg, {
      dealId: deal.id,
      txHash,
      amount: amountHuman,
      asset,
      src: src ? src.toString() : null,
    });
  } catch {}
  try {
    await unknownToAdminsAndSave({
      amount: amountHuman,
      asset,
      address: addr,
      memo: `Legacy memo hold Deal #${deal.id} — manual review required`,
    });
  } catch {}
  return true;
}

async function loadPersistedCursors() {
  try {
    const res = await db.query('SELECT address, lt, hash FROM listener_cursors');
    for (const r of res.rows) {
      cursors.set(String(r.address), { lt: String(r.lt), hash: String(r.hash) });
    }
    if (res.rows.length) logger.info(`Listener: loaded ${res.rows.length} persisted cursors`);
  } catch (e) {
    logger.warn('Listener: could not load persisted cursors', e);
  }
}

async function persistCursor(address: string, lt: string, hash: string) {
  try {
    await db.query(
      `INSERT INTO listener_cursors (address, lt, hash, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (address) DO UPDATE SET lt = EXCLUDED.lt, hash = EXCLUDED.hash, updated_at = now()`,
      [address, lt, hash],
    );
  } catch (e) {
    logger.warn(`Listener: could not persist cursor for ${address}`, e);
  }
}

async function seedMonitoredAddressesFromDB() {
  try {
    const res = await db.query(
      `SELECT DISTINCT payment_address FROM deals WHERE status = 'AWAITING_DEPOSIT' AND payment_address IS NOT NULL AND payment_address <> ''`,
    );
    let added = 0;
    for (const r of res.rows) {
      const addr = String(r.payment_address).trim();
      if (addr && !monitoredAddresses.has(addr)) {
        monitoredAddresses.add(addr);
        added++;
      }
    }
    if (added) logger.info(`Listener: seeded ${added} monitored addresses from awaiting deals`);
  } catch (e) {
    logger.warn('Listener: could not seed monitored addresses', e);
  }
}

export function addAddressToMonitor(address: string) {
  const normalized = address.trim();
  if (!normalized || monitoredAddresses.has(normalized)) return;
  monitoredAddresses.add(normalized);
  // First poll processes the fetched window (bounded pages): guarded
  // confirm updates make replays safe, while skipping would drop fast
  // deposits that landed between deal creation and the first tick.
  logger.info(`Listener: added ${normalized} to monitor`);
}

export interface DealRow {
  id: number;
  asset: string | null;
  amount: string | null;
  fee_bps: number | null;
  buyer_telegram_id: number | null;
  seller_telegram_id: number | null;
  payment_address: string | null;
  terms: string | null;
  deposit_token: string | null;
  buyer_expected_address: string | null;
}

export async function findAwaitingDealById(dealId: number, paymentAddress?: string): Promise<DealRow | null> {
  const res = await db.query(
    `SELECT id, asset, amount, fee_bps, buyer_telegram_id, seller_telegram_id, payment_address, terms, deposit_token, buyer_expected_address
     FROM deals WHERE id = $1 AND status = $2 LIMIT 1`,
    [dealId, 'AWAITING_DEPOSIT'],
  );
  const row = res.rows[0] as DealRow | undefined;
  if (!row) return null;
  if (paymentAddress && row.payment_address && row.payment_address !== paymentAddress) {
    try {
      if (Address.parse(row.payment_address).toRawString() !== Address.parse(paymentAddress).toRawString()) {
        return null;
      }
    } catch {
      // best-effort: unparsable address falls back to plain string compare.
      if (row.payment_address !== paymentAddress) return null;
    }
  }
  return row;
}

export async function findAwaitingDealByToken(token: string, paymentAddress?: string): Promise<DealRow | null> {
  const t = String(token || '')
    .trim()
    .toLowerCase();
  if (!isDepositTokenFormat(t)) return null;
  const res = await db.query(
    `SELECT id, asset, amount, fee_bps, buyer_telegram_id, seller_telegram_id, payment_address, terms, deposit_token, buyer_expected_address
     FROM deals WHERE deposit_token = $1 AND status = $2 LIMIT 1`,
    [t, 'AWAITING_DEPOSIT'],
  );
  const row = res.rows[0] as DealRow | undefined;
  if (!row) return null;
  if (paymentAddress && row.payment_address && row.payment_address !== paymentAddress) {
    try {
      if (Address.parse(row.payment_address).toRawString() !== Address.parse(paymentAddress).toRawString()) {
        return null;
      }
    } catch {
      if (row.payment_address !== paymentAddress) return null;
    }
  }
  return row;
}

/**
 * P0-1 (b): sender verification.
 * If buyer_expected_address is set (captured at deal creation or from users.ton_address),
 * then deposit src must match it; otherwise flag for manual review and do NOT auto-confirm.
 * Returns true if mismatch (should NOT auto-confirm), false if ok or no expectation.
 */
export async function isSenderMismatch(deal: DealRow, srcAddress: Address | null): Promise<boolean> {
  if (!srcAddress) return false; // cannot verify without sender
  let expected: string | null =
    (deal as unknown as { buyer_expected_address?: string | null }).buyer_expected_address || null;
  if (!expected && deal.buyer_telegram_id != null) {
    try {
      const res = await db.query('SELECT ton_address FROM users WHERE telegram_id = $1 LIMIT 1', [
        Number(deal.buyer_telegram_id),
      ]);
      if (res.rows[0]?.ton_address) expected = String(res.rows[0].ton_address).trim();
    } catch {
      // best-effort: DB failure means we cannot verify — do not block deposit
      return false;
    }
  }
  if (!expected) return false; // no expectation knowable — residual trust assumption documented
  try {
    const expectedRaw = Address.parse(expected).toRawString();
    const srcRaw = srcAddress.toRawString();
    return expectedRaw !== srcRaw;
  } catch {
    // if expected address unparsable, do not block
    return false;
  }
}

export function expectedForDeal(deal: DealRow): bigint {
  // Single source: same pricing the deal creator, the payout path and the UI see.
  return dealPricing(
    String(deal.amount ?? '0'),
    String(deal.asset ?? 'TON'),
    ((deal as { fee_bps?: unknown }).fee_bps as number | undefined) ?? config.feeBps ?? 100,
  ).expectedDeposit;
}

/**
 * P1-4: check on-chain for a missed deposit before auto-close.
 * Queries recent transactions for the deal's payment_address and looks for a memo
 * matching deposit_token (preferred) or legacy escrow#<id> with amount >= expectedDeposit.
 * Returns found flag + txHash for audit.
 * Used by the 10h scheduler to avoid silently stranding real funds.
 */
export async function checkMissedDepositOnChain(deal: DealRow): Promise<{
  found: boolean;
  txHash?: string;
  amount?: bigint;
  src?: string;
  /** Raw inMessage.src (notifying jetton wallet for jetton deposits) for master verification. */
  txSrc?: string;
  /** 'TON' | 'JETTON' — which leg matched, so callers apply the right checks. */
  kind?: 'TON' | 'JETTON';
  /** 'token' | 'legacy' — whether the unguessable deposit_token or the guessable escrow#<id> memo matched. */
  via?: 'token' | 'legacy';
}> {
  const payAddr = String(deal.payment_address || '').trim();
  if (!payAddr) return { found: false };
  try {
    const { Address } = await import('@ton/core');
    const addr = Address.parse(payAddr);
    // Wider window than the live poll: expiry runs every 5 min and must not
    // miss a deposit that fell outside the latest 30 on the shared wallet.
    const txs = await fetchRecentTransactions(addr, null, 3);
    const expected = expectedForDeal(deal);
    const tokenLower = deal.deposit_token ? String(deal.deposit_token).trim().toLowerCase() : null;
    for (const tx of txs) {
      const hash = tx.hash().toString('hex');
      if (!tx.inMessage) continue;
      // Jetton notification path first (like handleTransaction)
      let forwardComment: string | null = null;
      let jettonAmount: bigint | null = null;
      let jettonSender: string | null = null;
      try {
        const parsed: { queryId: bigint; amount: bigint; sender: Address | null } | null = (() => {
          try {
            const cs = tx.inMessage!.body.beginParse();
            const op = cs.loadUint(32);
            if (op !== JETTON_TRANSFER_NOTIFICATION_OP) return null;
            const q = cs.loadUintBig(64);
            const amt = cs.loadCoins();
            const snd = cs.loadAddress();
            return { queryId: q, amount: amt, sender: snd };
          } catch {
            return null;
          }
        })();
        if (parsed) {
          jettonAmount = parsed.amount;
          jettonSender = parsed.sender ? parsed.sender.toString() : null;
          try {
            const bodySlice = tx.inMessage!.body.beginParse();
            bodySlice.loadUint(32);
            bodySlice.loadUintBig(64);
            bodySlice.loadCoins();
            bodySlice.loadAddress();
            if (bodySlice.remainingBits > 0 || bodySlice.remainingRefs > 0) {
              try {
                if (bodySlice.remainingRefs > 0) {
                  const fwd = bodySlice.loadRef().beginParse();
                  forwardComment = parseTonComment(fwd) ?? parseJettonForwardComment(fwd);
                } else {
                  forwardComment = parseTonComment(bodySlice) ?? parseJettonForwardComment(bodySlice);
                }
              } catch {
                forwardComment = null;
              }
            }
          } catch {
            forwardComment = null;
          }
          const dec = decryptCommentString(forwardComment) ?? forwardComment ?? '';
          const raw = forwardComment ?? '';
          const tok = parseDepositToken(dec) ?? parseDepositToken(raw);
          const legacyId = parseDepositComment(dec) ?? parseDepositComment(raw);
          const viaToken = !!(tok && tokenLower && tok.toLowerCase() === tokenLower);
          const matches = viaToken || (legacyId != null && legacyId === deal.id);
          if (matches && jettonAmount != null && jettonAmount >= expected) {
            let txSrc: string | undefined;
            try {
              const s: unknown = (tx.inMessage!.info as unknown as { src?: unknown })?.src;
              if (s) txSrc = String((s as { toString?: () => string }).toString?.() ?? s);
            } catch {
              txSrc = undefined;
            }
            return {
              found: true,
              txHash: hash,
              amount: jettonAmount,
              src: jettonSender || undefined,
              txSrc,
              kind: 'JETTON',
              via: viaToken ? 'token' : 'legacy',
            };
          }
          continue;
        }
      } catch {
        // fall through to TON check
      }
      if (tx.inMessage.info.type === 'internal') {
        const value = tx.inMessage.info.value.coins;
        if (value < expected) continue;
        let comment: string | null = null;
        try {
          comment = parseTonComment(tx.inMessage.body);
        } catch {
          comment = null;
        }
        const dec = decryptCommentString(comment) ?? comment ?? '';
        const raw = comment ?? '';
        const tok = parseDepositToken(dec) ?? parseDepositToken(raw);
        const legacyId = parseDepositComment(dec) ?? parseDepositComment(raw);
        const viaToken = !!(tok && tokenLower && tok.toLowerCase() === tokenLower);
        const matches = viaToken || (legacyId != null && legacyId === deal.id);
        if (matches && value >= expected) {
          const srcStr = tx.inMessage.info.src ? tx.inMessage.info.src.toString() : undefined;
          return {
            found: true,
            txHash: hash,
            amount: value,
            src: srcStr,
            kind: 'TON',
            via: viaToken ? 'token' : 'legacy',
          };
        }
      }
    }
  } catch (e) {
    logger.warn(`checkMissedDeposit for deal #${deal.id} failed`, e);
    return { found: false };
  }
  return { found: false };
}

async function postChatSystemMessage(dealId: number, text: string) {
  try {
    const { addDealMessage } = await import('../services/dealService');
    await addDealMessage(dealId, 0, text);
  } catch (e) {
    logger.warn(`Could not post chat system message for deal #${dealId}`, e);
  }
}

async function unknownToAdminsAndSave(info: {
  amount: string | number;
  asset: string;
  address: string;
  memo: string;
}): Promise<void> {
  try {
    await notify.unknownDepositToAdmins(info);
  } catch (e) {
    logger.warn('unknownDepositToAdmins failed', e);
  }
  try {
    const { saveAdminAlert } = await import('../db/queries');
    const text = `Noma'lum to'lov: ${info.amount} ${info.asset} — ${info.memo}`.slice(0, 500);
    await saveAdminAlert('unknown_deposit', text, {
      amount: String(info.amount),
      asset: info.asset,
      address: info.address,
      memo: info.memo,
    });
  } catch (alertErr) {
    // P3: Telegram notify above already attempted; log alert-table failure with memo context.
    logger.warn(`unknown_deposit alert save failed (${info.amount} ${info.asset} ${info.memo.slice(0, 80)})`, alertErr);
  }
}

async function notifySellerDeposit(deal: DealRow) {
  if (deal.seller_telegram_id == null) return;
  try {
    await notify.depositToSeller(Number(deal.seller_telegram_id), dealLike(deal));
  } catch (e) {
    logger.warn(`depositToSeller notify failed for deal #${deal.id}`, e);
  }
  void postChatSystemMessage(
    deal.id,
    `Tizim: To'lov qabul qilindi (Deal #${deal.id}) — ${String(deal.amount)} ${String(deal.asset)}.`,
  );
}

export async function processTonDeposit(
  addr: string,
  src: Address | null,
  value: bigint,
  txHash: string,
  comment: string | null,
) {
  const decrypted = decryptCommentString(comment) ?? comment ?? '';
  const raw = comment ?? '';
  // P0-1: try unguessable token first, then legacy escrow#<id> for backward compat
  const token = parseDepositToken(decrypted) ?? parseDepositToken(raw);
  let deal: DealRow | null = null;
  let dealId: number | null = null;
  if (token) {
    deal = await findAwaitingDealByToken(token, addr);
    if (!deal) {
      let human = '';
      try {
        human = fromBaseUnits(value, 'TON');
      } catch {
        human = value.toString();
      }
      logger.warn(`TON deposit token ${token} to ${addr} — no AWAITING_DEPOSIT deal, ignoring`);
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'TON',
          address: addr,
          memo: decrypted || raw || token,
        });
      } catch {}
      return;
    }
  } else {
    dealId = parseDepositComment(decrypted) ?? parseDepositComment(raw);
    if (dealId == null) {
      let human = '';
      try {
        human = fromBaseUnits(value, 'TON');
      } catch {
        human = value.toString();
      }
      logger.warn(
        `Unknown TON deposit to ${addr} value ${value} memo "${decrypted || raw || '(memosiz)'}" — no memo match`,
      );
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'TON',
          address: addr,
          memo: decrypted || raw || '(memosiz)',
        });
      } catch (e) {
        logger.warn('unknownDepositToAdmins failed', e);
      }
      return;
    }
    const legacyDeal = await findAwaitingDealById(dealId, addr);
    if (!legacyDeal) {
      let human = '';
      try {
        human = fromBaseUnits(value, 'TON');
      } catch {
        human = value.toString();
      }
      logger.warn(`TON deposit memo escrow#${dealId} to ${addr} — no AWAITING_DEPOSIT deal, ignoring`);
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'TON',
          address: addr,
          memo: decrypted || raw || `escrow#${dealId}`,
        });
      } catch {}
      return;
    }
    deal = legacyDeal;
    let legacyHuman = value.toString();
    try {
      legacyHuman = fromBaseUnits(value, 'TON');
    } catch {}
    if (await holdLegacyMemoOnTokenDeal(deal, src, txHash, legacyHuman, 'TON', addr)) return;
  }

  // P0-1 (b): sender verification — if buyer expected address is known, src must match
  if (src) {
    try {
      if (await isSenderMismatch(deal, src)) {
        let human = '';
        try {
          human = fromBaseUnits(value, 'TON');
        } catch {
          human = value.toString();
        }
        const msg = `Sender mismatch Deal #${deal.id}: expected ${deal.buyer_expected_address || 'buyer wallet'} but got ${src.toString()} — flagged for manual review, NOT auto-confirmed`;
        logger.warn(msg);
        try {
          const { saveAdminAlert } = await import('../db/queries');
          await saveAdminAlert('sender_mismatch', msg, {
            dealId: deal.id,
            expected: deal.buyer_expected_address || null,
            actual: src.toString(),
            amount: human,
            asset: 'TON',
            txHash,
          });
        } catch {}
        try {
          await unknownToAdminsAndSave({
            amount: human,
            asset: 'TON',
            address: addr,
            memo: `Sender mismatch Deal #${deal.id}: expected buyer wallet but got ${src.toString()} — manual review required`,
          });
        } catch {}
        return;
      }
    } catch (e) {
      logger.warn(`sender check failed for deal #${deal.id}`, e);
    }
  }

  const assetUpper = String(deal.asset ?? 'TON').toUpperCase();
  if (assetUpper !== 'TON') {
    let human = '';
    try {
      human = fromBaseUnits(value, 'TON');
    } catch {
      human = value.toString();
    }
    logger.warn(`Deal #${deal.id} expects ${assetUpper} but got TON tx — ignoring`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'TON',
        address: addr,
        memo: `Noto'g'ri aktiv Deal #${deal.id}: ${decrypted || raw}`,
      });
    } catch {}
    return;
  }

  let expected: bigint;
  try {
    expected = expectedForDeal(deal);
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute expected (${(err as Error).message})`);
    return;
  }

  if (value === expected) {
    const ok = await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash, ['AWAITING_DEPOSIT']);
    if (!ok) {
      logger.warn(`Deal #${deal.id}: deposit arrived but deal no longer AWAITING_DEPOSIT — ignoring (no resurrect)`);
      return;
    }
    logger.info(`Deal #${deal.id}: TON deposit exact ${value} confirmed`);
    await notifySellerDeposit(deal);
    return;
  }

  if (value > expected) {
    const excess = value - expected;
    const ok = await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash, ['AWAITING_DEPOSIT']);
    if (!ok) {
      logger.warn(`Deal #${deal.id}: overpay arrived but deal no longer AWAITING_DEPOSIT — ignoring (no resurrect)`);
      return;
    }
    logger.info(
      `Deal #${deal.id}: TON overpay got ${value} expected ${expected}, excess ${excess} — confirming + refunding`,
    );
    if (src) {
      try {
        const excessHuman = fromBaseUnits(excess, 'TON');
        const memoEnc = encryptField(`Ortiqcha qaytarildi Deal #${deal.id}`);
        // Per-tx idempotency: cursor replay / poll overlap re-processing the
        // same tx must not refund twice (signer dedupes same-key replays).
        await sendTon({
          to: src.toString(),
          value: excessHuman,
          comment: memoEnc,
          bounce: false,
          idempotencyKey: `overpay-refund:${deal.id}:${txHash}`,
        });
        logger.info(`Deal #${deal.id}: refunded excess ${excessHuman} TON to ${src.toString()}`);
      } catch (e) {
        logger.warn(`Deal #${deal.id}: excess refund failed`, e);
        try {
          let exHuman = excess.toString();
          try {
            exHuman = fromBaseUnits(excess, 'TON');
          } catch {}
          await unknownToAdminsAndSave({
            amount: exHuman,
            asset: 'TON',
            address: addr,
            memo: `Qaytarish xatosi Deal #${deal.id}: ${(e as Error).message}`,
          });
        } catch {}
      }
    } else {
      logger.warn(`Deal #${deal.id}: overpay but no sender address — refund skipped`);
    }
    await notifySellerDeposit(deal);
    return;
  }

  // Underpay — do NOT confirm
  let gotHuman = value.toString();
  let expHuman = expected.toString();
  try {
    gotHuman = fromBaseUnits(value, 'TON');
    expHuman = fromBaseUnits(expected, 'TON');
  } catch {}
  logger.info(`Deal #${deal.id}: TON underpay got ${value} expected ${expected} — waiting`);
  try {
    await unknownToAdminsAndSave({
      amount: gotHuman,
      asset: 'TON',
      address: addr,
      memo: `Kam to'lov Deal #${deal.id}: keldi ${gotHuman} kutilgan ${expHuman} memo ${decrypted || raw}`,
    });
  } catch {}
  // P5-15: capture underpay src for auto-refund after timeout.
  // History ARRAY (not a single object): several partial payments must each be
  // refunded — last-write-wins would strand all but the latest sender's funds.
  if (src) {
    try {
      await db.query(
        `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || jsonb_build_object('underpay_history', COALESCE(confirmations->'underpay_history','[]'::jsonb) || jsonb_build_object('amount', $1::text, 'src', $2::text, 'at', now()::text, 'tx', $3::text, 'refunded', false)) WHERE id = $4`,
        [gotHuman, src.toString(), txHash, deal.id],
      );
    } catch {}
  }
}

interface JettonNotification {
  queryId: bigint;
  amount: bigint;
  sender: Address | null;
}

function parseJettonNotification(body: Cell): JettonNotification | null {
  try {
    const cs = body.beginParse();
    const op = cs.loadUint(32);
    if (op !== JETTON_TRANSFER_NOTIFICATION_OP) return null;
    const queryId = cs.loadUintBig(64);
    const amount = cs.loadCoins();
    const sender = cs.loadAddress();
    return { queryId, amount, sender };
  } catch {
    return null;
  }
}

export async function processJettonDeposit(
  addr: string,
  note: JettonNotification,
  forwardComment: string | null,
  txHash: string,
  /** Raw inMessage.src (the notifying jetton wallet). Absent in unit tests — check skipped then. */
  txSrc?: string | null,
) {
  const decrypted = decryptCommentString(forwardComment) ?? forwardComment ?? '';
  const raw = forwardComment ?? '';
  const token = parseDepositToken(decrypted) ?? parseDepositToken(raw);
  let deal: DealRow | null = null;
  let dealId: number | null = null;
  if (token) {
    deal = await findAwaitingDealByToken(token, addr);
    if (!deal) {
      let human = note.amount.toString();
      try {
        human = fromBaseUnits(note.amount, 'USDT');
      } catch {}
      logger.warn(`USDT deposit token ${token} to ${addr} — no AWAITING_DEPOSIT deal`);
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'USDT',
          address: addr,
          memo: decrypted || raw || token,
        });
      } catch {}
      return;
    }
  } else {
    dealId = parseDepositComment(decrypted) ?? parseDepositComment(raw);
    if (dealId == null) {
      let human = note.amount.toString();
      try {
        human = fromBaseUnits(note.amount, 'USDT');
      } catch {}
      logger.warn(`Unknown USDT deposit to ${addr} amount ${note.amount} forward "${decrypted || raw || '(memosiz)'}"`);
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'USDT',
          address: addr,
          memo: decrypted || raw || '(memosiz)',
        });
      } catch {}
      return;
    }
    const legacyDeal = await findAwaitingDealById(dealId, addr);
    if (!legacyDeal) {
      let human = note.amount.toString();
      try {
        human = fromBaseUnits(note.amount, 'USDT');
      } catch {}
      logger.warn(`USDT deposit forward escrow#${dealId} to ${addr} — no AWAITING_DEPOSIT deal`);
      try {
        await unknownToAdminsAndSave({
          amount: human,
          asset: 'USDT',
          address: addr,
          memo: decrypted || raw || `escrow#${dealId}`,
        });
      } catch {}
      return;
    }
    deal = legacyDeal;
    let legacyJHuman = note.amount.toString();
    try {
      legacyJHuman = fromBaseUnits(note.amount, 'USDT');
    } catch {}
    if (await holdLegacyMemoOnTokenDeal(deal, note.sender, txHash, legacyJHuman, 'USDT', addr)) return;
  }

  // P0 fake-jetton defense: the notification must arrive from the payment
  // address's jetton wallet derived from the CONFIGURED master. Mismatch =
  // forged notification via attacker's master — never confirm.
  if (txSrc) {
    try {
      const expectedWallet = await expectedJettonWalletForPayment(addr);
      if (expectedWallet) {
        let same = false;
        try {
          same = Address.parse(txSrc).toRawString() === expectedWallet.toRawString();
        } catch {
          same = false;
        }
        if (!same) {
          let jHuman = note.amount.toString();
          try {
            jHuman = fromBaseUnits(note.amount, 'USDT');
          } catch {}
          const msg = `Jetton master mismatch Deal #${deal.id}: notification src ${txSrc} != expected wallet ${expectedWallet.toString()} — forged master suspected, NOT auto-confirmed`;
          logger.warn(msg);
          try {
            const { saveAdminAlert } = await import('../db/queries');
            await saveAdminAlert('jetton_master_mismatch', msg, {
              dealId: deal.id,
              expected: expectedWallet.toString(),
              actual: txSrc,
              amount: jHuman,
              asset: 'USDT',
              txHash,
            });
          } catch {}
          try {
            await unknownToAdminsAndSave({
              amount: jHuman,
              asset: 'USDT',
              address: addr,
              memo: `Jetton master mismatch Deal #${deal.id} — manual review required`,
            });
          } catch {}
          return;
        }
      }
    } catch (e) {
      logger.warn(`jetton master check failed for deal #${deal.id}`, e);
    }
  }

  // P0-1 (b): sender verification for jetton (note.sender is on-chain sender)
  if (note.sender) {
    try {
      if (await isSenderMismatch(deal, note.sender)) {
        let human = note.amount.toString();
        try {
          human = fromBaseUnits(note.amount, 'USDT');
        } catch {}
        const msg = `Jetton sender mismatch Deal #${deal.id}: expected ${deal.buyer_expected_address || 'buyer wallet'} but got ${note.sender.toString()} — flagged for manual review, NOT auto-confirmed`;
        logger.warn(msg);
        try {
          const { saveAdminAlert } = await import('../db/queries');
          await saveAdminAlert('sender_mismatch', msg, {
            dealId: deal.id,
            expected: deal.buyer_expected_address || null,
            actual: note.sender.toString(),
            amount: human,
            asset: 'USDT',
            txHash,
          });
        } catch {}
        try {
          await unknownToAdminsAndSave({
            amount: human,
            asset: 'USDT',
            address: addr,
            memo: `Jetton sender mismatch Deal #${deal.id}: expected buyer wallet but got ${note.sender.toString()} — manual review required`,
          });
        } catch {}
        return;
      }
    } catch (e) {
      logger.warn(`jetton sender check failed for deal #${deal.id}`, e);
    }
  }

  const assetUpper = String(deal.asset ?? 'USDT').toUpperCase();
  if (assetUpper !== 'USDT') {
    let human = note.amount.toString();
    try {
      human = fromBaseUnits(note.amount, assetUpper);
    } catch {
      try {
        human = fromBaseUnits(note.amount, 'USDT');
      } catch {}
    }
    logger.warn(`Deal #${deal.id} expects ${assetUpper} but got USDT jetton — ignoring`);
    try {
      await unknownToAdminsAndSave({
        amount: human,
        asset: 'USDT',
        address: addr,
        memo: `Noto'g'ri aktiv Deal #${deal.id}: ${decrypted || raw}`,
      });
    } catch {}
    return;
  }

  let expected: bigint;
  try {
    expected = expectedForDeal(deal);
  } catch (err) {
    logger.warn(`Deal #${deal.id}: cannot compute expected (${(err as Error).message})`);
    return;
  }

  if (note.amount === expected) {
    const ok = await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash, ['AWAITING_DEPOSIT']);
    if (!ok) {
      logger.warn(`Deal #${deal.id}: USDT deposit arrived but deal no longer AWAITING_DEPOSIT — ignoring`);
      return;
    }
    logger.info(`Deal #${deal.id}: USDT deposit exact ${note.amount} confirmed`);
    await notifySellerDeposit(deal);
    return;
  }

  if (note.amount > expected) {
    const excess = note.amount - expected;
    const ok = await updateDealStatus(deal.id, 'DEPOSIT_CONFIRMED', txHash, ['AWAITING_DEPOSIT']);
    if (!ok) {
      logger.warn(`Deal #${deal.id}: USDT overpay arrived but deal no longer AWAITING_DEPOSIT — ignoring`);
      return;
    }
    logger.info(`Deal #${deal.id}: USDT overpay got ${note.amount} expected ${expected}, excess ${excess}`);
    const senderAddr = note.sender ? note.sender.toString() : null;
    if (senderAddr) {
      try {
        const jettonMaster = config.jettonMasterAddress || config.usdtJettonAddress;
        if (!jettonMaster) throw new Error('jetton_master_not_configured');
        const excessHuman = fromBaseUnits(excess, assetUpper);
        const memoEnc = encryptField(`Ortiqcha qaytarildi Deal #${deal.id}`);
        await sendJetton({
          jettonMasterAddress: jettonMaster,
          to: senderAddr,
          amount: excessHuman,
          forwardComment: memoEnc,
          forwardTonAmount: '0.01',
          idempotencyKey: `overpay-refund:${deal.id}:${txHash}`,
        });
        logger.info(`Deal #${deal.id}: refunded excess ${excessHuman} ${assetUpper} to ${senderAddr}`);
      } catch (e) {
        logger.warn(`Deal #${deal.id}: USDT excess refund failed`, e);
        try {
          let exHuman = excess.toString();
          try {
            exHuman = fromBaseUnits(excess, assetUpper);
          } catch {}
          await unknownToAdminsAndSave({
            amount: exHuman,
            asset: assetUpper,
            address: addr,
            memo: `Qaytarish xatosi Deal #${deal.id}: ${(e as Error).message}`,
          });
        } catch {}
      }
    } else {
      logger.warn(`Deal #${deal.id}: USDT overpay but no sender — refund skipped`);
    }
    await notifySellerDeposit(deal);
    return;
  }

  let gotHuman = note.amount.toString();
  let expHuman = expected.toString();
  try {
    gotHuman = fromBaseUnits(note.amount, assetUpper);
    expHuman = fromBaseUnits(expected, assetUpper);
  } catch {}
  logger.info(`Deal #${deal.id}: USDT underpay got ${note.amount} expected ${expected}`);
  try {
    await unknownToAdminsAndSave({
      amount: gotHuman,
      asset: assetUpper,
      address: addr,
      memo: `Kam to'lov Deal #${deal.id}: keldi ${gotHuman} kutilgan ${expHuman} memo ${decrypted || raw}`,
    });
  } catch {}
  // P5-15: history array — see TON path above (last-write-wins strands funds).
  if (note.sender) {
    try {
      await db.query(
        `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || jsonb_build_object('underpay_history', COALESCE(confirmations->'underpay_history','[]'::jsonb) || jsonb_build_object('amount', $1::text, 'src', $2::text, 'at', now()::text, 'tx', $3::text, 'refunded', false)) WHERE id = $4`,
        [gotHuman, note.sender.toString(), txHash, deal.id],
      );
    } catch {}
  }
}

async function handleTransaction(addr: string, tx: Transaction) {
  const txHash = tx.hash().toString('hex');
  if (!tx.inMessage) return;

  // Raw inMessage src: for jetton notifications this is the notifying jetton
  // wallet — verified against the configured master's derived wallet inside
  // processJettonDeposit (fake-master forgery defense).
  let txSrc: string | null = null;
  try {
    const src: unknown = (tx.inMessage.info as unknown as { src?: unknown })?.src;
    if (src) txSrc = String((src as { toString?: () => string }).toString?.() ?? src);
  } catch {
    txSrc = null;
  }

  // Try jetton first
  const note = parseJettonNotification(tx.inMessage.body);
  if (note) {
    let forwardComment: string | null = null;
    try {
      const bodySlice = tx.inMessage.body.beginParse();
      bodySlice.loadUint(32); // op
      bodySlice.loadUintBig(64); // queryId
      bodySlice.loadCoins(); // amount
      bodySlice.loadAddress(); // sender
      if (bodySlice.remainingBits > 0 || bodySlice.remainingRefs > 0) {
        try {
          if (bodySlice.remainingRefs > 0) {
            // Fresh parse per attempt: a consumed slice would truncate the memo.
            const fwdCell = bodySlice.loadRef();
            forwardComment = parseTonComment(fwdCell.beginParse()) ?? parseJettonForwardComment(fwdCell.beginParse());
          } else {
            forwardComment = parseTonComment(bodySlice.clone()) ?? parseJettonForwardComment(bodySlice.clone());
          }
        } catch {
          // best-effort: unparsable forward payload means "no memo" (deposit handled as unknown), never crash the poll loop.
          forwardComment = null;
        }
      }
    } catch {
      // best-effort: same as above for the outer notification-field parse.
      forwardComment = null;
    }
    await processJettonDeposit(addr, note, forwardComment, txHash, txSrc);
    return;
  }

  if (tx.inMessage.info.type === 'internal') {
    const value = tx.inMessage.info.value.coins;
    const src = tx.inMessage.info.src;
    if (value > 0n) {
      let comment: string | null = null;
      try {
        comment = parseTonComment(tx.inMessage.body);
      } catch {
        // best-effort: unparsable body means "no memo" (deposit handled as unknown).
        comment = null;
      }
      await processTonDeposit(addr, src, value, txHash, comment);
    }
  }
}

/**
 * Bounded backward pagination (newest-first pages of 30). Stops at already-seen
 * history or after maxPages. The old single-page fetch skipped deposits forever
 * when >30 txs landed between 10s ticks on the shared payment address.
 */
async function fetchRecentTransactions(
  addr: Address,
  sinceLt: string | null,
  maxPages: number,
): Promise<Transaction[]> {
  const out: Transaction[] = [];
  const seen = new Set<string>();
  let lt: string | undefined;
  let hash: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    let page: Transaction[];
    try {
      page = await client.getTransactions(addr, { limit: 30, ...(lt ? { lt, hash } : {}) });
    } catch (e) {
      logger.warn(`Listener: getTransactions failed for ${addr.toString()} (page ${p + 1})`, e);
      break;
    }
    if (!page.length) break;
    let reachedSeen = false;
    for (const tx of page) {
      const h = tx.hash().toString('hex');
      if (seen.has(h)) continue;
      seen.add(h);
      const txLt = (tx.lt ?? 0n).toString();
      // Keep same-lt txs here: the precise (lt,hash) cursor in pollAddress
      // decides those (a same-lt higher-hash tx is still NEW). Drop only
      // strictly older history.
      if (sinceLt !== null && BigInt(txLt) < BigInt(sinceLt)) {
        reachedSeen = true;
        continue;
      }
      out.push(tx);
    }
    if (page.length < 30 || reachedSeen) break;
    const oldest = page[page.length - 1];
    lt = (oldest.lt ?? 0n).toString();
    hash = oldest.hash().toString('hex');
  }
  // Oldest-first so multi-tx deposit sequences confirm in arrival order.
  out.sort((a, b) => {
    const da = BigInt((a.lt ?? 0n).toString()) - BigInt((b.lt ?? 0n).toString());
    if (da !== 0n) return da < 0n ? -1 : 1;
    const ha = a.hash().toString('hex');
    const hb = b.hash().toString('hex');
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  return out;
}

async function pollAddress(addr: string) {
  // Validate address before polling — prevents a poisoned monitoredAddresses
  // entry from spamming Address.parse errors every tick.
  let parsed: Address;
  try {
    parsed = Address.parse(addr);
  } catch {
    logger.warn(`Listener: skipping invalid monitored address ${addr}`);
    monitoredAddresses.delete(addr);
    return;
  }
  const cursor = cursors.get(addr);
  const txs = await fetchRecentTransactions(parsed, cursor ? cursor.lt : null, 5);

  // First observation (no cursor yet): process the fetched window so fast
  // deposits landing between deal creation and the first tick are not lost.
  // (The stale "seed without processing" comment on addAddressToMonitor was
  // wrong — skipping here would drop those deposits forever.)
  let cur: { lt: string; hash: string } | null = cursor ? { ...cursor } : null;
  for (const tx of txs) {
    const lt = (tx.lt ?? 0n).toString();
    const entry = { lt, hash: tx.hash().toString('hex') };
    // (lt,hash) cursor: same-lt different-hash txs each advance the cursor, so
    // nothing is re-processed every tick (the old lt-only cursor looped them).
    if (cur) {
      if (BigInt(lt) < BigInt(cur.lt)) continue;
      if (BigInt(lt) === BigInt(cur.lt) && entry.hash <= cur.hash) continue;
    }
    try {
      await handleTransaction(addr, tx);
    } catch (err) {
      logger.error(`Failed handling tx on ${addr} (lt ${lt})`, err);
    }
    // Advance past even failed txs: a poison tx must not stall the poll loop
    // forever (failures are logged + admin-alerted inside the handlers).
    cur = entry;
  }

  if (cur && (!cursor || cur.lt !== cursor.lt || cur.hash !== cursor.hash)) {
    cursors.set(addr, cur);
    // Persist to DB so restart doesn't reseed and skip deposits (fix 2.4)
    await persistCursor(addr, cur.lt, cur.hash);
  }
}

/** Immediately poll one monitored address once (for "Toldim, tekshiring" button). */
export async function recheckAddress(address: string): Promise<void> {
  const a = String(address || '').trim();
  if (!a) return;
  if (!monitoredAddresses.has(a)) monitoredAddresses.add(a);
  try {
    await pollAddress(a);
  } catch (err) {
    logger.warn(`recheckAddress failed for ${a}`, err);
  }
}

let listenerStarted = false;
export async function startListener() {
  // Idempotent: a second call (e.g. background DB retry after boot) must not
  // stack another 10s poll loop — each loop re-fetches every monitored wallet.
  if (listenerStarted) {
    logger.warn('startListener called twice — ignoring (poll loop already running)');
    return;
  }
  listenerStarted = true;
  logger.info('Blockchain listener started');
  // Fix 2.4: restore persisted cursors and seed monitored addresses from DB
  await loadPersistedCursors();
  await seedMonitoredAddressesFromDB();
  const timer = setInterval(async () => {
    for (const addr of monitoredAddresses) {
      try {
        await pollAddress(addr);
      } catch (err) {
        logger.error(`Listener error for ${addr}:`, err);
      }
    }
  }, 10000);
  (timer as unknown as { unref?: () => void }).unref?.();
}
