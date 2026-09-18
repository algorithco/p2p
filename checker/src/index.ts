// checker — standalone NFT ownership checker. Reads only, never signs.
// NOT wired into the main project: own port, own tables, no imports from it.
import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Address } from '@ton/core';
import { config } from './config';
import logger from './logger';
import { TEST_UI_HTML } from './testui';
import { classifyInput } from './resolvers/url';
import { resolveUsername } from './resolvers/username';
import { findGiftInUserGifts, resolveGift } from './resolvers/gift';
import { checkGift, checkUsername, friendly } from './verify';
import { ensureOwnersTable, getByTelegram, getByWallet, persistenceEnabled, upsertOwner } from './owners';
import { watchOwner } from './watch';
import { getNftData, sameAddress, toRaw } from './ton';

dotenv.config();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  }),
);

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

function bad(res: Response, error: string, status = 400): Response {
  return res.status(status).json({ error });
}

function validTelegramId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validWallet(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    return Address.parse(v).toRawString();
  } catch {
    return null;
  }
}

const API_DOCS = {
  name: 'escrow-checker',
  version: '0.1.0',
  endpoints: [
    { method: 'GET', path: '/health', auth: 'public', desc: 'Liveness probe' },
    { method: 'GET', path: '/test', auth: 'public', desc: 'Mini test console (same-origin API tester)' },
    { method: 'GET', path: '/api/info', auth: 'public', desc: 'Service info (network, persistence)' },
    {
      method: 'POST',
      path: '/api/check/url',
      auth: 'public',
      desc: 'Classify any input (username/gift URL/address) and verify it',
    },
    {
      method: 'POST',
      path: '/api/check/username',
      auth: 'public',
      desc: 'Verify an NFT username and bind owner wallet <-> telegram_id',
    },
    {
      method: 'POST',
      path: '/api/check/gift',
      auth: 'public',
      desc: 'Verify an off-chain gift URL (t.me/nft/<name>) and its holder',
    },
    {
      method: 'POST',
      path: '/api/check/nft',
      auth: 'public',
      desc: 'Verify a raw NFT item address and optional expected owner',
    },
    { method: 'GET', path: '/api/owners/:telegramId', auth: 'public', desc: 'Saved bindings for a Telegram user' },
    { method: 'GET', path: '/api/owners/by-wallet/:wallet', auth: 'public', desc: 'Saved bindings for a wallet' },
    {
      method: 'POST',
      path: '/api/watch',
      auth: 'public',
      desc: 'Wait (long-poll) until the item owner becomes the expected wallet',
    },
  ],
};

app.get('/health', (_req, res) => res.json({ ok: true, service: 'checker' }));

// Mini test console — same-origin API tester for local debugging.
app.get('/test', (_req, res) => {
  res.type('html').send(TEST_UI_HTML);
});

app.get('/api/info', (_req, res) =>
  res.json({
    service: 'checker',
    version: API_DOCS.version,
    network: config.tonNetwork,
    persistence: persistenceEnabled() ? 'postgres' : 'disabled',
  }),
);

app.get('/api/openapi.json', (_req, res) => {
  const paths: Record<string, unknown> = {};
  for (const ep of API_DOCS.endpoints) {
    const p = ep.path;
    if (!paths[p]) paths[p] = {};
    (paths[p] as Record<string, unknown>)[ep.method.toLowerCase()] = {
      summary: ep.desc,
      responses: { '200': { description: 'OK' } },
    };
  }
  res.json({ openapi: '3.0.3', info: { title: API_DOCS.name, version: API_DOCS.version }, paths });
});

