// src/index.ts
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import type { Server } from 'http';
import { config } from './config';
import { db, connectDB, listDeals, getDealLinks } from './db/queries';
import { Address, openContract } from '@ton/core';
import { Escrow } from './contracts/wrappers/Escrow';
import { client } from './blockchain/tonClient';
import logger, { sanitizeLogValue } from './logger';
import { startBot, getBot } from './bot/bot';
import { startListener, addAddressToMonitor, recheckAddress } from './blockchain/listener';
import * as notify from './bot/notify';
import {
  createDealRecord,
  generateDealLink,
  getBotDeepLink,
  getDealById,
  getDealLink,
  markDealLinkUsed,
  getDealChatKey,
  purgeExpiredLinks,
  getDealMessages,
  addEncryptedMessage,
  createJoinRequest,
  getMyJoinStatus,
  purgeStaleJoinRequests,
  updateDealStatus,
  getJoinRequestById,
} from './services/dealService';
import { depositComment, releaseComment } from './utils/comments';
import { encryptedCommentToPayloadB64, jettonTransferPayload } from './utils/tonPayload';
import {
  isEncryptionEnabled,
  getMasterKey,
  encryptField,
  decryptField,
  assertEncryptionForStrictEnv,
  warnIfEncryptionDisabledOnce,
} from './utils/encryption';
import { toBaseUnits } from './utils/money';
import {
  identityAuth,
  requireIdentity,
  requireAdmin,
  rateLimit,
  getIdentityId,
  isValidPositiveInt,
} from './auth/guard';

const app = express();
// Only trust loopback proxy (nginx on same host/network) — trusting any
// first hop lets direct clients spoof X-Forwarded-For and bypass rate limits.
app.set('trust proxy', 'loopback');

// Security headers — encrypted seller-buyer channel must not be sniffed/framed
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  // CSP: Telegram WebView needs inline scripts (Mini App), so allow self + unsafe-inline for now but block framing.
  // ACCEPTED RISK (documented, do not "fix" by deleting): a nonce/hash-based script-src is
  // infeasible here without breaking the app — the Telegram Mini App WebView injects and
  // executes inline bootstrap scripts outside our build pipeline, so a strict nonce would
  // block the app on real clients. Mitigations in place: frame-ancestors 'none',
  // nosniff, SAMEORIGIN, and no remote script hosts beyond https: allowlist.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'",
  );
  next();
});

/** CORS — micro-architecture: backend (3000) separate from frontend (8080 via nginx).
 * Allow WEBAPP_URL, FRONTEND_URL, and local dev origins. Falls back to allow-all in dev.
 */
function buildAllowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const u of [config.webappUrl, config.frontendUrl]) {
    if (!u) continue;
    try {
      origins.add(new URL(u).origin);
    } catch {} // best-effort: skip malformed configured URLs.
  }
  // Local dev + docker internal — only outside production to avoid
  // accepting http://localhost origins in prod.
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:8080');
    origins.add('http://127.0.0.1:8080');
    origins.add('http://frontend:80');
    origins.add('http://frontend');
    origins.add('http://localhost:3000');
  }
  return Array.from(origins);
}
const allowedOrigins = buildAllowedOrigins();
const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
  if (!origin) return cb(null, true); // same-origin / curl / healthcheck (no Origin header)
  if (allowedOrigins.includes(origin)) return cb(null, true);
  // Fix: fail-closed — do not allow-all when WEBAPP_URL missing (was dev fallback that made prod insecure)
  if (!config.webappUrl && !config.frontendUrl) {
    logger.warn(
      `CORS: blocking origin ${sanitizeLogValue(origin)} — WEBAPP_URL/FRONTEND_URL not configured (allowed: ${sanitizeLogValue(allowedOrigins.join(', '))})`,
    );
  }
  return cb(null, false);
};
// Use function form when we have a list, boolean otherwise (type any to avoid overload mismatch)
app.use(cors({ origin: corsOrigin as never, credentials: false }));
app.use(express.json({ limit: '256kb' }));
app.use(identityAuth);

// Global rate limiter — baseline protection for every route (per-route limiters below are stricter)
const globalLimiter = rateLimit({ windowMs: 60_000, max: 300, name: 'global' });
app.use(globalLimiter);

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps async handlers so rejections hit the error middleware -> 500 JSON. */
function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Rate limiters (per-ip sliding window).
// TODO(scale): rateLimit() in auth/guard.ts is an IN-MEMORY express-rate-limit store —
// limits are enforced per backend PROCESS, not globally. If a second backend instance
// is ever added, move to a shared store (e.g. rate-limit-redis backed by a Redis
// service in docker-compose.yml — none exists today, so this is intentionally not
// implemented here) or limits will be N× too generous with N instances.
const notifyLimiter = rateLimit({ windowMs: 60_000, max: 5, name: 'notify' });
const dealsCreateLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'deals-create' });
const chatPostLimiter = rateLimit({ windowMs: 60_000, max: 60, name: 'chat-post' });
const joinLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'join' });
// Public TON proxies fan out to paid external APIs (TONCenter/TON API) — conservative.
const publicTonLimiter = rateLimit({ windowMs: 60_000, max: 30, name: 'public-ton-api' });
// State-changing deal actions are DB-guarded but must not be hammerable.
const dealActionLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'deal-action' });

function isAdminTelegramId(id: number): boolean {
  return config.adminTelegramIds.map(Number).includes(Number(id));
}

/**
 * Caller telegram id for a route — verified identity only.
 * (Removed legacy body.telegramId fallback: getIdentityId already gates
 * body override to api-key callers; duplicating it here was a latent spoof.)
 */
function callerTelegramId(req: Request): number | null {
  return getIdentityId(req);
}

/**
 * Consolidated deal access check (fix: avoid duplicate auth blocks drifting).
 * Returns deal if hasAccess, else null. Used by GET /deals/:id, /key, /chat, /payload.
 */
async function checkDealAccess(
  req: Request,
  dealId: number,
): Promise<{ deal: any; hasAccess: boolean; isParty: boolean; isAdmin: boolean } | null> {
  const deal = await getDealById(dealId);
  if (!deal) return null;
  const caller = getIdentityId(req);
  if (caller === null) return { deal, hasAccess: false, isParty: false, isAdmin: false };
  const isParty =
    (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
    (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
  const isAdmin = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
  if (isParty || isAdmin) return { deal, hasAccess: true, isParty, isAdmin };
  // Token preview: valid invite token or pending join request
  const token = String((req.query.token as string) || '').trim();
  if (token) {
    try {
      const link = await getDealLink(token);
      if (link && Number(link.deal_id) === dealId && new Date(link.expires_at).getTime() > Date.now()) {
        return { deal, hasAccess: true, isParty: false, isAdmin: false };
      }
      const jr = await db.query(
        'SELECT 1 FROM deal_join_requests WHERE deal_id = $1 AND token = $2 AND status = $3 LIMIT 1',
        [dealId, token, 'pending'],
      );
      if (jr.rows.length > 0) return { deal, hasAccess: true, isParty: false, isAdmin: false };
    } catch {} // best-effort preview: DB error means no preview access (falls through to 403).
  }
  return { deal, hasAccess: false, isParty, isAdmin };
}

// Notification endpoint (admin-only)
app.post(
  '/api/notify',
  requireAdmin,
  notifyLimiter,
  asyncHandler(async (req, res) => {
    const { chatId, message } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
    const bot = getBot();
    if (!bot) return res.status(503).json({ error: 'bot_not_configured' });
    await bot.api.sendMessage(chatId, String(message));
    try {
      await db.query('INSERT INTO notifications (chat_id, message) VALUES ($1,$2)', [chatId, String(message)]);
    } catch (e) {
      logger.warn('could not persist notification', e);
    }
    return res.json({ ok: true });
  }),
);

// Notification history (admin-only)
app.get(
  '/api/notifications',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    try {
      const result = await db.query('SELECT * FROM notifications ORDER BY id DESC LIMIT 200');
      return res.json(result.rows);
    } catch (err) {
      logger.warn('/api/notifications error', err);
      return res.json([]);
    }
  }),
);

// Public: webapp boot info (feeBps lets the frontend show exact fees)
function isValidTonAddress(a: string): boolean {
  try {
    Address.parse(a.trim());
    return true;
  } catch {
    return false;
  }
}
function resolvePaymentAddress(): string | null {
  if (config.walletAddress && isValidTonAddress(config.walletAddress)) return config.walletAddress.trim();
  if (config.adminAddress && isValidTonAddress(config.adminAddress)) return config.adminAddress.trim();
  return null;
}

// TON Connect dapp manifest — dynamic per-request origin (kept for local dev & full deploy, but NOT used now)
// Current wallet uses GitHub raw URL (webapp/public/js/app-config.js → TONCONNECT_MANIFEST_URL) so cloudflare is gone.
// Kept for fallback when you have a real domain: wallet.js falls back to location.origin + '/tonconnect-manifest.json'
//  - http://localhost:8080/tonconnect-manifest.json → http://localhost:8080 (local dev)
//  - https://your-domain/tonconnect-manifest.json → https://your-domain (future prod)
app.get('/tonconnect-manifest.json', (req, res) => {
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim() || 'localhost';
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  // If WEBAPP_URL is explicitly set and request host matches it, prefer it (for bot consistency), else use request host
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : host.startsWith('localhost') || host.startsWith('127.0.0.1')
        ? 'http'
        : 'https';
  // Always derive from request to avoid mismatch when accessing via different host (localhost vs prod domain)
  const origin = `${proto}://${host}`;
  // Log for debugging wallet issues
  if (req.get('origin') || req.get('referer')) {
    logger.info(
      `tonconnect-manifest requested via ${sanitizeLogValue(origin)} (host=${sanitizeLogValue(host)}, x-forwarded-proto=${sanitizeLogValue(forwardedProto)}, referer=${sanitizeLogValue(req.get('referer'))})`,
    );
  }
  res.setHeader('Cache-Control', 'no-cache');
  // Reflect the request origin only if it is in our allowlist; never '*'
  // (prevents any site from reading the manifest as a phishing template).
  const reqOrigin = req.get('origin');
  if (reqOrigin && allowedOrigins.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  }
  res.json({
    url: origin,
    name: 'TonEscrow',
    iconUrl: `${origin}/icon.png`,
    termsOfUseUrl: origin,
    privacyPolicyUrl: origin,
  });
});

app.get('/api/info', (_req, res) => {
  res.json({
    feeBps: config.feeBps,
    paymentAddress: resolvePaymentAddress(),
    network: config.tonNetwork,
  });
});

// User TON payout address — seller sets via web app after buyer confirms receipt
app.get(
  '/api/users/me',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const telegramId = getIdentityId(req);
    if (telegramId === null) return res.status(401).json({ error: 'identity_required' });
    const user = await db.query(
      'SELECT telegram_id, username, ton_address, created_at FROM users WHERE telegram_id = $1 LIMIT 1',
      [telegramId],
    );
    if (!user.rows[0])
      return res.json({ telegram_id: telegramId, username: req.user?.username || null, ton_address: null });
    return res.json(user.rows[0]);
  }),
);

app.post(
  '/api/users/me/ton-address',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const telegramId = getIdentityId(req);
    if (telegramId === null) return res.status(401).json({ error: 'identity_required' });
    const raw = String(
      (req.body as any).tonAddress || (req.body as any).ton_address || (req.body as any).address || '',
    ).trim();
    if (!raw) return res.status(400).json({ error: 'tonAddress_required' });
    try {
      Address.parse(raw);
    } catch {
      return res.status(400).json({ error: 'invalid_ton_address' });
    }
    // Ensure user exists then update
    await db.query(
      `INSERT INTO users (telegram_id, username, ton_address) VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id) DO UPDATE SET ton_address = EXCLUDED.ton_address`,
      [telegramId, req.user?.username || null, raw],
    );
    logger.info(`User ${sanitizeLogValue(telegramId)} set ton_address ${sanitizeLogValue(raw.slice(0, 12))}...`);
    return res.json({ ok: true, ton_address: raw });
  }),
);

// Per-deal payout address override (seller can set for specific deal)
app.post(
  '/api/deals/:id/payout-address',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isSeller && !isAdminCaller) return res.status(403).json({ error: 'only_seller_can_set_payout' });
    const raw = String(
      (req.body as any).tonAddress || (req.body as any).ton_address || (req.body as any).address || '',
    ).trim();
    if (!raw) return res.status(400).json({ error: 'tonAddress_required' });
    try {
      Address.parse(raw);
    } catch {
      return res.status(400).json({ error: 'invalid_ton_address' });
    }
    // payout_address column is ensured at boot via ensureTables (fix: no DDL on hot path)
    await db.query('UPDATE deals SET payout_address = $1, updated_at = now() WHERE id = $2', [raw, dealId]);
    await db.query(
      `INSERT INTO users (telegram_id, username, ton_address) VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id) DO UPDATE SET ton_address = EXCLUDED.ton_address`,
      [caller, req.user?.username || null, raw],
    );
    return res.json({ ok: true, payout_address: raw });
  }),
);

