import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { config, validateMnemonic } from './config';
import { signer } from './wallet';
import logger, { sanitizeLogValue } from './logger';
import { idemStore as idemCacheStore, paramsHashOf, checkPersistent, storePersistent } from './idempotency';
import { pool as dbPool, ensureIdempotencyTable } from './db';
import { mapSendError } from './errors';
import { createMutex } from './mutex';

const app = express();

// Serializes ALL signing ops: a TON wallet consumes one seqno per transfer, so
// concurrent sendTransfer calls read the same seqno and one dies on-chain with
// an ambiguous error. The lock also closes the idempotency
// check→send→store TOCTOU for identical keys arriving concurrently.
const sendMutex = createMutex();

let corsOrigin: string | boolean = false;
if (config.corsOrigin) {
  try {
    corsOrigin = new URL(config.corsOrigin).origin;
  } catch {
    corsOrigin = config.corsOrigin as string;
  }
} else {
  // Internal non-browser API (only backend's node fetch calls it): no CORS at
  // all. The old `origin: true` reflected any Origin header, which is harmless
  // with credentials:false but needlessly widens the surface.
  corsOrigin = false;
}
app.use(cors({ origin: corsOrigin as any, credentials: false }));
app.use(express.json({ limit: '256kb' }));

// Internal API key auth — if SIGNER_API_KEY is set, require x-api-key or Authorization Bearer
function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Dummy compare of equal-length buffers: without this, the instant
    // `false` on length mismatch leaks the expected key length via timing.
    try {
      crypto.timingSafeEqual(ba, ba);
    } catch {
      /* ignore */
    }
    return false;
  }
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
  // Headers may arrive as string[] when repeated; String() coercion avoids a
  // TypeError on `.trim()` (which used to 500 the request).
  const rawH = req.headers['x-idempotency-key'];
  const h = (Array.isArray(rawH) ? rawH[0] : rawH) || '';
  const b = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
  const k = String(h || b || '').trim();
  return k ? k.slice(0, 128) : null;
}

/**
 * Runs check→send→store INSIDE the send mutex. Previously the idempotency
 * check ran before the send with no lock, so two concurrent identical requests
 * both missed and both broadcast (double payout).
 */
async function idempotentSend(
  res: Response,
  route: string,
  idemKey: string | null,
  phash: string,
  fn: () => Promise<Record<string, unknown> & { seqno: number }>,
): Promise<void> {
  try {
    const result = await sendMutex.run(async () => {
      if (idemKey) {
        const hit = await idemCheck(idemKey, phash);
        if (hit && 'conflict' in hit)
          throw new Error('idempotency_conflict: key already used with different transfer params');
        if (hit) {
          logger.warn(
            `${route} idempotency replay key=${sanitizeLogValue(idemKey)} seqno=${sanitizeLogValue(hit.seqno)} — NOT re-sending`,
          );
          return { seqno: hit.seqno, duplicate: true };
        }
      }
      const sent = await fn();
      if (idemKey) await idemStore(idemKey, sent.seqno, phash);
      return sent;
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err, route);
  }
}

/** Single error-mapping funnel for all signing routes (see ./errors). */
function sendError(res: Response, err: unknown, route: string): void {
  const mapped = mapSendError((err as Error)?.message ?? err);
  if (mapped.status >= 500) logger.error(`POST ${route} error`, err);
  else logger.warn(`POST ${route} client/network error ${mapped.status}`, sanitizeLogValue(mapped.error));
  const body: Record<string, unknown> = { error: mapped.error };
  if (mapped.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(mapped.retryAfter));
    body.retryAfter = mapped.retryAfter;
  }
  res.status(mapped.status).json(body);
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
    // Deploy is self-protecting against retries (second call sees active state →
    // 409 already_deployed), but still runs under the mutex so it cannot steal
    // the seqno of a concurrent payout.
    const result = await sendMutex.run(() => signer.deploy(value));
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err, '/deploy');
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
    await idempotentSend(res, 'POST /send', idemKey, phash, () =>
      signer.send({ to, value: String(value), body: body || null, bounce, comment }),
    );
  } catch (err) {
    // Validation errors above the lock (malformed body) — never touch shared state.
    sendError(res, err, '/send');
  }
});

