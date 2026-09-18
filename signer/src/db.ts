// AGPL-3.0 — signer Postgres pool (optional, for durable idempotency).
// If DATABASE_URL is unset, the pool is null and idempotency falls back to
// memory-only with a loud warn (dev posture). In compose/prod set
// DATABASE_URL to the shared Postgres so a signer restart cannot lose
// idempotency tracking and allow a duplicate payout on retry.
import { Pool } from 'pg';
import logger from './logger';

const url = (process.env.DATABASE_URL || '').trim();

export const pool: Pool | null = url
  ? new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    logger.error('[signer db] pool idle client error', String((err as Error).message || err).slice(0, 300));
  });
} else {
  logger.warn('[signer db] DATABASE_URL not set — idempotency is memory-only (restart loses dedupe window)');
}

export async function ensureIdempotencyTable(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signer_idempotency (
      key TEXT PRIMARY KEY,
      seqno BIGINT NOT NULL,
      params_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