// Deals belonging to the caller (must come before /api/deals/:id)
app.get(
  '/api/deals/mine',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const telegramId = getIdentityId(req);
    if (telegramId === null) return res.status(401).json({ error: 'identity_required' });
    const result = await db.query(
      'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 200',
      [telegramId],
    );
    return res.json(result.rows);
  }),
);

// Deal list — private: only deals where caller is buyer/seller (admin sees all)
app.get(
  '/api/deals',
  requireIdentity,
  asyncHandler(async (req, res) => {
    try {
      const caller = getIdentityId(req);
      const isAdmin = req.authMode === 'api-key' || (caller !== null && isAdminTelegramId(caller));
      if (isAdmin) {
        return res.json(await listDeals(100));
      }
      if (caller === null) return res.status(401).json({ error: 'identity_required' });
      const result = await db.query(
        'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 100',
        [caller],
      );
      return res.json(result.rows);
    } catch (err) {
      logger.warn('/api/deals error', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }),
);

app.get(
  '/api/deals/:id',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const check = await checkDealAccess(req, id);
    if (!check) return res.status(404).json({ error: 'deal_not_found' });
    if (!check.hasAccess) return res.status(403).json({ error: 'not_a_party_to_deal' });
    return res.json(check.deal);
  }),
);

// Mint a fresh one-time invite link for a deal (deal-view share button).
// Join tokens are single-use + expiring, so the view cannot reuse the
// creation-time link — it requests a new one here (party only).
app.post(
  '/api/deals/:id/invite',
  joinLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const check = await checkDealAccess(req, id);
    if (!check) return res.status(404).json({ error: 'deal_not_found' });
    // Invite mint requires actual party membership — token-preview holders
    // (hasAccess via ?token=) must NOT be able to mint fresh links.
    if (!check.isParty && (req as any).authMode !== 'api-key')
      return res.status(403).json({ error: 'not_a_party_to_deal' });
    const deal = check.deal as unknown as Record<string, unknown>;
    const status = String(deal.status || '').toUpperCase();
    if (status === 'RELEASED' || status === 'REFUNDED') return res.status(400).json({ error: 'deal_finished' });
    if (status === 'RELEASE_PENDING' || status === 'REFUND_PENDING')
      return res.status(409).json({ error: 'deal_locked: payout in progress' });
    const buyerId = (deal.buyer_telegram_id ?? (deal as Record<string, unknown>).buyerTelegramId) as
      number | null | undefined;
    const sellerId = (deal.seller_telegram_id ?? (deal as Record<string, unknown>).sellerTelegramId) as
      number | null | undefined;
    if (buyerId != null && sellerId != null) return res.status(400).json({ error: 'deal_full' });
    // 15-minute window: reuse the latest still-live link instead of minting a
    // new URL on every tap. A new token is created only when none is unexpired.
    const INVITE_TTL_SECONDS = 15 * 60;
    const existingLinks = await getDealLinks(id);
    const liveLink = (existingLinks || []).find((l: { expires_at?: unknown; token?: unknown }) => {
      try {
        return new Date(l.expires_at as string).getTime() > Date.now();
      } catch {
        return false;
      }
    });
    const linkToken =
      liveLink && liveLink.token ? String(liveLink.token) : await generateDealLink(id, INVITE_TTL_SECONDS);
    const baseUrl = config.webappUrl || config.frontendUrl || `${req.protocol}://${req.get('host')}`;
    const webappLink = `${baseUrl.replace(/\/$/, '')}/#/deal/${id}/join/${linkToken}`;
    const apiLink = `${req.protocol}://${req.get('host')}/api/deals/${id}/join/${linkToken}`;
    const botLink = getBotDeepLink(id, linkToken, config.botUsername);
    return res.json({ dealId: id, link: botLink, botLink, webappLink, apiLink });
  }),
);

// Create a new deal (buyer optional for api-key callers, returns generated link)
app.post(
  '/api/deals',
  dealsCreateLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { asset, amount, terms, deadline } = req.body;
    if (!asset || !amount) return res.status(400).json({ error: 'asset_and_amount_required' });
    // Fix 3.1: validate amount is finite positive decimal with sane bounds
    const assetUpperPre = String(asset).toUpperCase();
    if (!['TON', 'USDT'].includes(assetUpperPre))
      return res.status(400).json({ error: 'asset_unsupported, use TON or USDT' });
    if (terms != null && String(terms).length > 2000)
      return res.status(400).json({ error: 'terms_too_long', max: 2000 });
    let deadlineDate: Date | null = null;
    if (deadline) {
      deadlineDate = new Date(deadline);
      if (Number.isNaN(deadlineDate.getTime())) return res.status(400).json({ error: 'invalid_deadline' });
      if (deadlineDate.getTime() <= Date.now()) return res.status(400).json({ error: 'deadline_must_be_future' });
    }
    const amtStrRaw = String(amount).trim();
    if (
      !amtStrRaw ||
      amtStrRaw.toLowerCase() === 'nan' ||
      amtStrRaw.toLowerCase() === 'infinity' ||
      amtStrRaw.toLowerCase() === '-infinity'
    ) {
      return res.status(400).json({ error: 'amount_must_be_finite_positive_number' });
    }
    let scaled: bigint;
    try {
      const baseStr = toBaseUnits(amtStrRaw, assetUpperPre);
      scaled = BigInt(baseStr);
      if (scaled <= 0n) return res.status(400).json({ error: 'amount_must_be_positive' });
      // Sanity caps: TON 1B, USDT 1B (in base units)
      const cap = assetUpperPre === 'TON' ? 1_000_000_000n * 1_000_000_000n : 1_000_000_000n * 1_000_000n;
      if (scaled > cap) return res.status(400).json({ error: 'amount_exceeds_max' });
      // Reject more decimals than asset supports (truncation would be silent).
      // NOTE: round-trip strictness check intentionally not enforced yet —
      // toBaseUnits truncates; see money.ts. Add comparison when UX is decided.
    } catch (e) {
      return res.status(400).json({ error: 'invalid_amount', detail: String((e as Error).message || e).slice(0, 200) });
    }

    // Either side can create a deal. The creator occupies their own role slot and
    // the counterparty joins via invite link (link-only allowed: other slot null).
    // role=buy (default) → caller is buyer; role=sell → caller is seller.
    let sellerId = isValidPositiveInt(req.body.sellerId) ? Number(req.body.sellerId) : null;
    let buyerId = isValidPositiveInt(req.body.buyerId) ? Number(req.body.buyerId) : null;
    // Support alternative param names from webapp
    const cpRaw = (req.body as any).counterpartyId ?? (req.body as any).counterparty ?? (req.body as any).cp;
    const cpId = isValidPositiveInt(Number(cpRaw)) ? Number(cpRaw) : null;

    if (req.authMode !== 'api-key') {
      const meId = req.user ? req.user.id : Number(req.headers['x-telegram-user-id']) || null;
      if (!meId) return res.status(401).json({ error: 'identity_required' });
      const role = String((req.body as Record<string, unknown>).role || 'buy').toLowerCase();
      const origSellerId = sellerId;
      const origBuyerId = buyerId;
      // Counterparty hint from any explicit field (not equal to self)
      const counterparty =
        origSellerId !== null && origSellerId !== meId
          ? origSellerId
          : cpId !== null && cpId !== meId
            ? cpId
            : origBuyerId !== null && origBuyerId !== meId
              ? origBuyerId
              : null;
      if (role === 'sell') {
        // Caller creates as seller; buyer joins via link (or explicit counterparty)
        sellerId = meId;
        buyerId = counterparty;
      } else {
        // Default: caller creates as buyer; seller joins via link (or explicit counterparty)
        buyerId = meId;
        sellerId = counterparty;
      }
      // Link-only: no counterparty required — other side is filled via invite link
    }

    // Link-only validation: at least one side must be set, single side via invite is allowed
    if (sellerId === null && buyerId === null) return res.status(400).json({ error: 'seller_or_buyer_required' });
    if (sellerId !== null && !isValidPositiveInt(sellerId))
      return res.status(400).json({ error: 'sellerId_must_be_positive_int' });
    if (buyerId !== null && !isValidPositiveInt(buyerId))
      return res.status(400).json({ error: 'buyerId_must_be_positive_int' });
    if (sellerId !== null && buyerId !== null && sellerId === buyerId) {
      return res.status(400).json({ error: 'sellerId_must_differ_from_buyerId' });
    }

    // CHANNEL/GROUP escrow: optional dealType and channelUsername (additive, P2P untouched)
    const rawDealType = String((req.body as any).dealType || (req.body as any).deal_type || 'P2P').toUpperCase();
    const dealType = ['P2P', 'CHANNEL', 'GROUP'].includes(rawDealType) ? rawDealType : 'P2P';
    const rawChannelUsername =
      (req.body as any).channelUsername || (req.body as any).channel_username || (req.body as any).username || null;
    let channelUsername: string | null = null;
    // NOTE: channel identity fields are reserved for the CHANNEL/GROUP flow and
    // intentionally stay null until that flow populates them.
    const channelId: string | null = null;
    const channelTitle: string | null = null;
    const channelSnapshot: Record<string, unknown> | null = null;
    let escrowHolderId: number | null = null;
    if (dealType === 'CHANNEL' || dealType === 'GROUP') {
      const { normalizeChannelUsername } = await import('./services/dealService');
      channelUsername = normalizeChannelUsername(rawChannelUsername);
      if (!channelUsername)
        return res.status(400).json({
          error: 'channel_username_required: enter @username or t.me link (CHANNEL/GROUP deals require channel)',
        });
      // escrow holder is @gramchioka (ubot) for custodial flow
      const holderRaw = Number(process.env.ESCROW_HOLDER_ID || 8992814642);
      if (!isValidPositiveInt(holderRaw)) return res.status(500).json({ error: 'escrow_holder_misconfigured' });
      escrowHolderId = holderRaw;
    }

    const resolvedPayAddr = resolvePaymentAddress();
    if (!resolvedPayAddr) {
      return res.status(503).json({
        error: 'payment_address_not_configured: set WALLET_ADDRESS or ADMIN_ADDRESS to a valid TON address',
      });
    }
    const deal = await createDealRecord({
      buyerId,
      sellerId,
      buyerTelegramId: buyerId,
      sellerTelegramId: sellerId,
      asset: assetUpperPre,
      amount: amtStrRaw,
      feeBps: config.feeBps,
      status: 'AWAITING_DEPOSIT',
      contractAddress: '',
      paymentAddress: resolvedPayAddr,
      terms: terms || '',
      deadline: deadlineDate,
      dealType,
      channelUsername: channelUsername as any,
      channelId,
      channelTitle,
      channelSnapshot,
      escrowHolderId,
    });
    const linkToken = await generateDealLink(deal.id);
    const memo = depositComment(deal.id);
    const outMemo = releaseComment({ id: deal.id, amount, asset, terms });
    // Ensure the payment address is monitored for deposits (with comment)
    const payAddr = (deal as unknown as { payment_address?: string }).payment_address || resolvePaymentAddress();
    if (payAddr) addAddressToMonitor(payAddr);
    // Build invite links — primary is BOT deep link (t.me) with approval flow, plus webapp and API for compatibility
    const baseUrl = config.webappUrl || config.frontendUrl || `${req.protocol}://${req.get('host')}`;
    const webappLink = `${baseUrl.replace(/\/$/, '')}/#/deal/${deal.id}/join/${linkToken}`;
    const apiLink = `${req.protocol}://${req.get('host')}/api/deals/${deal.id}/join/${linkToken}`;
    const botLink = getBotDeepLink(deal.id, linkToken, config.botUsername);
    // Memo is encrypted and auto-injected via payload — never show plaintext to user
    const depositPayload = encryptedCommentToPayloadB64(memo);
    const releasePayload = encryptedCommentToPayloadB64(outMemo);
    let jettonPayload: string | null = null;
    if (asset.toUpperCase() !== 'TON') {
      try {
        const mockDest =
          payAddr && payAddr.length > 10 ? Address.parse(payAddr) : Address.parse('0:' + '00'.repeat(32));
        // Jetton forward memo is also encrypted (listener will decrypt)
        const { encryptField } = await import('./utils/encryption');
        const encMemo = encryptField(memo);
        jettonPayload = jettonTransferPayload({
          amount: BigInt(toBaseUnits(String(amount), asset.toUpperCase())),
          destination: mockDest,
          forwardComment: encMemo,
          forwardTonAmount: BigInt(1000000), // 0.001 TON for forward
        });
      } catch {
        jettonPayload = null;
      } // best-effort: optional payload; TON path and deal creation are unaffected.
    }
    return res.json({
      deal,
      link: botLink,
      botLink,
      webappLink,
      apiLink,
      // Memo is auto-injected and encrypted — do not expose plaintext
      depositPayload,
      releasePayload,
      jettonPayload,
      paymentAddress: payAddr,
      encryption: isEncryptionEnabled() ? 'e2e-aes-256-gcm' : 'transport-only',
      memoEncrypted: true,
      instructions:
        asset.toUpperCase() === 'TON'
          ? `Send ${amount} ${asset} to ${payAddr} — memo is auto-injected and encrypted (payload). Just approve the transaction in your wallet.`
          : `Send ${amount} ${asset} (Jetton) to ${payAddr} — forward memo is auto-injected and encrypted (payload). Just approve.`,
    });
  }),
);

