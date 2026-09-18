import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { config, validateMnemonic } from './config';
import { signer } from './wallet';
import logger, { sanitizeLogValue } from './logger';
import { idemStore as idemCacheStore, paramsHashOf, checkPersistent, storePersistent } from './idempotency';
import { pool as dbPool, ensureIdempotencyTable } from './db';

const app = express();

let corsOrigin: string | boolean = false;
if (config.corsOrigin) {
  try {
    corsOrigin = new URL(config.corsOrigin).origin;
  } catch {
    corsOrigin = config.corsOrigin as string;
  }
} else {
  // Internal service: allow all within docker network, but not public CORS
  corsOrigin = true;
}
app.use(cors({ origin: corsOrigin as any, credentials: false }));
app.use(express.json({ limit: '256kb' }));

// Internal API key auth — if SIGNER_API_KEY is set, require x-api-key or Authorization Bearer
function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKey) return next(); // open only if no key configured (dev)
  const headerKey = (req.headers['x-api-key'] as string) || (req.headers['x-signer-key'] as string) || '';
  const bearer = (req.headers['authorization'] as string) || '';
  const bearerKey = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  const provided = headerKey || bearerKey;
  if (!timingSafeEq(provided, config.apiKey)) {
    return res.status(401).json({ error: 'unauthorized', hint: 'x-api-key required' });
  }
  return next();
}

// ── Idempotency dedupe (last line of defense before an on-chain transfer) ──
// Durable: memory LRU + Postgres `signer_idempotency` when DATABASE_URL is set
// (see ./idempotency + ./db). A restart no longer wipes dedupe tracking.
function idemKeyFrom(req: Request): string | null {
  const h = (req.headers['x-idempotency-key'] as string) || '';
  const b = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
  const k = (h || b || '').trim();
  return k ? k.slice(0, 128) : null;
}

async function idemCheck(key: string, paramsHash: string): Promise<{ seqno: number } | { conflict: true } | null> {
  return checkPersistent(idemCacheStore, dbPool, key, paramsHash);
}

async function idemStore(key: string, seqno: number, paramsHash: string): Promise<void> {
  await storePersistent(idemCacheStore, dbPool, key, seqno, paramsHash);
}

// Public health (no auth) — docker healthcheck
app.get('/health', async (_req, res) => {
  const addr = signer.getAddressString();
  res.json({ ok: true, configured: signer.isConfigured(), address: addr, network: config.network });
});

app.get('/address', authMiddleware, async (_req, res) => {
  const addr = signer.getAddressString();
  if (!addr) return res.status(503).json({ error: 'wallet_not_configured', hint: 'set SIGNER_MNEMONIC=24 words' });
  res.json({ address: addr, workchain: config.workchain, network: config.network });
});

app.get('/info', authMiddleware, async (_req, res) => {
  try {
    const info = await signer.getState();
    let seqno: number | null = null;
    if (signer.isConfigured()) {
      try {
        seqno = await signer.getSeqno();
      } catch {
        seqno = null;
      }
    }
    res.json({ ...info, seqno, configured: signer.isConfigured(), network: config.network });
  } catch (err) {
    logger.error('GET /info error', err);
    res.status(500).json({ error: String(err) });
  }
});

app.post('/deploy', authMiddleware, async (req, res) => {
  try {
    const value = typeof req.body?.value === 'string' ? req.body.value : '0.05';
    const result = await signer.deploy(value);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('wallet_not_configured')) return res.status(503).json({ error: msg });
    if (msg.includes('already_deployed')) return res.status(409).json({ error: msg });
    if (msg.includes('insufficient_balance')) return res.status(402).json({ error: msg });
    logger.error('POST /deploy error', err);
    res.status(500).json({ error: msg });
  }
});

app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { to, value, body, bounce, comment } = req.body || {};
    if (!to || !value) return res.status(400).json({ error: 'to and value required' });
    if (!comment)
      return res.status(400).json({ error: 'memo_required: TON send must include comment memo (e.g. escrow#123)' });
    if (String(comment).length > 120) return res.status(400).json({ error: 'memo_too_long', max: 120 });
    // Basic address validation
    try {
      const { Address } = await import('@ton/core');
      Address.parse(to);
    } catch {
      return res.status(400).json({ error: 'invalid to address' });
    }
    const idemKey = idemKeyFrom(req);
    const phash = paramsHashOf({ to, value: String(value), bounce, comment });
    if (idemKey) {
      const hit = await idemCheck(idemKey, phash);
      if (hit && 'conflict' in hit)
        return res.status(409).json({ error: 'idempotency_conflict: key already used with different transfer params' });
      if (hit) {
        logger.warn(
          `POST /send idempotency replay key=${sanitizeLogValue(idemKey)} seqno=${sanitizeLogValue(hit.seqno)} — NOT re-sending`,
        );
        return res.json({ ok: true, seqno: hit.seqno, duplicate: true });
      }
    }
    const result = await signer.send({ to, value: String(value), body: body || null, bounce, comment });
    if (idemKey) await idemStore(idemKey, result.seqno, phash);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('wallet_not_configured')) return res.status(503).json({ error: msg });
    if (msg.includes('memo_required') || msg.includes('memo_too_long')) return res.status(400).json({ error: msg });
    logger.error('POST /send error', err);
    res.status(500).json({ error: msg });
  }
});