// Any supported input -> classify -> verify. The single front door.
app.post(
  '/api/check/url',
  asyncHandler(async (req, res) => {
    const url = String(req.body?.url || '');
    if (!url || url.length > 500) return bad(res, 'url_required');
    const telegramId = req.body?.telegramId != null ? validTelegramId(req.body.telegramId) : null;
    if (req.body?.telegramId != null && telegramId === null) return bad(res, 'telegram_id_invalid');
    const c = classifyInput(url);
    if (c.kind === 'username') {
      req.body = { username: c.value, telegramId };
      return checkUsernameHandler(req, res);
    }
    if (c.kind === 'gift') {
      req.body = {
        name: c.value,
        number: c.extra?.number || req.body?.number,
        telegramId,
        sellerWallet: req.body?.sellerWallet,
      };
      return checkGiftHandler(req, res);
    }
    if (c.kind === 'address') {
      req.body = { itemAddress: c.value, expectedOwner: req.body?.expectedOwner };
      return checkNftHandler(req, res);
    }
    return bad(res, `unsupported_input:${c.reason || 'unknown'}`);
  }),
);

async function checkUsernameHandler(req: Request, res: Response): Promise<Response> {
  const username = String(req.body?.username || '');
  if (!USERNAME_RE.test(username.replace(/^@/, ''))) return bad(res, 'username_invalid');
  const telegramId = req.body?.telegramId != null ? validTelegramId(req.body.telegramId) : null;
  if (req.body?.telegramId != null && telegramId === null) return bad(res, 'telegram_id_invalid');
  const wallet = req.body?.wallet != null ? validWallet(req.body.wallet) : null;
  if (req.body?.wallet != null && wallet === null) return bad(res, 'wallet_invalid');

  const r = await resolveUsername(username);
  const result = checkUsername(r, { wallet, collectionAllowlist: config.collectionAllowlist });

  // Bind + save ONLY on a verified wallet expectation tied to a telegram id.
  let saved: unknown = null;
  if (result.verdict === 'verified' && telegramId !== null && r.ownerWallet) {
    if (!persistenceEnabled())
      return res.status(503).json({ ...result, saved: false, saveError: 'persistence_disabled' });
    saved = await upsertOwner({
      itemAddress: toRaw(r.itemAddress as string),
      telegramId,
      itemKind: 'username',
      username: r.username,
      slug: null,
      ownerWallet: toRaw(r.ownerWallet),
      proof: 'onchain:get_nft_data',
    });
  }
  return res.json({ ...result, username: r.username, saved: saved ? true : false, binding: saved });
}

app.post('/api/check/username', asyncHandler(checkUsernameHandler));

async function checkGiftHandler(req: Request, res: Response): Promise<Response> {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 120) return bad(res, 'name_required');
  const number = req.body?.number != null && String(req.body.number).trim() !== '' ? String(req.body.number) : null;
  const telegramId = req.body?.telegramId != null ? validTelegramId(req.body.telegramId) : null;
  if (req.body?.telegramId != null && telegramId === null) return bad(res, 'telegram_id_invalid');
  const wallet = req.body?.wallet != null ? validWallet(req.body.wallet) : null;
  if (req.body?.wallet != null && wallet === null) return bad(res, 'wallet_invalid');
  const sellerWallet = req.body?.sellerWallet != null ? validWallet(req.body.sellerWallet) : null;
  if (req.body?.sellerWallet != null && sellerWallet === null) return bad(res, 'seller_wallet_invalid');

  const r = await resolveGift(name, number, sellerWallet);
  const botHit = telegramId !== null ? await findGiftInUserGifts(telegramId, name, number) : null;
  const result = checkGift(r, botHit, { wallet });

  let saved: unknown = null;
  if (result.verdict === 'verified' && telegramId !== null && r.ownerWallet && r.itemAddress) {
    if (!persistenceEnabled())
      return res.status(503).json({ ...result, saved: false, saveError: 'persistence_disabled' });
    saved = await upsertOwner({
      itemAddress: toRaw(r.itemAddress),
      telegramId,
      itemKind: 'gift',
      username: null,
      slug: name,
      ownerWallet: toRaw(r.ownerWallet),
      proof: result.proof === 'bot_api' ? 'bot_api:getUserGifts' : 'onchain:get_nft_data',
    });
  }
  return res.json({
    ...result,
    name: r.name,
    number: r.number,
    botBinding: botHit,
    saved: saved ? true : false,
    binding: saved,
  });
}

app.post('/api/check/gift', asyncHandler(checkGiftHandler));