// Join a deal via one-time link — REQUEST flow (buyer approval required)
// Desired flow: seller opens link -> bot asks ONLY buyer "Are you trading with this person?"
// Webapp must create a pending join request, NOT atomic join. Buyer approves via bot or webapp.
app.post(
  '/api/deals/:id/join/:token',
  joinLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const token = String(req.params.token || '');
    if (!Number.isInteger(dealId) || !token) return res.status(400).json({ error: 'invalid_request' });

    let telegramId: number | null;
    let requesterUsername: string | null = null;
    let requesterFirstName: string | null = null;
    if ((req.authMode === 'telegram' || req.authMode === 'dev') && req.user && isValidPositiveInt(req.user.id)) {
      telegramId = req.user.id;
      requesterUsername = req.user.username || null;
      requesterFirstName = (req.user as any).first_name || null;
    } else {
      telegramId = callerTelegramId(req);
      // Try to get username from body if provided
      if (req.body && typeof (req.body as any).username === 'string')
        requesterUsername = String((req.body as any).username);
      if (req.body && typeof (req.body as any).first_name === 'string')
        requesterFirstName = String((req.body as any).first_name);
      // Fallback to x-telegram-username header if present
      if (!requesterUsername && req.headers['x-telegram-username'])
        requesterUsername = String(req.headers['x-telegram-username']);
    }
    if (telegramId === null) return res.status(400).json({ error: 'telegramId_required' });

    // Fetch deal & link first for validation
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    if (Number(deal.buyer_telegram_id) === telegramId || Number(deal.seller_telegram_id) === telegramId) {
      return res.status(400).json({ error: 'already_party_to_deal' });
    }
    if (deal.buyer_telegram_id != null && deal.seller_telegram_id != null) {
      return res.status(409).json({ error: 'deal_already_full' });
    }
    // Either side can be the creator — at least one slot must be occupied.
    if (deal.buyer_telegram_id == null && deal.seller_telegram_id == null) {
      return res.status(400).json({ error: 'deal_has_no_creator' });
    }
    // No joining a finished or payout-in-flight deal — there is nothing to join.
    const dealStatus = String(deal.status || '').toUpperCase();
    if (dealStatus === 'RELEASED' || dealStatus === 'REFUNDED') {
      return res.status(409).json({ error: 'deal_finished: bitim allaqachon yakunlangan' });
    }
    if (dealStatus === 'RELEASE_PENDING' || dealStatus === 'REFUND_PENDING') {
      return res.status(409).json({ error: 'deal_locked: tolov jarayonda, birozdan keyin urinib koring' });
    }
    const link = await getDealLink(token).catch(() => null);
    if (!link || Number(link.deal_id) !== dealId) return res.status(404).json({ error: 'invalid_token' });
    if (new Date(link.expires_at).getTime() <= Date.now()) {
      void markDealLinkUsed(token).catch(() => undefined);
      return res.status(410).json({ error: 'link_expired' });
    }

    // Create pending join request (upsert — duplicate taps return the same row)
    try {
      // Best-effort: grab the requester's profile photo file_id so the creator can
      // SEE who is asking (rendered in the mini-app chat approval card). file_id
      // only — file URLs embed the bot token and are never stored or served.
      const photoFileId = await resolveRequesterPhotoFileId(telegramId);
      const { request: joinReq, created } = await createJoinRequest({
        dealId,
        token,
        requesterTelegramId: telegramId,
        requesterUsername,
        requesterFirstName,
        requesterPhotoUrl: null,
        requesterPhotoFileId: photoFileId,
      });

      // Notify the creator ONLY for genuinely new requests (no DM spam on re-taps).
      // The creator opens the deal chat and approves there — no bot-side approval.
      if (created) {
        const creatorId =
          deal.buyer_telegram_id != null
            ? Number(deal.buyer_telegram_id)
            : deal.seller_telegram_id != null
              ? Number(deal.seller_telegram_id)
              : null;
        if (creatorId !== null) {
          try {
            const label = requesterUsername ? `@${requesterUsername}` : requesterFirstName || String(telegramId);
            await notify.joinRequestToCreator(
              creatorId,
              { id: deal.id, amount: String(deal.amount), asset: String(deal.asset), terms: String(deal.terms || '') },
              label,
            );
          } catch (notifyErr) {
            logger.warn(
              `Could not notify creator ${sanitizeLogValue(creatorId)} about join request ${sanitizeLogValue(joinReq.id)}`,
              notifyErr,
            );
          }
        } else {
          logger.warn(
            `Join request ${sanitizeLogValue(joinReq.id)} has no creator to notify (deal #${sanitizeLogValue(dealId)})`,
          );
        }
      }

      void purgeExpiredLinks().catch((err) => logger.warn('purgeExpiredLinks failed', err));
      void purgeStaleJoinRequests().catch((err) => logger.warn('purgeStaleJoinRequests failed', err));
      return res.status(202).json({
        ok: true,
        pending: true,
        requestId: joinReq.id,
        message: 'Join request sent — awaiting creator approval in deal chat',
      });
    } catch (err) {
      const msg = String((err as Error).message || '');
      logger.warn('join request failed', err);
      return res.status(400).json({ error: msg || 'join_failed' });
    }
  }),
);

/** Best-effort Telegram profile photo file_id for a join requester (4s cap).
 *  Returns null on ANY failure — a missing photo must never block joining.
 */
async function resolveRequesterPhotoFileId(telegramId: number): Promise<string | null> {
  try {
    const bot = getBot();
    if (!bot || !config.botToken) return null;
    const photos = await Promise.race([
      bot.api.getUserProfilePhotos(telegramId, { limit: 1 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('photo_timeout')), 4000)),
    ]);
    const sizes: Array<{ file_id?: string; file_size?: number }> = (photos as any)?.photos?.[0] || [];
    let best: string | null = null;
    let bestSize = -1;
    for (const s of sizes) {
      if (s?.file_id && Number(s.file_size || 0) >= bestSize) {
        best = String(s.file_id);
        bestSize = Number(s.file_size || 0);
      }
    }
    return best;
  } catch {
    return null;
  }
}

// Per-deal E2E chat key — only buyer, seller or admin may fetch (ciphertext never leaves client decrypted on server)
app.get(
  '/api/deals/:id/key',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
    const key = await getDealChatKey(dealId);
    return res.json({ dealId, key, algo: 'aes-256-gcm', format: 'base64' });
  }),
);

// Chat endpoints — fully encrypted, authenticated, party-only
// Returns ciphertext only; decryption happens client-side with per-deal key from /key
app.get(
  '/api/deals/:id/chat',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const limitRaw = Number(req.query.limit || 100);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });

    const rows = await getDealMessages(dealId, limit);
    // Return canonical shape: id, sender, created_at, ciphertext (encrypted_content) + legacy content for migration
    const out = rows.map((r: any) => ({
      id: r.id,
      deal_id: r.deal_id,
      sender_telegram_id: r.sender_telegram_id,
      created_at: r.created_at,
      is_encrypted: !!r.is_encrypted,
      // ciphertext is the E2E blob (iv+tag+enc base64) — plaintext never returned when encrypted
      ciphertext: r.encrypted_content || null,
      content: r.is_encrypted ? undefined : r.content,
    }));
    return res.json(out);
  }),
);

app.post(
  '/api/deals/:id/chat',
  chatPostLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });

    // Accept either E2E ciphertext (preferred) or legacy plaintext content
    const body = (req.body || {}) as Record<string, unknown>;
    const ciphertext =
      typeof body.ciphertext === 'string'
        ? body.ciphertext.trim()
        : typeof (body as any).encryptedContent === 'string'
          ? String((body as any).encryptedContent).trim()
          : typeof (body as any).encrypted_content === 'string'
            ? String((body as any).encrypted_content).trim()
            : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';

    // Sender identity is FORCED server-side; body senderTelegramId only trusted from api-key callers.
    let senderTelegramId: number | null;
    if (
      req.authMode === 'api-key' &&
      req.body &&
      isValidPositiveInt((req.body as Record<string, unknown>).senderTelegramId)
    ) {
      senderTelegramId = Number((req.body as Record<string, unknown>).senderTelegramId);
    } else {
      senderTelegramId = req.user && isValidPositiveInt(req.user.id) ? req.user.id : null;
    }
    if (senderTelegramId === null) return res.status(400).json({ error: 'sender_required' });

    // Only a party to the deal (or an admin/api-key caller) may post.
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === senderTelegramId) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === senderTelegramId);
    const isAdminCaller = req.authMode === 'api-key' || isAdminTelegramId(senderTelegramId);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });

    // Validate payload
    if (ciphertext) {
      // E2E path: server stores ciphertext as-is, never sees plaintext
      if (ciphertext.length < 20 || ciphertext.length > 20000)
        return res.status(400).json({ error: 'invalid_ciphertext_length' });
      try {
        await addEncryptedMessage(dealId, senderTelegramId, ciphertext);
      } catch (e) {
        return res.status(400).json({ error: String((e as Error).message || 'invalid_ciphertext') });
      }
      return res.json({ ok: true, encrypted: true });
    }

    if (!content) return res.status(400).json({ error: 'content_required' });
    if (content.length > 4000) return res.status(400).json({ error: 'content_too_long' });

    // Legacy plaintext path — encrypt server-side with per-deal key so DB never stores plaintext long-term
    // (future clients should always send ciphertext)
    const { addDealMessage } = await import('./services/dealService');
    await addDealMessage(dealId, senderTelegramId, content);
    return res.json({ ok: true, encrypted: true });
  }),
);

// Confirm endpoint — DEPRECATED alias to /approve (buyer-only)
// Legacy mutual confirm (both parties) removed. Web app should use POST /approve.
// Kept for TG fallback with deprecation warning. Always calls buyerApproveReceipt.
app.post(
  '/api/deals/:id/confirm',
  dealActionLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    logger.warn(
      `POST /api/deals/${sanitizeLogValue(dealId)}/confirm called by ${sanitizeLogValue(caller)} — deprecated, use /approve (buyer-only)`,
    );
    const { buyerApproveReceipt } = await import('./services/escrowService');
    const result: any = await buyerApproveReceipt(caller, dealId);
    res.setHeader('X-Deprecated', 'use POST /api/deals/:id/approve');
    if (!result.success) {
      if (result.needSellerAddress)
        return res.status(402).json({
          error: result.message,
          needSellerAddress: true,
          code: 'seller_ton_address_required',
          deprecated: true,
        });
      return res
        .status(400)
        .json({ error: result.message, deprecated: true, hint: 'Use web app: Deal -> Yes, received' });
    }
    return res.json({ ...result, deprecated: true, hint: 'Use POST /api/deals/:id/approve' });
  }),
);

// Seller signals "I sent the item" — webapp-first: moves DEPOSIT_CONFIRMED -> ITEM_SENT and notifies buyer via chat + bot
app.post(
  '/api/deals/:id/ship',
  dealActionLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const { markItemSent } = await import('./services/escrowService');
    const result: any = await markItemSent(caller, dealId);
    if (!result.success) {
      if (result.needSellerAddress)
        return res
          .status(402)
          .json({ error: result.message, needSellerAddress: true, code: 'seller_ton_address_required' });
      const msg = String(result.message || '');
      if (msg.includes('not_seller') || msg.includes('forbidden')) return res.status(403).json({ error: msg });
      if (msg.includes('already') || msg.includes('wrong_status') || msg.includes('concurrent'))
        return res.status(409).json({ error: msg });
      return res.status(400).json({ error: result.message });
    }
    return res.json(result);
  }),
);

// Buyer confirms receipt — webapp-first: moves ITEM_SENT -> RELEASED minus fee
// If seller TON address missing, returns 402 needSellerAddress so web app can prompt seller to set payout
app.post(
  '/api/deals/:id/approve',
  dealActionLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const { buyerApproveReceipt } = await import('./services/escrowService');
    const result: any = await buyerApproveReceipt(caller, dealId);
    if (!result.success) {
      if (result.needSellerAddress) {
        return res
          .status(402)
          .json({ error: result.message, needSellerAddress: true, code: 'seller_ton_address_required' });
      }
      if (result.needItemSent) {
        return res.status(409).json({ error: result.message, needItemSent: true, code: 'item_not_sent' });
      }
      const msg = String(result.message || '');
      if (msg.includes('payout_in_progress') || msg.includes('pending')) return res.status(409).json({ error: msg });
      if (msg.includes('not_buyer') || msg.includes('forbidden')) return res.status(403).json({ error: msg });
      return res.status(400).json({ error: result.message });
    }
    return res.json(result);
  }),
);