app.post('/send-batch', authMiddleware, async (req, res) => {
  try {
    const { requests } = req.body || {};
    if (!Array.isArray(requests) || requests.length === 0)
      return res.status(400).json({ error: 'requests array required' });
    // Previously: NO idempotency at all — any retry of a batch re-broadcast
    // every transfer in it. Same key+params now replays, key+new-params 409s.
    const idemKey = idemKeyFrom(req);
    const phash = paramsHashOf({ requests });
    await idempotentSend(res, 'POST /send-batch', idemKey, phash, () => signer.sendBatch(requests));
  } catch (err) {
    sendError(res, err, '/send-batch');
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
    await idempotentSend(res, 'POST /send-jetton', idemKey, phash, () =>
      signer.sendJetton({
        jettonMasterAddress,
        to,
        amount: String(amount),
        forwardComment,
        forwardTonAmount,
      }),
    );
  } catch (err) {
    sendError(res, err, '/send-jetton');
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
    // Previously: no idempotency — a retry after an ambiguous failure broadcast
    // a SECOND deploy funding tx with a fresh seqno (real double spend of value).
    const idemKey = idemKeyFrom(req);
    const phash = paramsHashOf({ escrowAddress, escrowStateInit, value, bodyBoc });
    await idempotentSend(res, 'POST /deploy-escrow', idemKey, phash, () =>
      signer.sendEscrowDeploy({ escrowAddress, escrowStateInit, value, bodyBoc }),
    );
  } catch (err) {
    sendError(res, err, '/deploy-escrow');
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
  // Retry table ensure: at boot the DB DNS/endpoint may not be ready yet (seen
  // live: ENOTFOUND postgres on a network re-attach). pg connects lazily per
  // query so runtime self-heals, but without the table every persistent check
  // degrades to memory-only — retry a few times before giving up.
  let tableReady = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await ensureIdempotencyTable();
      tableReady = true;
      break;
    } catch (e) {
      logger.warn(`Signer idempotency table ensure attempt ${attempt}/4 failed — retrying`, e);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (tableReady && dbPool) logger.info('Signer idempotency persistence enabled (Postgres signer_idempotency)');
  else logger.warn('Signer idempotency table ensure failed — memory-only fallback (restart loses dedupe window)');
  try {
    await signer.init();
  } catch (e) {
    // Fail CLOSED: without a wallet every signing route 503s. This includes the
    // invalid_mnemonic_checksum case — a typo'd seed must never derive+fund a
    // wrong wallet, so we stay keyless rather than guess.
    logger.error('Signer init failed — continuing in degraded (no-wallet) mode', e);
  }
  const server = app.listen(port, () => {
    logger.info(
      `Signer listening on http://localhost:${port} (network=${config.network}, configured=${signer.isConfigured()})`,
    );
    if (config.apiKey) {
      logger.info('SIGNER_API_KEY auth enabled');
      if (config.apiKey.length < 32) logger.warn('SIGNER_API_KEY < 32 chars — weak, use 32+ random chars');
    } else logger.warn('SIGNER_API_KEY not set — signer is OPEN (dev only!)');
    if (config.maxSendTon) logger.info(`MAX_SEND_TON cap active: ${config.maxSendTon} TON per transfer`);
  });

  // Graceful shutdown: stop accepting, then drain in-flight signing ops.
  // A SIGKILL mid-send leaves backend-side ambiguity (backend reconciles via
  // alerts), so give transfers up to 25s to finish. Pair with
  // stop_grace_period ≥30s in docker-compose (default is only 10s).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} — draining signer (${sendMutex.getActive()} in-flight signing ops)`);
    server.close(() => logger.info('Signer HTTP server closed (no new requests)'));
    void sendMutex
      .waitForIdle(25000)
      .then((drained) => {
        if (!drained)
          logger.warn('Shutdown timeout with signing ops still in-flight — exiting anyway (backend reconciles)');
        process.exit(0);
      })
      .catch(() => process.exit(0));
    // Hard cap so shutdown can never hang forever.
    setTimeout(() => {
      logger.warn('Shutdown hard timeout — forcing exit');
      process.exit(0);
    }, 30000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((e) => {
  logger.error('Failed to start signer', e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