app.post('/send-batch', authMiddleware, async (req, res) => {
  try {
    const { requests } = req.body || {};
    if (!Array.isArray(requests) || requests.length === 0)
      return res.status(400).json({ error: 'requests array required' });
    const result = await signer.sendBatch(requests);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('wallet_not_configured')) return res.status(503).json({ error: msg });
    logger.error('POST /send-batch error', err);
    res.status(500).json({ error: msg });
  }
});

app.post('/send-jetton', authMiddleware, async (req, res) => {
  try {
    const { jettonMasterAddress, to, amount, forwardComment, forwardTonAmount } = req.body || {};
    if (!jettonMasterAddress || !to || !amount)
      return res.status(400).json({ error: 'jettonMasterAddress, to and amount required' });
    try {
      const { Address } = await import('@ton/core');
      Address.parse(jettonMasterAddress);
      Address.parse(to);
    } catch {
      return res.status(400).json({ error: 'invalid address' });
    }
    if (!forwardComment)
      return res
        .status(400)
        .json({ error: 'forwardComment (memo) required — every Jetton tx must carry escrow# memo' });
    const idemKey = idemKeyFrom(req);
    const phash = paramsHashOf({ jettonMasterAddress, to, amount: String(amount), forwardComment, forwardTonAmount });
    if (idemKey) {
      const hit = await idemCheck(idemKey, phash);
      if (hit && 'conflict' in hit)
        return res.status(409).json({ error: 'idempotency_conflict: key already used with different transfer params' });
      if (hit) {
        logger.warn(
          `POST /send-jetton idempotency replay key=${sanitizeLogValue(idemKey)} seqno=${sanitizeLogValue(hit.seqno)} — NOT re-sending`,
        );
        return res.json({ ok: true, seqno: hit.seqno, duplicate: true });
      }
    }
    const result = await signer.sendJetton({
      jettonMasterAddress,
      to,
      amount: String(amount),
      forwardComment,
      forwardTonAmount,
    });
    if (idemKey) await idemStore(idemKey, result.seqno, phash);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('wallet_not_configured')) return res.status(503).json({ error: msg });
    logger.error('POST /send-jetton error', err);
    res.status(500).json({ error: msg });
  }
});

app.post('/deploy-escrow', authMiddleware, async (req, res) => {
  try {
    const { escrowAddress, escrowStateInit, value, bodyBoc } = req.body || {};
    if (!escrowAddress || !escrowStateInit?.codeBoc || !escrowStateInit?.dataBoc) {
      return res
        .status(400)
        .json({ error: 'escrowAddress and escrowStateInit {codeBoc, dataBoc} required (base64 BOCs)' });
    }
    const result = await signer.sendEscrowDeploy({ escrowAddress, escrowStateInit, value, bodyBoc });
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('wallet_not_configured')) return res.status(503).json({ error: msg });
    logger.error('POST /deploy-escrow error', err);
    res.status(500).json({ error: msg });
  }
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

const port = config.port;

async function start() {
  const v = validateMnemonic(config.mnemonic);
  if (!v.valid) {
    logger.warn(v.reason);
  }
  try {
    await ensureIdempotencyTable();
    if (dbPool) logger.info('Signer idempotency persistence enabled (Postgres signer_idempotency)');
  } catch (e) {
    logger.warn('Signer idempotency table ensure failed — memory-only fallback', e);
  }
  try {
    await signer.init();
  } catch (e) {
    logger.error('Signer init failed — continuing in degraded mode', e);
  }
  app.listen(port, () => {
    logger.info(
      `Signer listening on http://localhost:${port} (network=${config.network}, configured=${signer.isConfigured()})`,
    );
    if (config.apiKey) logger.info('SIGNER_API_KEY auth enabled');
    else logger.warn('SIGNER_API_KEY not set — signer is OPEN (dev only!)');
  });
}

start().catch((e) => {
  logger.error('Failed to start signer', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