// Join requests — list pending for a deal (party/admin only)
app.get(
  '/api/deals/:id/join-requests',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
    const rows = await db.query(
      'SELECT * FROM deal_join_requests WHERE deal_id = $1 AND status = $2 ORDER BY created_at DESC',
      [dealId, 'pending'],
    );
    return res.json(rows.rows);
  }),
);

app.post(
  '/api/deals/:id/join-requests/:requestId/approve',
  rateLimit({ windowMs: 60_000, max: 20, name: 'join-approve' }),
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(dealId) || !Number.isInteger(requestId)) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const { approveJoinRequest } = await import('./services/dealService');
    try {
      const { role, autoRejected } = await approveJoinRequest(requestId, caller, dealId);
      // The deal is full now — tell the losers their invite is dead (best-effort each).
      if (Array.isArray(autoRejected) && autoRejected.length > 0) {
        for (const loser of autoRejected) {
          try {
            if (loser?.requester_telegram_id != null) {
              await notify.joinRejected(Number(loser.requester_telegram_id), { id: dealId, amount: '?', asset: '' });
            }
          } catch (e) {
            logger.warn(`auto-reject notify failed for deal #${sanitizeLogValue(dealId)}`, e);
          }
        }
        logger.info(
          `Deal #${sanitizeLogValue(dealId)} join approved — ${autoRejected.length} sibling request(s) auto-rejected`,
        );
      }
      try {
        await getDealChatKey(dealId);
      } catch {} // best-effort: chat key backfills lazily on first /key or message post.
      try {
        const { addDealMessage } = await import('./services/dealService');
        await addDealMessage(
          dealId,
          0,
          `Tizim: Deal boshlandi (Deal #${dealId}) — tomonlar kelishildi, to'lovni boshlang.`,
        );
      } catch {} // best-effort: join already approved above; chat mirror must not fail the response.
      try {
        const deal = await getDealById(dealId);
        if (deal) {
          const { getJoinRequestById } = await import('./services/dealService');
          let partnerId: number | null = null;
          try {
            const jr = await getJoinRequestById(requestId);
            if (jr && jr.requester_telegram_id != null) partnerId = Number(jr.requester_telegram_id);
          } catch {} // best-effort: partner lookup falls back to the deal's seller/buyer below.
          if (partnerId == null && deal.seller_telegram_id != null) partnerId = Number(deal.seller_telegram_id);
          if (partnerId == null && deal.buyer_telegram_id != null) partnerId = Number(deal.buyer_telegram_id);
          if (partnerId != null) {
            const uzRole = role === 'seller' ? 'sotuvchi' : 'xaridor';
            try {
              await notify.joinApproved(
                partnerId,
                {
                  id: deal.id,
                  amount: String(deal.amount),
                  asset: String(deal.asset),
                  terms: String(deal.terms || ''),
                },
                uzRole as 'sotuvchi' | 'xaridor',
              );
            } catch (e) {
              logger.warn(`joinApproved notify failed for deal #${sanitizeLogValue(dealId)}`, e);
            }
          }
          if (String(deal.status) === 'DEPOSIT_CONFIRMED' && deal.seller_telegram_id != null) {
            try {
              await notify.depositToSeller(Number(deal.seller_telegram_id), {
                id: deal.id,
                amount: String(deal.amount),
                asset: String(deal.asset),
                terms: String(deal.terms || ''),
              });
            } catch (e) {
              logger.warn(`Post-approve DEPOSIT_CONFIRMED notify failed for deal #${sanitizeLogValue(dealId)}`, e);
            }
            try {
              const { addDealMessage } = await import('./services/dealService');
              await addDealMessage(
                dealId,
                0,
                `Tizim: To'lov qabul qilindi (Deal #${dealId}) — ${deal.amount} ${deal.asset}.`,
              );
            } catch {}
          }
        }
      } catch (notifyErr) {
        logger.warn(`Post-approve notify failed for deal #${sanitizeLogValue(dealId)}`, notifyErr);
      }
      return res.json({ ok: true, role });
    } catch (e) {
      const msg = String((e as Error).message || 'approve_failed');
      if (msg === 'request_not_found') return res.status(404).json({ error: msg });
      if (msg.includes('deal_mismatch')) return res.status(400).json({ error: msg });
      if (msg.includes('deal_finished')) return res.status(409).json({ error: msg });
      if (msg.includes('not_authorized')) return res.status(403).json({ error: msg });
      if (msg.includes('already_handled')) return res.status(409).json({ error: msg });
      if (msg.includes('link_expired')) return res.status(410).json({ error: msg });
      if (msg.includes('deal_already_full')) return res.status(409).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
  }),
);

app.post(
  '/api/deals/:id/join-requests/:requestId/reject',
  rateLimit({ windowMs: 60_000, max: 20, name: 'join-reject' }),
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(dealId) || !Number.isInteger(requestId)) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const { rejectJoinRequest } = await import('./services/dealService');
    try {
      const { getJoinRequestById } = await import('./services/dealService');
      let partnerId: number | null = null;
      let dealForReject: any = null;
      try {
        const jr = await getJoinRequestById(requestId);
        if (jr && jr.requester_telegram_id != null) partnerId = Number(jr.requester_telegram_id);
        dealForReject = await getDealById(dealId);
      } catch {}
      await rejectJoinRequest(requestId, caller, dealId);
      try {
        if (partnerId != null && dealForReject) {
          await notify.joinRejected(partnerId, {
            id: dealForReject.id,
            amount: String(dealForReject.amount),
            asset: String(dealForReject.asset),
            terms: String(dealForReject.terms || ''),
          });
        }
      } catch (e) {
        logger.warn(`joinRejected notify failed for deal #${sanitizeLogValue(dealId)}`, e);
      }
      return res.json({ ok: true });
    } catch (e) {
      const msg = String((e as Error).message || 'reject_failed');
      if (msg === 'request_not_found') return res.status(404).json({ error: msg });
      if (msg.includes('deal_mismatch')) return res.status(400).json({ error: msg });
      if (msg.includes('not_authorized')) return res.status(403).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
  }),
);

// Joiner's own request status — lets the mini-app join page show pending /
// approved / rejected instead of polling blindly forever after a rejection.
// Token-scoped AND caller-bound: only the invite holder sees only their own row.
app.get(
  '/api/deals/:id/join-status',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const token = String((req.query.token as string) || '').trim();
    if (!Number.isInteger(dealId) || dealId <= 0 || !token) return res.status(400).json({ error: 'invalid_request' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const jr = await getMyJoinStatus(dealId, token, caller).catch(() => null);
    const isPartyNow =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    if (!jr) return res.json({ status: 'none', isPartyNow });
    return res.json({
      status: String(jr.status || 'pending'),
      requestId: jr.id,
      isPartyNow,
      updatedAt: jr.updated_at || null,
    });
  }),
);

// Requester profile photo — proxied bytes, party/admin only.
// The DB stores a Telegram file_id (never a file URL: URLs embed the bot token).
// The token stays server-side: we fetch upstream and stream bytes, never redirect.
app.get(
  '/api/deals/:id/join-requests/:requestId/photo',
  rateLimit({ windowMs: 60_000, max: 30, name: 'photo' }),
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(dealId) || !Number.isInteger(requestId)) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
    const jr = await getJoinRequestById(requestId).catch(() => null);
    if (!jr || Number(jr.deal_id) !== dealId) return res.status(404).json({ error: 'request_not_found' });
    const fileId = String((jr as any).requester_photo_file_id || '').trim();
    const bot = getBot();
    if (!fileId || !bot || !config.botToken) return res.status(404).json({ error: 'photo_not_available' });
    try {
      const file = await bot.api.getFile(fileId);
      if (!file?.file_path) return res.status(404).json({ error: 'photo_not_available' });
      const upstream = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let up: { ok: boolean; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };
      try {
        up = (await fetch(upstream, { signal: ctrl.signal })) as unknown as {
          ok: boolean;
          headers: { get(name: string): string | null };
          arrayBuffer(): Promise<ArrayBuffer>;
        };
      } finally {
        clearTimeout(timer);
      }
      if (!up.ok) return res.status(502).json({ error: 'photo_upstream_failed' });
      const buf = Buffer.from(await up.arrayBuffer());
      if (!buf.length || buf.length > 1024 * 1024) return res.status(502).json({ error: 'photo_upstream_failed' });
      res.setHeader('Content-Type', up.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(buf);
    } catch {
      return res.status(502).json({ error: 'photo_upstream_failed' });
    }
  }),
);

// Manual recheck — "Toldim, tekshiring" button: poll payment address once, return current status
app.post(
  '/api/deals/:id/recheck',
  joinLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isParty =
      (deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller) ||
      (deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller);
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isParty && !isAdminCaller) return res.status(403).json({ error: 'not_a_party_to_deal' });
    try {
      if (deal.payment_address) await recheckAddress(String(deal.payment_address));
    } catch (e) {
      logger.warn(`recheck failed for deal #${sanitizeLogValue(dealId)}`, e);
    }
    const fresh = await getDealById(dealId);
    return res.json({ status: fresh ? String(fresh.status) : String(deal.status) });
  }),
);

// ── CHANNEL/GROUP custodial escrow (via @gramchioka) — additive, P2P untouched ──
const channelLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'channel-verify' });
app.post(
  '/api/deals/:id/channel/verify',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isSeller && !isAdminCaller) return res.status(403).json({ error: 'only_seller_can_verify' });
    const dealType = String(deal.deal_type || 'P2P').toUpperCase();
    if (dealType !== 'CHANNEL' && dealType !== 'GROUP') return res.status(400).json({ error: 'not_channel_deal' });
    const { verifyChannelOwnershipForDeal } = await import('./services/escrowService');
    const result = await verifyChannelOwnershipForDeal(dealId, caller);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  }),
);
app.post(
  '/api/deals/:id/channel/request-escrow',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    if (String(deal.deal_type).toUpperCase() !== 'CHANNEL' && String(deal.deal_type).toUpperCase() !== 'GROUP')
      return res.status(400).json({ error: 'not_channel_deal' });
    const { requestTransferToEscrow } = await import('./services/escrowService');
    const r = await requestTransferToEscrow(dealId, caller);
    if (!r.ok) return res.status(400).json({ error: r.error });
    return res.json(r);
  }),
);
app.post(
  '/api/deals/:id/channel/confirm-escrow',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isSeller && !isAdminCaller) return res.status(403).json({ error: 'only_seller_can_confirm' });
    const { confirmTransferToEscrow } = await import('./services/escrowService');
    const r = await confirmTransferToEscrow(caller, dealId);
    if (!r.ok) return res.status(400).json({ error: r.error, detail: (r as any).currentCreatorId });
    return res.json(r);
  }),
);
app.post(
  '/api/deals/:id/channel/payout',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isSeller = deal.seller_telegram_id != null && Number(deal.seller_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isSeller && !isAdminCaller) return res.status(403).json({ error: 'only_seller_can_payout' });
    const rawAddr = String(
      (req.body as any).tonAddress || (req.body as any).ton_address || (req.body as any).address || '',
    ).trim();
    if (rawAddr) {
      try {
        Address.parse(rawAddr);
      } catch {
        return res.status(400).json({ error: 'invalid_ton_address' });
      }
      try {
        await db.query('UPDATE deals SET payout_address = $1, updated_at = now() WHERE id = $2', [rawAddr, dealId]);
      } catch (e) {
        logger.warn(`channel payout: payout_address persist failed for deal #${sanitizeLogValue(dealId)}`, e);
      }
      try {
        await db.query(
          `INSERT INTO users (telegram_id, username, ton_address) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET ton_address = EXCLUDED.ton_address`,
          [caller, (req as any).user?.username || null, rawAddr],
        );
      } catch (e) {
        logger.warn(`channel payout: ton_address upsert failed for user ${sanitizeLogValue(caller)}`, e);
      }
    }
    const { payoutSellerForChannel } = await import('./services/escrowService');
    const r: any = await payoutSellerForChannel(dealId, caller);
    if (!r.success) {
      if (String(r.error || '').includes('seller_ton_address_required'))
        return res.status(402).json({ error: r.error, code: 'seller_ton_address_required' });
      if (String(r.error || '').includes('escrow_not_yet_received'))
        return res.status(409).json({ error: r.error, code: 'escrow_not_yet_received' });
      return res.status(400).json({ error: r.error });
    }
    return res.json(r);
  }),
);
app.post(
  '/api/deals/:id/channel/set-new-owner',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isBuyer && !isAdminCaller) return res.status(403).json({ error: 'only_buyer_can_set_new_owner' });
    if (String(deal.status) !== 'RELEASED')
      return res.status(409).json({ error: `invalid_status ${deal.status} need RELEASED` });
    const raw = String(
      (req.body as any).newOwner || (req.body as any).new_owner || (req.body as any).username || '',
    ).trim();
    if (!raw) return res.status(400).json({ error: 'newOwner_required: enter @username' });
    const uname = raw.startsWith('@') ? raw : '@' + raw;
    if (!/^@[A-Za-z0-9_]{4,32}$/.test(uname)) return res.status(400).json({ error: 'invalid_username' });
    const { setPendingNewOwner } = await import('./services/dealService');
    await setPendingNewOwner(dealId, uname);
    try {
      const { addDealMessage } = await import('./services/dealService');
      await addDealMessage(dealId, caller, `Xaridor ${deal.channel_username} uchun yangi ega tanladi → ${uname}.`);
    } catch {} // best-effort: chat mirror; the pending_new_owner write above already succeeded.
    return res.json({ ok: true, pending_new_owner: uname });
  }),
);
app.post(
  '/api/deals/:id/channel/transfer-to-buyer',
  channelLimiter,
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const deal: any = await getDealById(dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    const isBuyer = deal.buyer_telegram_id != null && Number(deal.buyer_telegram_id) === caller;
    const isAdminCaller = (req as any).authMode === 'api-key' || isAdminTelegramId(caller);
    if (!isBuyer && !isAdminCaller) return res.status(403).json({ error: 'only_buyer_can_transfer' });
    const raw = String(
      (req.body as any).newOwner ||
        (req.body as any).new_owner ||
        (req.body as any).username ||
        deal.pending_new_owner ||
        '',
    ).trim();
    if (!raw) return res.status(400).json({ error: 'newOwner_required: call set-new-owner first' });
    const { transferChannelToBuyer } = await import('./services/escrowService');
    const r = await transferChannelToBuyer(dealId, raw, caller);
    if (!r.ok) {
      const status =
        r.error === 'fresh_forbidden_wait_24h' ? 429 : r.error === 'user_not_participant_try_invite' ? 409 : 400;
      if (status === 429) res.setHeader('Retry-After', '86400');
      return res.status(status).json({
        error: r.error,
        detail: (r as any).detail,
        hint:
          r.error === 'user_not_participant_try_invite'
            ? 'New owner must join channel first or add as contact'
            : undefined,
      });
    }
    return res.json(r);
  }),
);

