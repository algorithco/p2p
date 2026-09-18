// src/auth/guard.ts
import type { Request, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import expressRateLimit from 'express-rate-limit';
import { config } from '../config';
import logger from '../logger';
import { validateInitData } from './initData';

let devWarned = false;

/**
 * Timing-safe string comparison for API keys / secrets.
 * Compares raw UTF-8 bytes directly with timingSafeEqual — no fast hash
 * (SHA-256/HMAC) involved, so CodeQL js/insufficient-password-hash does not apply.
 * Length mismatch still performs a dummy compare to avoid early-exit oracle.
 */
export function timingSafeStringEqual(a: unknown, b: unknown): boolean {
  const sa = String(a);
  const sb = String(b);
  const ba = Buffer.from(sa, 'utf8');
  const bb = Buffer.from(sb, 'utf8');
  if (ba.length !== bb.length) {
    // Dummy constant-time compare to keep timing similar, then fail.
    try {
      timingSafeEqual(ba, ba);
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function isValidPositiveInt(value: unknown): boolean {
  // Note: Telegram IDs are BIGINT in DB but currently fit in 53 bits (JS safe integer).
  // If IDs exceed Number.MAX_SAFE_INTEGER, this check would fail; DB stores as string/BIGINT but Number() would lose precision.
  // For now IDs like 8992814642 are safe; revisit with BigInt check if Telegram migrates to larger IDs.
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && Number.isSafeInteger(n);
}

function extractProvidedApiKey(req: Request): string | null {
  // Header-only — API keys must never be sent in query strings (logged in access logs/history)
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  return null;
}

function apiKeyMatches(req: Request): boolean {
  if (!config.apiKey) return false;
  const provided = extractProvidedApiKey(req);
  return provided !== null && timingSafeStringEqual(provided, config.apiKey);
}

export function adminApiKeyMatches(req: Request): boolean {
  if (!config.adminApiKey) return false;
  // P0-2: distinct header only — no fallback to x-api-key (removes ambiguity)
  const headerKey = (req.headers['x-admin-api-key'] as string) || '';
  const bearer = (req.headers['authorization'] as string) || '';
  const bearerKey = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  const provided = headerKey || bearerKey;
  if (!provided) return false;
  return timingSafeStringEqual(provided, config.adminApiKey);
}

/**
 * Attach-only identity middleware — never rejects.
 * Priority: valid Telegram initData > api-key > dev header fallback > anonymous.
 */
export const identityAuth: RequestHandler = (req, _res, next) => {
  const initDataHeader = req.headers['x-init-data'];
  if (typeof initDataHeader === 'string' && initDataHeader.length > 0 && config.botToken) {
    const result = validateInitData(initDataHeader, config.botToken);
    // Defense in depth: only attach positive-int ids. A signed-but-degenerate
    // user object (id 0/NaN/float) must stay anonymous even if HMAC verifies.
    if (result.ok && result.user && isValidPositiveInt((result.user as { id?: unknown }).id)) {
      req.user = result.user;
      req.authMode = 'telegram';
      return next();
    }
  }

  if (apiKeyMatches(req)) {
    req.authMode = 'api-key';
    return next();
  }

  // Fix 3.3: dev auth only if explicitly allowed via ALLOW_DEV_AUTH=true
  // — and NEVER in production, even if the flag is set.
  if (process.env.NODE_ENV === 'production' && config.allowDevAuth) {
    if (!devWarned) {
      devWarned = true;
      logger.warn('AUTH: ALLOW_DEV_AUTH=true ignored in production (fail-closed)');
    }
  } else if (!config.botToken && !config.apiKey && config.allowDevAuth) {
    if (!devWarned) {
      devWarned = true;
      logger.warn('AUTH DEV MODE — ALLOW_DEV_AUTH=true, trusting x-telegram-user-id (never enable in prod)');
    }
    const headerId = req.headers['x-telegram-user-id'];
    const id = Number(Array.isArray(headerId) ? headerId[0] : headerId);
    if (isValidPositiveInt(id)) {
      req.user = { id };
      req.authMode = 'dev';
    }
  } else if (!config.botToken && !config.apiKey && !config.allowDevAuth) {
    // No dev fallback — remain anonymous; requireIdentity will 401. Log once.
    if (!devWarned) {
      devWarned = true;
      logger.warn(
        'AUTH: BOT_TOKEN and API_KEY unset and ALLOW_DEV_AUTH != true — dev header ignored (requests will be 401)',
      );
    }
  }

  return next(); // anonymous
};

/** 401 unless a verified user is attached or the caller authenticated via api-key. */
export const requireIdentity: RequestHandler = (req, res, next) => {
  if (req.user || req.authMode === 'api-key') return next();
  return res.status(401).json({ error: 'identity_required' });
};

/**
 * Best-known caller telegram id — VERIFIED identity only.
 * The old body.telegramId override for api-key callers was removed: a shared
 * static secret must never be able to self-assert an arbitrary Telegram id
 * (full impersonation of any buyer/seller). Operator tooling authenticates via
 * ADMIN_API_KEY (adminApiKeyMatches) or a verified Telegram id instead.
 */
export function getIdentityId(req: Request): number | null {
  if (req.user && isValidPositiveInt(req.user.id)) return req.user.id;
  return null;
}

/** Admins pass via verified identity membership; service api-key no longer grants admin.
 * P0-2: only ADMIN_API_KEY or verified Telegram admin id may access admin endpoints.
 * Generic API_KEY (used by signer/ubot) is explicitly NOT sufficient.
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (adminApiKeyMatches(req)) return next();
  if (
    req.user &&
    isValidPositiveInt(req.user.id) &&
    config.adminTelegramIds.map(Number).includes(Number(req.user.id))
  ) {
    return next();
  }
  return res.status(403).json({ error: 'forbidden' });
};

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Route bucket name used in the per-ip key (e.g. 'notify', 'chat-post'). */
  name?: string;
}

/**
 * Rate limiter built on express-rate-limit (in-memory store) keyed by ip.
 * Returns 429 {error:'rate_limited'} with RateLimit/Retry-After headers once max hits/window exceeded.
 * Each call creates an independent bucket; `name` is kept for keying/observability.
 * P5-16: per-process/in-memory — if more than one backend instance is ever run,
 * effective limit multiplies by N. For horizontal scaling, migrate to a shared store
 * (e.g. rate-limit-redis + Redis service in docker-compose). Single-instance only today.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const limiter = expressRateLimit({
    windowMs: Math.max(1, Math.floor(options.windowMs)),
    limit: Math.max(1, Math.floor(options.max)),
    standardHeaders: true, // RateLimit-* headers incl. Retry-After on 429
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}|${options.name || 'default'}`,
    message: { error: 'rate_limited' },
    validate: false, // trust proxy configured at app level
  });
  return limiter as unknown as RequestHandler;
}