async function checkNftHandler(req: Request, res: Response): Promise<Response> {
  const itemAddress = validWallet(req.body?.itemAddress);
  if (!itemAddress) return bad(res, 'item_address_invalid');
  const expectedOwner = req.body?.expectedOwner != null ? validWallet(req.body.expectedOwner) : null;
  if (req.body?.expectedOwner != null && expectedOwner === null) return bad(res, 'expected_owner_invalid');
  let nft;
  try {
    nft = await getNftData(itemAddress);
  } catch {
    // Active contract without the NFT interface (e.g. a plain wallet) —
    // a verdict, not a crash.
    return res.json({
      verdict: 'not_nft',
      reason: 'address_has_no_nft_interface',
      itemAddress,
      itemAddressFriendly: friendly(itemAddress),
      ownerWallet: null,
      ownerWalletFriendly: null,
      expectedOwner,
      collection: null,
      proof: 'onchain',
      checkedAt: new Date().toISOString(),
    });
  }
  if (!nft.init) {
    return res.json({
      verdict: 'uninitialized',
      itemAddress: nft.itemAddress,
      itemAddressFriendly: friendly(nft.itemAddress),
      ownerWallet: nft.owner,
      ownerWalletFriendly: friendly(nft.owner),
      expectedOwner,
      collection: nft.collection,
      proof: 'onchain',
      checkedAt: new Date().toISOString(),
    });
  }
  if (expectedOwner && nft.owner && !sameAddress(nft.owner, expectedOwner)) {
    return res.json({
      verdict: 'wrong_owner',
      reason: 'owner_differs_from_expected',
      itemAddress: nft.itemAddress,
      itemAddressFriendly: friendly(nft.itemAddress),
      ownerWallet: nft.owner,
      ownerWalletFriendly: friendly(nft.owner),
      expectedOwner,
      collection: nft.collection,
      proof: 'onchain',
      checkedAt: new Date().toISOString(),
    });
  }
  return res.json({
    verdict: 'verified',
    itemAddress: nft.itemAddress,
    itemAddressFriendly: friendly(nft.itemAddress),
    ownerWallet: nft.owner,
    ownerWalletFriendly: friendly(nft.owner),
    expectedOwner,
    collection: nft.collection,
    proof: 'onchain',
    checkedAt: new Date().toISOString(),
  });
}

app.post('/api/check/nft', asyncHandler(checkNftHandler));

app.get(
  '/api/owners/:telegramId',
  asyncHandler(async (req, res) => {
    const id = validTelegramId(req.params.telegramId);
    if (id === null) return bad(res, 'telegram_id_invalid');
    if (!persistenceEnabled()) return res.status(503).json({ error: 'persistence_disabled' });
    return res.json({ telegramId: id, bindings: await getByTelegram(id) });
  }),
);

app.get(
  '/api/owners/by-wallet/:wallet',
  asyncHandler(async (req, res) => {
    const w = validWallet(req.params.wallet);
    if (!w) return bad(res, 'wallet_invalid');
    if (!persistenceEnabled()) return res.status(503).json({ error: 'persistence_disabled' });
    return res.json({ wallet: w, bindings: await getByWallet(w) });
  }),
);

app.post(
  '/api/watch',
  asyncHandler(async (req, res) => {
    const itemAddress = validWallet(req.body?.itemAddress);
    if (!itemAddress) return bad(res, 'item_address_invalid');
    const expectOwner = validWallet(req.body?.expectOwner);
    if (!expectOwner) return bad(res, 'expect_owner_invalid');
    const timeoutSec = Math.min(Math.max(Number(req.body?.timeoutSec) || 120, 10), 600);
    // Keep the HTTP round-trip below common proxy timeouts.
    const deadline = Math.min(timeoutSec, 110);
    const out = await watchOwner(itemAddress, expectOwner, deadline);
    return res.json(out);
  }),
);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.warn('checker request failed', err);
  res.status(500).json({ error: 'internal_error' });
});

async function boot(): Promise<void> {
  try {
    await ensureOwnersTable();
  } catch (err) {
    logger.warn('owners table ensure failed (persistence degraded)', err);
  }
  app.listen(config.port, () => logger.info(`checker listening on :${config.port} (${config.tonNetwork})`));
}

void boot();