// Global inbox — pending join requests across all deals where caller is party
app.get(
  '/api/inbox',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const rows = await db.query(
      `SELECT r.*, d.asset, d.amount, d.status as deal_status FROM deal_join_requests r
     JOIN deals d ON r.deal_id = d.id
     WHERE r.status = 'pending' AND (d.buyer_telegram_id = $1 OR d.seller_telegram_id = $1)
     ORDER BY r.created_at DESC LIMIT 100`,
      [caller],
    );
    return res.json(rows.rows);
  }),
);

// Monthly buyer leaderboard — completed (RELEASED) deals only, buyer side
// earns the rating. Public to any authenticated Mini App user.
app.get(
  '/api/rating',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const asset = String((req.query as any)?.asset || 'TON').toUpperCase();
    if (asset !== 'TON' && asset !== 'USDT') return res.status(400).json({ error: 'unsupported_asset' });
    const limitRaw = parseInt(String((req.query as any)?.limit || '50'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
    try {
      const { getMonthlyBuyerRating } = await import('./db/queries');
      const rows = await getMonthlyBuyerRating(asset, limit);
      const month = new Date().toISOString().slice(0, 7);
      return res.json({ month, asset, rows });
    } catch (e) {
      logger.warn('/api/rating error', e);
      return res.status(500).json({ error: 'rating_unavailable' });
    }
  }),
);

// --- Internal microservice proxies (host-bound, via backend) -------------------
// Generic helper to proxy to ubot/utrade with x-api-key server-side (keeps keys out of frontend)
async function proxyToService(serviceUrl: string, apiKey: string, req: Request, res: Response, targetPath: string) {
  const url = serviceUrl.replace(/\/+$/, '') + targetPath;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  // Forward idempotency if present
  const idemp = req.get('x-idempotency-key');
  if (idemp) headers['x-idempotency-key'] = idemp;
  const method = req.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body || {});
  try {
    const resp = await fetch(url, { method, headers, body } as any);
    const txt = await resp.text();
    let data: any = txt;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {} // best-effort: non-JSON upstream body is forwarded as raw text.
    res.status(resp.status);
    // Forward rate limit headers if present
    const rl = resp.headers.get('x-ratelimit-remaining');
    if (rl) res.setHeader('x-ratelimit-remaining', rl);
    const ra = resp.headers.get('retry-after');
    if (ra) res.setHeader('retry-after', ra);
    if (typeof data === 'object' && data !== null) return res.json(data);
    return res.send(data);
  } catch (e) {
    logger.warn(`proxy ${sanitizeLogValue(url)} failed`, e);
    return res.status(502).json({ error: 'upstream_unavailable', detail: String((e as Error).message || e) });
  }
}

// ubot proxy — locked down (fix 2.3): only safe read-only GETs are proxied.
// State-changing POST /channel/:id/{promote,transfer,takeover} must go via
// dedicated /api/deals/:id/channel/* routes which enforce deal ownership (seller/buyer + status).
// Raw takeover via generic proxy would allow any authenticated user to seize any channel.
const UBOT_SAFE_GET = [
  /^\/health\/?$/,
  /^\/channel\/[^/]+\/?$/,
  /^\/channel\/[^/]+\/admins\/?$/,
  /^\/group\/[^/]+\/isBasic\/?$/,
];
app.use(
  '/api/ubot',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const rawPath = req.originalUrl.replace(/^\/api\/ubot/, '') || '/';
    const pathOnly = rawPath.split('?')[0];
    const p = pathOnly.startsWith('/') ? pathOnly : '/' + pathOnly;
    const qIdx = req.originalUrl.indexOf('?');
    const q = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
    const finalPath = p + q;

    // Only allow safe read-only GETs via generic proxy
    if (req.method !== 'GET') {
      return res.status(403).json({
        error: 'ubot_proxy_forbidden',
        detail:
          'State-changing ubot calls must use dedicated /api/deals/:id/channel/* endpoints which verify deal ownership. Direct /api/ubot POST is disabled.',
      });
    }
    if (!UBOT_SAFE_GET.some((re) => re.test(p))) {
      return res.status(403).json({ error: 'ubot_proxy_path_not_allowed', detail: `GET ${p} not in ubot allowlist` });
    }
    return proxyToService(config.ubotUrl, config.ubotApiKey, req, res, finalPath);
  }),
);

// utrade — direct DB handlers (shared postgres pgdata, no need to proxy teleproto)
// Keep proxy fallback for /health but handle trade flows directly for UI
import crypto from 'crypto';
function utradeEncryptSession(plain: string): string {
  const key = getMasterKey();
  if (!key) {
    // Fail closed: never fall back to a hardcoded public key (was 'fallback-key-for-utrade-ui')
    throw new Error('encryption_not_configured: ENCRYPTION_KEY missing or invalid — refusing to encrypt session');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function utradeMaskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}

// Create trade — accepts {session} or {phone}
app.post(
  '/api/utrade/trades',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const { session, phone } = req.body as any;
    if (!session && !phone) return res.status(400).json({ error: 'session_or_phone_required' });
    let enc = '';
    try {
      if (session) {
        if (typeof session !== 'string' || session.trim().length < 10)
          return res.status(400).json({ error: 'invalid_session' });
        enc = utradeEncryptSession(String(session).trim());
      } else {
        // phone-only placeholder session — store phone as session placeholder
        enc = utradeEncryptSession('phone:' + String(phone).trim());
      }
    } catch (e) {
      const msg = String((e as Error).message || '');
      if (msg.includes('encryption_not_configured')) {
        return res
          .status(503)
          .json({ error: 'encryption_not_configured', detail: 'ENCRYPTION_KEY not set — utrade disabled' });
      }
      throw e;
    }
    // Ensure table exists (idempotent)
    try {
      await db.query('SELECT 1 FROM utrade_trades LIMIT 1');
    } catch {
      // best-effort probe: missing table is created below.
      await db.query(`CREATE TABLE IF NOT EXISTS utrade_trades (
      id SERIAL PRIMARY KEY, seller_telegram_id BIGINT NOT NULL, buyer_telegram_id BIGINT,
      phone TEXT, phone_enc TEXT, session_encrypted TEXT NOT NULL, status TEXT NOT NULL,
      buyer_code_hash TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, meta JSONB DEFAULT '{}'::jsonb
    ); CREATE TABLE IF NOT EXISTS utrade_events (id SERIAL PRIMARY KEY, trade_id INTEGER REFERENCES utrade_trades(id) ON DELETE CASCADE, actor_telegram_id BIGINT, event TEXT NOT NULL, meta JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now());`);
    }
    // If table pre-existed without phone_enc, add it
    try {
      await db.query('ALTER TABLE utrade_trades ADD COLUMN IF NOT EXISTS phone_enc TEXT');
    } catch {}
    const phPlain = phone ? String(phone).trim() : null;
    const phEnc = phPlain ? encryptField(phPlain) : null;
    // Fix 3.4: encrypt phone at rest via phone_enc; phone column kept null (plaintext removed)
    const r = await db.query(
      `INSERT INTO utrade_trades (seller_telegram_id, buyer_telegram_id, phone, phone_enc, session_encrypted, status, expires_at, meta)
      VALUES ($1,$2,$3,$4,$5,$6, now() + interval '24 hours', '{}'::jsonb) RETURNING id, status, created_at`,
      [caller, null, null, phEnc, enc, 'SELLER_REMOVED'],
    );
    try {
      await db.query('INSERT INTO utrade_events (trade_id, actor_telegram_id, event) VALUES ($1,$2,$3)', [
        r.rows[0].id,
        caller,
        'created_via_webapp',
      ]);
    } catch {} // best-effort: audit event; trade creation already succeeded.
    return res.json({ ok: true, trade: r.rows[0], id: r.rows[0].id });
  }),
);

app.get(
  '/api/utrade/trades/mine',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    try {
      const r = await db.query(
        'SELECT id, seller_telegram_id, buyer_telegram_id, phone, phone_enc, status, created_at, updated_at, completed_at FROM utrade_trades WHERE seller_telegram_id = $1 OR buyer_telegram_id = $1 ORDER BY id DESC LIMIT 50',
        [caller],
      );
      // Decrypt phone_enc for display (legacy rows may have plain phone)
      const rows = r.rows.map((row: any) => {
        let phonePlain: string | null = null;
        if (row.phone_enc) {
          try {
            phonePlain = decryptField(String(row.phone_enc));
          } catch {
            phonePlain = null;
          }
        } else if (row.phone) {
          phonePlain = String(row.phone);
        }
        // For mine, show full phone to owner; mask elsewhere but mine is owner
        return { ...row, phone: phonePlain };
      });
      return res.json(rows);
    } catch {
      return res.json([]);
    }
  }),
);

app.get(
  '/api/utrade/trades/:id',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
    const r = await db.query(
      'SELECT id, seller_telegram_id, buyer_telegram_id, phone, phone_enc, status, created_at, updated_at, completed_at, expires_at FROM utrade_trades WHERE id = $1',
      [id],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const trade = r.rows[0];
    // Decrypt phone_enc if present (fix 3.4)
    let phonePlain: string | null = null;
    if (trade.phone_enc) {
      try {
        phonePlain = decryptField(String(trade.phone_enc));
      } catch {
        phonePlain = null;
      }
    } else if (trade.phone) {
      phonePlain = String(trade.phone);
    }
    const tradeWithPhone = { ...trade, phone: phonePlain };
    // mask phone for non-owners
    const caller = getIdentityId(req);
    const isParty =
      caller !== null && (Number(trade.seller_telegram_id) === caller || Number(trade.buyer_telegram_id) === caller);
    const isAdminCaller = (req as any).authMode === 'api-key' || (caller !== null && isAdminTelegramId(caller));
    if (!isParty && !isAdminCaller) {
      return res.json({ ...tradeWithPhone, phone: utradeMaskPhone(String(phonePlain || '')) });
    }
    return res.json(tradeWithPhone);
  }),
);

app.post(
  '/api/utrade/trades/:id/phone',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const phone = String((req.body as any).phone || '').trim();
    if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/[\s-]/g, '')))
      return res.status(400).json({ error: 'invalid_phone' });
    const caller = getIdentityId(req);
    const r = await db.query('SELECT seller_telegram_id FROM utrade_trades WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    if (
      Number(r.rows[0].seller_telegram_id) !== caller &&
      (req as any).authMode !== 'api-key' &&
      !isAdminTelegramId(caller!)
    )
      return res.status(403).json({ error: 'not_seller' });
    try {
      await db.query('ALTER TABLE utrade_trades ADD COLUMN IF NOT EXISTS phone_enc TEXT');
    } catch {}
    const enc = encryptField(phone);
    await db.query('UPDATE utrade_trades SET phone = NULL, phone_enc = $1, updated_at = now() WHERE id = $2', [
      enc,
      id,
    ]);
    return res.json({ ok: true });
  }),
);

app.post(
  '/api/utrade/trades/:id/buyer',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const buyerId = Number((req.body as any).buyerId || (req.body as any).buyer_id);
    if (!isValidPositiveInt(buyerId)) return res.status(400).json({ error: 'buyerId_required' });
    const r = await db.query('SELECT seller_telegram_id, buyer_telegram_id FROM utrade_trades WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const caller = getIdentityId(req);
    if (
      Number(r.rows[0].seller_telegram_id) !== caller &&
      (req as any).authMode !== 'api-key' &&
      !isAdminTelegramId(caller!)
    )
      return res.status(403).json({ error: 'not_seller' });
    if (r.rows[0].buyer_telegram_id) return res.status(409).json({ error: 'buyer_already_set' });
    await db.query('UPDATE utrade_trades SET buyer_telegram_id = $1, updated_at = now() WHERE id = $2', [buyerId, id]);
    return res.json({ ok: true });
  }),
);

app.post(
  '/api/utrade/trades/:id/confirm-payment',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const r = await db.query('SELECT seller_telegram_id, status FROM utrade_trades WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const caller = getIdentityId(req);
    if (
      Number(r.rows[0].seller_telegram_id) !== caller &&
      (req as any).authMode !== 'api-key' &&
      !isAdminTelegramId(caller!)
    )
      return res.status(403).json({ error: 'not_seller' });
    const st = String(r.rows[0].status);
    if (st !== 'SELLER_REMOVED' && st !== 'AWAITING_PAYMENT')
      return res.status(400).json({ error: 'invalid_status_' + st });
    await db.query("UPDATE utrade_trades SET status = 'PHONE_SHARED', updated_at = now() WHERE id = $1", [id]);
    return res.json({ ok: true, status: 'PHONE_SHARED' });
  }),
);

app.post(
  '/api/utrade/trades/:id/code',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const code = String((req.body as any).code || '').trim();
    const password = (req.body as any).password ? String((req.body as any).password) : null;
    if (!/^\d{5,6}$/.test(code) && !password) return res.status(400).json({ error: 'code_required' });
    const r = await db.query('SELECT * FROM utrade_trades WHERE id = $1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    const trade = r.rows[0];
    const caller = getIdentityId(req);
    // Buyer slot must already be assigned (via explicit trade flow) — never
    // auto-bind the first caller to submit a code (prevents buyer hijack).
    if (!trade.buyer_telegram_id) {
      return res.status(403).json({ error: 'buyer_not_set: trade has no buyer yet' });
    }
    const isBuyer = caller !== null && Number(trade.buyer_telegram_id) === caller;
    if (!isBuyer && (req as any).authMode !== 'api-key') return res.status(403).json({ error: 'not_buyer' });
    const st = String(trade.status);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(st))
      return res.status(400).json({ error: 'trade_already_final', status: st });
    // Fix 3.4: never auto-complete via backend webapp — we cannot verify Telegram code without teleproto (utradebot).
    // Mark for manual review and log event; real verification must happen via utradebot teleproto.
    if (password) {
      await db.query(
        "UPDATE utrade_trades SET status = 'AWAITING_BUYER_LOGIN', updated_at = now(), meta = COALESCE(meta,'{}'::jsonb) || '{\"webapp_2fa_submitted\":true}'::jsonb WHERE id = $1",
        [id],
      );
      try {
        await db.query(
          'INSERT INTO utrade_events (trade_id, actor_telegram_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)',
          [id, caller, '2fa_submitted_via_webapp_manual_review', JSON.stringify({ hasPassword: true })],
        );
      } catch {} // best-effort: audit event; status update above already succeeded.
      return res.json({
        ok: true,
        status: 'AWAITING_BUYER_LOGIN',
        note: '2FA received but NOT verified — manual review / utradebot teleproto verification required. Trade NOT marked COMPLETED.',
      });
    }
    if (/^\d{5,6}$/.test(code)) {
      // First code submission moves PHONE_SHARED -> AWAITING_CODE; subsequent stays AWAITING_CODE (never COMPLETED)
      const newSt = st === 'PHONE_SHARED' ? 'AWAITING_CODE' : 'AWAITING_CODE';
      await db.query(
        `UPDATE utrade_trades SET status = $1, updated_at = now(), meta = COALESCE(meta,'{}'::jsonb) || '{"webapp_code_submitted":true}'::jsonb WHERE id = $2`,
        [newSt, id],
      );
      try {
        await db.query(
          'INSERT INTO utrade_events (trade_id, actor_telegram_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)',
          [id, caller, 'code_submitted_via_webapp_manual_review', JSON.stringify({ code: '***' })],
        );
      } catch {} // best-effort: audit event; status update above already succeeded.
      return res.json({
        ok: true,
        status: 'AWAITING_CODE',
        note: 'Code received but NOT verified — manual review / utradebot verification required. Trade NOT marked COMPLETED.',
        next: 'await_manual_review',
      });
    }
    return res.status(400).json({ error: 'invalid_code' });
  }),
);

// Fallback proxy for other utrade paths (e.g. /health) — keep for completeness
app.use(
  '/api/utrade-fallback',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const targetPath = req.originalUrl.replace(/^\/api\/utrade-fallback/, '') || '/';
    const p = targetPath.startsWith('/') ? targetPath : '/' + targetPath;
    const qIdx = req.originalUrl.indexOf('?');
    const q = qIdx !== -1 ? req.originalUrl.slice(qIdx) : '';
    const finalPath = p.split('?')[0] + q;
    return proxyToService(config.utradeUrl, config.utradeApiKey, req, res, finalPath);
  }),
);

// Withdraw endpoint (admin-only; guarded release via adminRelease)
app.post(
  '/api/withdraw',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { dealId } = req.body;
    const caller = getIdentityId(req);
    const adminId = caller ?? config.adminTelegramIds[0] ?? 0;
    const { adminRelease } = await import('./services/escrowService');
    const result = await adminRelease(Number(adminId), Number(dealId));
    return res.json(result);
  }),
);

// Refund endpoint (admin-only; guarded refund via adminRefund)
app.post(
  '/api/refund',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { dealId } = req.body;
    const caller = getIdentityId(req);
    const adminId = caller ?? config.adminTelegramIds[0] ?? 0;
    const { adminRefund } = await import('./services/escrowService');
    const result = await adminRefund(Number(adminId), Number(dealId));
    return res.json(result);
  }),
);

app.get(
  '/api/status/:address',
  publicTonLimiter,
  asyncHandler(async (req, res) => {
    // Off-chain ledger mode (no escrow contracts deployed): there is nothing
    // on-chain to query. Answer locally — calling Escrow.getStatus on a
    // non-escrow address (e.g. the signer W5 wallet) always fails with
    // exit_code 11 and only spams the log + wastes TON API quota.
    if (!config.requireOnchain) return res.json({ status: null, onchain: false, mode: 'offchain' });
    try {
      const addr = Address.parse(String(req.params.address));
      const escrow = new Escrow(addr as any);
      const opened = openContract(escrow, ({ address: a }) => client.provider(a, null as any));
      const status = await opened.getStatus();
      return res.json({ status, onchain: true });
    } catch (err) {
      logger.warn('/api/status error', err);
      return res.status(500).json({ error: String(err) });
    }
  }),
);

// TON wallet balance — public, proxied via backend to keep TONCENTER_API_KEY server-side
// Supports both raw (0:hex) and friendly (EQ/UQ) addresses; returns balance in nanotons + TON
app.get(
  '/api/balance/:address',
  publicTonLimiter,
  asyncHandler(async (req, res) => {
    const raw = String(req.params.address || '').trim();
    if (!raw) return res.status(400).json({ error: 'address_required' });
    try {
      const addr = Address.parse(raw);
      const state = await client.getContractState(addr);
      // state.balance is bigint (nanotons), state.state is 'active'|'uninitialized'|'frozen'
      const balanceNano = state.balance.toString();
      // Use BigInt math to avoid Number precision loss
      const nano = state.balance;
      const whole = nano / 1000000000n;
      const frac = nano % 1000000000n;
      const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
      const balanceTon = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
      return res.json({
        address: addr.toString({ urlSafe: true, bounceable: false }),
        addressRaw: `${addr.workChain}:${addr.hash.toString('hex')}`,
        balance: balanceNano,
        balanceTon,
        state: state.state,
        network: config.tonNetwork,
      });
    } catch (err) {
      logger.warn('/api/balance error for ' + sanitizeLogValue(raw), err);
      return res.status(400).json({ error: 'invalid_address', detail: String((err as Error).message || err) });
    }
  }),
);

// TON payload helpers — require identity (chosen-plaintext encryption oracle otherwise)
app.get(
  '/api/ton/payload',
  requireIdentity,
  publicTonLimiter,
  asyncHandler(async (req, res) => {
    const comment = String(req.query.comment || '').trim();
    if (!comment) return res.status(400).json({ error: 'comment_required' });
    if (comment.length > 120) return res.status(400).json({ error: 'comment_too_long', max: 120 });
    const payload = encryptedCommentToPayloadB64(comment);
    return res.json({
      payload,
      format: 'base64',
      encrypted: true,
      note: 'Memo is encrypted and auto-injected — do not display to user',
    });
  }),
);

// Deal-specific TON payloads (deposit + release) — party-only (token preview allowed for invitees)
app.get(
  '/api/deals/:id/payload',
  requireIdentity,
  asyncHandler(async (req, res) => {
    const dealId = Number(req.params.id);
    if (!Number.isInteger(dealId) || dealId <= 0) return res.status(400).json({ error: 'invalid_id' });
    const caller = getIdentityId(req);
    if (caller === null) return res.status(401).json({ error: 'identity_required' });
    const check = await checkDealAccess(req, dealId);
    if (!check) return res.status(404).json({ error: 'deal_not_found' });
    if (!check.hasAccess) return res.status(403).json({ error: 'not_a_party_to_deal' });
    const deal = check.deal;
    const memo = depositComment(dealId);
    const outMemo = releaseComment({ id: dealId, amount: deal.amount, asset: deal.asset, terms: deal.terms });
    const depositPayload = encryptedCommentToPayloadB64(memo);
    const releasePayload = encryptedCommentToPayloadB64(outMemo);
    let jettonPayload: string | null = null;
    if (String(deal.asset).toUpperCase() !== 'TON') {
      try {
        const payAddr = String(deal.payment_address || resolvePaymentAddress() || '0:' + '00'.repeat(32));
        const { encryptField } = await import('./utils/encryption');
        jettonPayload = jettonTransferPayload({
          amount: BigInt(toBaseUnits(String(deal.amount), String(deal.asset).toUpperCase())),
          destination: Address.parse(payAddr),
          forwardComment: encryptField(memo),
          forwardTonAmount: BigInt(1000000),
        });
      } catch {
        jettonPayload = null;
      } // best-effort: optional payload; response still carries TON payloads.
    }
    return res.json({
      dealId,
      asset: deal.asset,
      amount: deal.amount,
      depositPayload,
      releasePayload,
      jettonPayload,
      paymentAddress: deal.payment_address || resolvePaymentAddress(),
      memoEncrypted: true,
    });
  }),
);

// --- API Documentation (self-describing) ------------------------------------
const API_DOCS = {
  name: 'TON Escrow Bot — REST API',
  version: '1.0.0',
  baseUrl: '/api',
  auth: {
    telegram:
      'x-init-data (HMAC-SHA256 via BOT_TOKEN) + x-telegram-user-id — verified in src/auth/initData.ts, 24h window',
    apiKey: 'x-api-key: <API_KEY> header only (timing-safe, see src/auth/guard.ts)',
    devFallback:
      'x-telegram-user-id only when ALLOW_DEV_AUTH=true and BOT_TOKEN+API_KEY unset (never in prod; NODE_ENV=production refuses to start without auth)',
    admin: 'Telegram id in ADMIN_TELEGRAM_IDS or any api-key caller',
  },
  rateLimits:
    'global 300/min · create deal 10/min · join/recheck 20/min · chat post 60/min · notify 5/min · deal confirm/ship/approve 20/min · public TON status/balance/payload 30/min (sliding window per IP+route, in-memory per process)',
  endpoints: [
    {
      method: 'GET',
      path: '/api/info',
      auth: 'public',
      desc: 'Health + feeBps, paymentAddress, network, adminTelegramIds, encryption',
    },
    { method: 'GET', path: '/tonconnect-manifest.json', auth: 'public', desc: 'TON Connect manifest (dynamic origin)' },
    { method: 'GET', path: '/api/docs', auth: 'public', desc: 'This doc (JSON)' },
    { method: 'GET', path: '/api/openapi.json', auth: 'public', desc: 'OpenAPI 3.0 spec (machine-readable)' },
    {
      method: 'GET',
      path: '/api/swagger',
      auth: 'public',
      desc: 'Swagger UI — interactive docs + Try it out (backed by /api/openapi.json)',
    },
    { method: 'GET', path: '/docs', auth: 'public', desc: 'Human HTML docs (try it)' },
    {
      method: 'GET',
      path: '/api/deals',
      auth: 'Identity (party or admin)',
      desc: 'List deals where caller is buyer/seller (admin sees all) — private',
    },
    {
      method: 'GET',
      path: '/api/deals/:id',
      auth: 'Identity (party or admin, token preview)',
      desc: 'Single deal by id — only buyer/seller/admin or valid invite token ?token=',
    },
    {
      method: 'GET',
      path: '/api/deals/mine',
      auth: 'Identity',
      desc: 'Alias for GET /api/deals — deals where caller is buyer or seller (requires x-init-data or x-api-key)',
    },
    {
      method: 'POST',
      path: '/api/deals',
      auth: 'Identity',
      desc: 'Create deal {role: buy|sell, asset TON|USDT, amount, terms?, deadline?} — caller becomes buyer (buy) or seller (sell), counterparty joins via link, returns {deal, link, webappLink, encryption}',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/join/:token',
      auth: 'Identity',
      desc: 'Request to join via link — creates pending request for creator approval in deal chat (joiner fills empty slot)',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/invite',
      auth: 'Identity (party)',
      desc: 'Mint or reuse a 15-minute one-time invite link — for the deal-view share button',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/confirm',
      auth: 'Identity (party)',
      desc: 'DEPRECATED alias to /approve — buyer-only approveReceipt. Use POST /api/deals/:id/approve (was mutual, now buyer only)',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/join-requests',
      auth: 'Identity (party or admin)',
      desc: 'List pending join requests for deal — creator approves inside mini-app deal chat',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/join-requests/:requestId/approve',
      auth: 'Identity (party)',
      desc: 'Approve join request from deal chat → joiner fills empty slot + link consumed + chat key ensured + siblings auto-rejected',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/join-status?token=',
      auth: 'Identity',
      desc: 'Joiner own request status (none|pending|approved|rejected) — token-scoped, caller-bound',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/join-requests/:requestId/photo',
      auth: 'Identity (party or admin)',
      desc: 'Requester profile photo bytes proxied server-side (bot token never leaves server)',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/join-requests/:requestId/reject',
      auth: 'Identity (party)',
      desc: 'Reject join request',
    },
    {
      method: 'GET',
      path: '/api/inbox',
      auth: 'Identity',
      desc: 'Global inbox — all pending join requests across caller deals',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/key',
      auth: 'Identity (party or admin)',
      desc: 'Get per-deal E2E chat key {key, algo: aes-256-gcm} — only buyer/seller/admin',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/chat',
      auth: 'Identity (party or admin)',
      desc: 'Deal chat messages — ciphertext only (E2E). Decrypt client-side with per-deal key. ?limit=1..200',
    },
    {
      method: 'POST',
      path: '/api/deals/:id/chat',
      auth: 'Identity (party or admin)',
      desc: 'Post E2E ciphertext {ciphertext: base64(iv+tag+enc)} — server never sees plaintext. Legacy {content} also accepted and E2E-encrypted server-side',
    },
    {
      method: 'GET',
      path: '/api/ubot/channel/:id',
      auth: 'Identity (proxy to ubot 127.0.0.1:3002)',
      desc: 'Channel info via locked-down proxy — only GET /channel/:id, /admins, /health, /group/isBasic (POST via /api/deals/:id/channel/* only)',
    },
    {
      method: 'GET',
      path: '/api/ubot/channel/:id/admins',
      auth: 'Identity',
      desc: 'List channel admins via locked proxy (GET only)',
    },
    {
      method: 'POST',
      path: '/api/ubot/channel/:id/promote',
      auth: 'Identity',
      desc: 'DEPRECATED via raw proxy — use POST /api/deals/:id/channel/* (deal ownership required). Raw POST now 403.',
    },
    {
      method: 'POST',
      path: '/api/ubot/channel/:id/takeover',
      auth: 'Identity',
      desc: 'DEPRECATED raw proxy — use POST /api/deals/:id/channel/transfer-to-buyer (deal ownership + status=RELEASED). Raw POST 403.',
    },
    {
      method: 'POST',
      path: '/api/utrade/trades',
      auth: 'Identity',
      desc: 'Create account sale trade {session StringSession or phone:+E.164} — encrypted AES-256-GCM',
    },
    {
      method: 'GET',
      path: '/api/utrade/trades/mine',
      auth: 'Identity',
      desc: 'List my account trades (seller or buyer)',
    },
    {
      method: 'GET',
      path: '/api/utrade/trades/:id',
      auth: 'Identity',
      desc: 'Get account trade by id (phone masked for non-party)',
    },
    {
      method: 'POST',
      path: '/api/utrade/trades/:id/code',
      auth: 'Identity (buyer)',
      desc: 'Submit 5-6 digit code / 2FA → AWAITING_CODE / AWAITING_BUYER_LOGIN (manual review via utradebot teleproto, never auto-COMPLETED via backend)',
    },
    { method: 'POST', path: '/api/notify', auth: 'Admin', desc: 'Send bot message {chatId, message} — rate 5/min' },
    { method: 'GET', path: '/api/notifications', auth: 'Admin', desc: 'Last 200 notifications' },
    {
      method: 'POST',
      path: '/api/withdraw',
      auth: 'Admin',
      desc: 'Release (custodial signer payout, guarded DB → RELEASED)',
    },
    { method: 'POST', path: '/api/refund', auth: 'Admin', desc: 'Refund (guarded DB → REFUNDED)' },
    {
      method: 'GET',
      path: '/api/status/:address',
      auth: 'public',
      desc: 'Legacy status read (custodial mode returns {mode:offchain}; REQUIRE_ONCHAIN=true attempts on-chain read)',
    },
    {
      method: 'GET',
      path: '/api/balance/:address',
      auth: 'public',
      desc: 'TON wallet balance via TONCenter (nanotons + TON, state)',
    },
    {
      method: 'GET',
      path: '/api/ton/payload',
      auth: 'public',
      desc: 'Encode comment to TON Connect payload {comment, payload: base64} — memo for ALL TON tx',
    },
    {
      method: 'GET',
      path: '/api/deals/:id/payload',
      auth: 'Identity (party or admin, token preview)',
      desc: 'Deal-specific payloads: depositPayload/releasePayload (+ jettonPayload for USDT) with memo — party/admin or ?token=',
    },
  ],
  internalServices: {
    signer: {
      url: 'http://signer:3001 (internal, NOT published)',
      endpoints: [
        'GET /health (open)',
        'GET /address (x-api-key)',
        'GET /info (x-api-key)',
        'POST /send {to,value,comment?}',
        'POST /send-batch {requests[]}',
        'POST /deploy',
        'POST /deploy-escrow {escrowAddress, escrowStateInit{codeBoc,dataBoc}, value, bodyBoc}',
      ],
    },
    ubot: {
      url: 'http://ubot:3002 (internal)',
      endpoints: [
        'GET /health (open)',
        'GET /channel/:id, /channel/:id/admins (x-api-key)',
        'POST /channel/:id/promote {userId,rights?,rank?}',
        'POST /channel/:id/transfer {newOwnerId,password?}',
        'POST /channel/:id/takeover {newOwnerId,password?}',
        'POST /group/:id/promote|transfer|takeover',
        'GET /group/:id/isBasic, POST /group/:id/migrate',
      ],
    },
    utradebot: {
      url: 'http://utradebot:3003 (internal)',
      endpoints: [
        'GET /health (open)',
        'GET /api/trades/:id (x-api-key if set)',
        'Telegram bot: /start, /sell, /buy, /mytrades, /setphone, /setbuyer, /help',
      ],
    },
  },
  headers: {
    'x-init-data': 'Telegram WebApp initData (required for Identity when not api-key)',
    'x-telegram-user-id': 'Fallback when api-key/dev only',
    'x-api-key': 'Shared secret if API_KEY set',
    'x-signer-key / x-api-key (signer)': 'SIGNER_API_KEY',
    'x-ubot-key / x-api-key (ubot)': 'UBOT_API_KEY',
  },
  notes: [
    'Mini App served at /#/deal/:id/join/:token deep links; requires WEBAPP_URL=https://<public> for Telegram menu button — invite uses WEBAPP_URL when set, else request Host (no Host-header injection)',
    'Seller-buyer chat encryption at rest: per-deal AES-256-GCM key (server generates, encrypts with ENCRYPTION_KEY), messages are ciphertext-only. Server holds master key so can decrypt — protects DB dump, but not malicious operator (not true E2E against server compromise). See docs/THREAT_MODEL.md',
    'Join is atomic (BEGIN FOR UPDATE): one-time link cannot be double-consumed, role assignment guarded with WHERE IS NULL. Payouts also use SELECT FOR UPDATE + guarded UPDATE WHERE status to prevent double-payout.',
    'Rate limiters and listener cursors/monitoredAddresses are in-memory per-process (plus persisted cursors for crash recovery) — if scaled horizontally, use Redis/shared DB for global limits.',
    'Custodial model: funds sit in the signer W5 wallet; Postgres is the source of truth. There is no on-chain per-deal contract — GET /api/status/:address and contractDeployer are legacy stubs kept for compat.',
    'Postgres: deals, users, messages, deal_links, notifications, listener_cursors + utrade_trades/utrade_events (shared volume pgdata)',
    'See backend/README.md for full env table and auth legend',
  ],
};

app.get('/api/docs', (_req, res) => {
  res.json(API_DOCS);
});

// Swagger UI — interactive API docs. Loads the live spec from /api/openapi.json
// (single source of truth, same origin), so Try-it-out targets the right host.
app.use(
  '/api/swagger',
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    explorer: true,
    customSiteTitle: 'TON Escrow — Swagger UI',
    swaggerUrl: '/api/openapi.json',
  }),
);

app.get('/api/openapi.json', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  const servers = [{ url: `${scheme}://${host}` }];
  // Minimal OpenAPI 3.0 from API_DOCS
  const paths: Record<string, unknown> = {};
  for (const ep of API_DOCS.endpoints) {
    const p = ep.path.replace(/:(\w+)/g, '{$1}');
    if (!paths[p]) paths[p] = {};
    const m = ep.method.toLowerCase();
    (paths[p] as Record<string, unknown>)[m] = {
      summary: ep.desc,
      tags: [ep.auth],
      responses: { '200': { description: 'OK' } },
    };
  }
  res.json({
    openapi: '3.0.3',
    info: { title: API_DOCS.name, version: API_DOCS.version },
    servers,
    paths,
    components: {
      securitySchemes: {
        initData: { type: 'apiKey', in: 'header', name: 'x-init-data' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
  });
});

app.get('/docs', (_req, res) => {
  res.type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TON Escrow — API Docs</title><style>
  *{box-sizing:border-box}body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#0b0e14;color:#e6e8eb}
  a{color:#6aa8ff}header{padding:24px 20px;border-bottom:1px solid #1f2533;background:#0f131d;position:sticky;top:0}
  h1{margin:0;font-size:22px}h2{margin:28px 0 12px;font-size:18px;color:#8ab4ff}code{background:#1a2030;padding:2px 6px;border-radius:6px;font-size:13px}
  .wrap{max-width:1080px;margin:0 auto;padding:20px}table{width:100%;border-collapse:collapse;background:#111827;border:1px solid #1f2533;border-radius:10px;overflow:hidden}
  th,td{padding:10px 12px;border-bottom:1px solid #1f2533;text-align:left;font-size:14px}th{background:#0f131d;color:#8ab4ff}tr:last-child td{border-bottom:none}
  .tag{padding:2px 8px;border-radius:999px;font-size:12px;background:#1a2030;border:1px solid #2a3550}
  .auth-public{color:#7dd3a5}.auth-Identity{color:#f0c27a}.auth-Admin{color:#ff8a8a}
  pre{white-space:pre-wrap;background:#0f131d;border:1px solid #1f2533;padding:14px;border-radius:10px;overflow:auto}
  </style></head><body><header><div class="wrap"><h1>TON Escrow Bot — API Docs</h1><div style="opacity:.7;margin-top:6px">Base: <code>/api</code> · <a href="/api/swagger">Swagger UI</a> · <a href="/api/docs">/api/docs</a> (JSON) · <a href="/api/openapi.json">/api/openapi.json</a> · <a href="/api/info">/api/info</a></div></div></header><div class="wrap">
  <h2>Auth</h2><pre>${JSON.stringify(API_DOCS.auth, null, 2)}</pre>
  <h2>Rate limits</h2><p><code>${API_DOCS.rateLimits}</code></p>
  <h2>Endpoints</h2><table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody id="rows"></tbody></table>
  <h2>Internal services (docker network escrow-net, not published)</h2><pre id="internal"></pre>
  <h2>Headers</h2><pre id="headers"></pre>
  <h2>Try</h2><p>Health: <code>curl http://localhost:3000/api/info</code> · Docs JSON: <code>curl http://localhost:3000/api/docs</code></p>
  <pre id="try"></pre>
  </div><script>
  fetch('/api/docs').then(r=>r.json()).then(d=>{
    const tbody=document.getElementById('rows');
    for(const ep of d.endpoints){
      const tr=document.createElement('tr');
      tr.innerHTML='<td><code>'+ep.method+'</code></td><td><code>'+ep.path+'</code></td><td><span class="tag auth-'+ep.auth.split(/[ (]/)[0]+'">'+ep.auth+'</span></td><td>'+ep.desc+'</td>';
      tbody.appendChild(tr);
    }
    document.getElementById('internal').textContent=JSON.stringify(d.internalServices,null,2);
    document.getElementById('headers').textContent=JSON.stringify(d.headers,null,2);
    document.getElementById('try').textContent='curl -H "x-api-key: $API_KEY" http://localhost:3000/api/deals/mine\\n\\n# with Telegram initData (Mini App):\\ncurl -H "x-init-data: $INIT_DATA" -H "x-telegram-user-id: 123" http://localhost:3000/api/deals';
  }).catch(e=>{document.body.innerHTML+='<pre>'+e+'</pre>'});
  </script></body></html>`);
});

// JSON 500 for anything that slipped past a handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled API error', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// --- Micro-architecture: backend is API-only, frontend is separate nginx service (webapp:80 -> 8080) ---
// For local dev without frontend, set SERVE_STATIC=true to re-enable static serving.
if (config.serveStatic) {
  const publicDir = path.resolve(__dirname, '..', '..', 'webapp', 'public');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    next();
  });
  app.use('/', express.static(publicDir));
  logger.info('SERVE_STATIC=true — backend also serving webapp/public (dev fallback)');
} else {
  // API-only root — point to frontend and docs
  app.get('/', (_req, res) => {
    res.json({
      service: 'escrow-backend',
      mode: 'micro-architecture: API-only (frontend separate)',
      frontend: config.frontendUrl,
      docs: '/api/docs',
      htmlDocs: '/docs',
      openapi: '/api/openapi.json',
      swagger: '/api/swagger',
      health: '/api/info',
      note: 'Frontend (Telegram Mini App) runs as separate service webapp:80 -> host :8080, proxies /api to this backend',
    });
  });
}

const port = Number(process.env.PORT || 3000);
let server: Server | null = null;

function dealLikeForNotify(d: any): { id: number | string; amount: string | number; asset: string; terms?: string } {
  return { id: d.id, amount: String(d.amount ?? '0'), asset: String(d.asset ?? 'TON'), terms: d.terms ?? undefined };
}

function isDisputedDeal(d: any): boolean {
  try {
    const c = (d as any).confirmations as Record<string, unknown> | null | undefined;
    return !!(c && (c as any).disputed === true);
  } catch {
    return false;
  }
}

/** Schedulers: expiry + reminders, every 5 min, unref'd. */
function startSchedulers() {
  const run = async () => {
    try {
      // (a) close AWAITING_DEPOSIT older than 10h (fixed deal lifetime).
      // The full deal record (deal, messages, parties) stays in the DB — only
      // the status flips to REFUNDED + confirmations.autoClosed, so the app
      // shows "Yopildi" while nothing is deleted from the server.
      try {
        const old = await db.query(
          `SELECT * FROM deals WHERE status = 'AWAITING_DEPOSIT' AND created_at < now() - interval '10 hours' LIMIT 100`,
        );
        for (const d of old.rows) {
          if (isDisputedDeal(d)) continue;
          if (String(d.status) === 'RELEASED' || String(d.status) === 'REFUNDED') continue;
          try {
            const closed = await updateDealStatus(Number(d.id), 'REFUNDED', undefined, ['AWAITING_DEPOSIT']);
            if (!closed) continue;
            try {
              await db.query(
                `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || '{"autoClosed":true}'::jsonb, updated_at = now() WHERE id = $1`,
                [d.id],
              );
            } catch {}
            const msg = `10 soat to'lov bo'lmagani uchun yopildi`;
            const like = dealLikeForNotify(d);
            if (d.buyer_telegram_id != null) {
              try {
                await notify.adminDecisionToParty(Number(d.buyer_telegram_id), like, msg);
              } catch {}
            }
            if (d.seller_telegram_id != null) {
              try {
                await notify.adminDecisionToParty(Number(d.seller_telegram_id), like, msg);
              } catch {}
            }
            try {
              const { addDealMessage } = await import('./services/dealService');
              await addDealMessage(Number(d.id), 0, `Tizim: 10 soat to'lov bo'lmagani uchun yopildi (Deal #${d.id}).`);
            } catch {}
            try {
              const { saveAdminAlert } = await import('./db/queries');
              await saveAdminAlert('auto_close', `Deal #${d.id} 10 soat to'lovsiz yopildi (REFUNDED+autoClosed)`, {
                dealId: Number(d.id),
              });
            } catch {}
          } catch (e) {
            logger.warn(`expiry close failed for deal #${sanitizeLogValue(d.id)}`, e);
          }
        }
      } catch (e) {
        logger.warn('expiry scheduler failed', e);
      }

      // (b1) AWAITING_DEPOSIT with both parties, older 1h, !remPay -> reminderToPayer
      try {
        const q1 = await db.query(
          `SELECT * FROM deals WHERE status = 'AWAITING_DEPOSIT'
           AND buyer_telegram_id IS NOT NULL AND seller_telegram_id IS NOT NULL
           AND created_at < now() - interval '1 hour'
           AND (confirmations->>'remPay' IS NULL OR confirmations->>'remPay' != 'true')
           AND (confirmations->>'disputed' IS NULL OR confirmations->>'disputed' != 'true')
           LIMIT 100`,
        );
        for (const d of q1.rows) {
          if (isDisputedDeal(d)) continue;
          try {
            await notify.reminderToPayer(Number(d.buyer_telegram_id), dealLikeForNotify(d));
            await db.query(
              `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || '{"remPay":true}'::jsonb, updated_at = now() WHERE id = $1`,
              [d.id],
            );
          } catch (e) {
            logger.warn(`remPay failed for deal #${sanitizeLogValue(d.id)}`, e);
          }
        }
      } catch (e) {
        logger.warn('remPay scheduler failed', e);
      }

      // (b2) DEPOSIT_CONFIRMED older 3h, !remShip -> reminderToShipper
      try {
        const q2 = await db.query(
          `SELECT * FROM deals WHERE status = 'DEPOSIT_CONFIRMED'
           AND created_at < now() - interval '3 hours'
           AND (confirmations->>'remShip' IS NULL OR confirmations->>'remShip' != 'true')
           AND (confirmations->>'disputed' IS NULL OR confirmations->>'disputed' != 'true')
           LIMIT 100`,
        );
        for (const d of q2.rows) {
          if (isDisputedDeal(d)) continue;
          if (d.seller_telegram_id == null) continue;
          try {
            await notify.reminderToShipper(Number(d.seller_telegram_id), dealLikeForNotify(d));
            await db.query(
              `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || '{"remShip":true}'::jsonb, updated_at = now() WHERE id = $1`,
              [d.id],
            );
          } catch (e) {
            logger.warn(`remShip failed for deal #${sanitizeLogValue(d.id)}`, e);
          }
        }
      } catch (e) {
        logger.warn('remShip scheduler failed', e);
      }

      // (b3) ITEM_SENT older 3h, !remConfirm -> reminderToConfirmer
      try {
        const q3 = await db.query(
          `SELECT * FROM deals WHERE status = 'ITEM_SENT'
           AND created_at < now() - interval '3 hours'
           AND (confirmations->>'remConfirm' IS NULL OR confirmations->>'remConfirm' != 'true')
           AND (confirmations->>'disputed' IS NULL OR confirmations->>'disputed' != 'true')
           LIMIT 100`,
        );
        for (const d of q3.rows) {
          if (isDisputedDeal(d)) continue;
          if (d.buyer_telegram_id == null) continue;
          try {
            await notify.reminderToConfirmer(Number(d.buyer_telegram_id), dealLikeForNotify(d));
            await db.query(
              `UPDATE deals SET confirmations = COALESCE(confirmations,'{}'::jsonb) || '{"remConfirm":true}'::jsonb, updated_at = now() WHERE id = $1`,
              [d.id],
            );
          } catch (e) {
            logger.warn(`remConfirm failed for deal #${sanitizeLogValue(d.id)}`, e);
          }
        }
      } catch (e) {
        logger.warn('remConfirm scheduler failed', e);
      }
    } catch (e) {
      logger.warn('scheduler run failed', e);
    }
  };
  const timer = setInterval(
    () => {
      void run();
    },
    5 * 60 * 1000,
  );
  (timer as unknown as { unref?: () => void }).unref?.();
  logger.info('Schedulers started (expiry + reminders, 5 min)');
}

async function boot() {
  // Fail-closed encryption: refuse to boot in production without a valid master key
  // (would otherwise store chat keys/memos/phone in plaintext silently).
  try {
    assertEncryptionForStrictEnv();
  } catch (err) {
    logger.error(`FATAL: ${(err as Error).message}`);
    process.exit(1);
  }
  warnIfEncryptionDisabledOnce();
  // Fix 3.3: fail closed in production if no auth configured and dev not explicitly allowed
  if (process.env.NODE_ENV === 'production' && !config.botToken && !config.apiKey && !config.allowDevAuth) {
    logger.error(
      'FATAL: NODE_ENV=production but BOT_TOKEN and API_KEY are both unset and ALLOW_DEV_AUTH != true — would run with open auth. Refusing to start.',
    );
    process.exit(1);
  }
  if (!config.botToken && !config.apiKey && !config.allowDevAuth) {
    logger.warn(
      'WARNING: BOT_TOKEN and API_KEY unset and ALLOW_DEV_AUTH != true — all identity routes will 401 until configured (dev header ignored)',
    );
  }
  // Retry DB with backoff — handles postgres "starting up" after unclean shutdown (40s recovery)
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await connectDB();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt === 6) break;
      const delay = attempt * 3000; // 3s, 6s, 9s, 12s, 15s = ~45s total covers worst recovery
      logger.warn(`DB connect failed (attempt ${attempt}/6), retrying in ${delay}ms`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (lastErr) throw lastErr;

  // Crash-safety: flag PENDING payouts left by a crash for MANUAL admin review.
  // Never auto-retries (the transfer may already have landed — see escrowService).
  try {
    const { reconcileStuckPayouts } = await import('./services/escrowService');
    const stuck = await reconcileStuckPayouts(15);
    if (stuck > 0) logger.warn(`Boot: ${stuck} deal(s) stuck in payout-pending — flagged for manual reconciliation`);
  } catch (err) {
    logger.warn('Boot payout reconciliation failed (non-fatal)', err);
  }

  if (config.botToken) {
    try {
      await startBot();
    } catch (err) {
      logger.error('Bot failed to start — continuing without Telegram polling', err);
    }
  } else {
    logger.warn('BOT_TOKEN not set — /api/notify will return 503');
  }
  try {
    await startListener();
  } catch (err) {
    logger.error('Blockchain listener failed to start', err);
  }
  try {
    startSchedulers();
  } catch (err) {
    logger.error('Schedulers failed to start', err);
  }
  server = app.listen(port, () => logger.info(`Server listening on http://localhost:${port}`));
}

boot().catch((err) => {
  logger.error('Could not initialize DB after retries', err);
  server = app.listen(port, () => logger.info(`Server listening (DB not ready) on http://localhost:${port}`));
  // Background retry: if DB comes up later, warm it and try to start bot
  let bgAttempts = 0;
  const bgRetry = setInterval(async () => {
    bgAttempts++;
    if (bgAttempts > 12) {
      clearInterval(bgRetry);
      return;
    }
    try {
      await connectDB();
      logger.info('Background DB retry succeeded — starting bot/listener');
      clearInterval(bgRetry);
      if (config.botToken && !getBot()) {
        try {
          await startBot();
          logger.info('Bot started via background retry');
        } catch (e) {
          logger.error('Background bot start failed', e);
        }
      }
      try {
        await startListener();
      } catch (e) {
        logger.warn('Background listener start failed', e);
      }
    } catch {
      // keep retrying
    }
  }, 10000);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  const bot = getBot();
  if (bot) {
    try {
      await bot.stop();
    } catch (err) {
      logger.warn('Bot stop failed during shutdown', err);
    }
  }
  if (server) {
    server.close(() => logger.info('HTTP server closed'));
  }
  try {
    await db.end();
  } catch (err) {
    logger.warn('DB pool close failed during shutdown', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (e) => {
  logger.error('unhandledRejection', e);
});
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException', e);
});
