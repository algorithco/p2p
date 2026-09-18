// AGPL-3.0 — signer idempotency dedupe (extracted for unit-testability).
// Durability model: memory LRU (fast path) + Postgres `signer_idempotency`
// table (crash-safe path) when DATABASE_URL is set. Backend DB PENDING states
// remain the primary double-payout guarantee; this closes the signer-restart
// window where memory-only dedupe could allow a duplicate send on retry.
// A repeat with the same key but DIFFERENT transfer params is rejected (409).
import crypto from 'crypto';

export const IDEM_MAX_ENTRIES = 1000;
export const IDEM_TTL_MS = 24 * 3600 * 1000;

export type IdemEntry = { seqno: number; paramsHash: string; at: number };

export function paramsHashOf(obj: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(obj ?? null))
    .digest('hex');
}

export class IdempotencyStore {
  private cache = new Map<string, IdemEntry>();

  /** Returns {seqno} on replay hit, {conflict:true} on key-reuse-with-new-params, null on miss. */
  check(key: string, paramsHash: string, now = Date.now()): { seqno: number } | { conflict: true } | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (now - e.at > IDEM_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    if (e.paramsHash !== paramsHash) return { conflict: true };
    return { seqno: e.seqno };
  }

  store(key: string, seqno: number, paramsHash: string, now = Date.now()): void {
    if (this.cache.size >= IDEM_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { seqno, paramsHash, at: now });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/** Shared process-wide store used by the HTTP layer. */
export const idemStore = new IdempotencyStore();

export type DbLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
};

/**
 * Persistent check: memory first, then Postgres (when available).
 * Returns {seqno} on replay hit, {conflict:true} on key-reuse-with-new-params, null on miss.
 * On DB hit the memory cache is warmed so subsequent checks stay fast.
 */
export async function checkPersistent(
  store: IdempotencyStore,
  db: DbLike | null,
  key: string,
  paramsHash: string,
  now = Date.now(),
): Promise<{ seqno: number } | { conflict: true } | null> {
  const mem = store.check(key, paramsHash, now);
  if (mem) return mem;
  if (!db) return null;
  try {
    const res = await db.query('SELECT seqno, params_hash FROM signer_idempotency WHERE key = $1 LIMIT 1', [key]);
    const row = res.rows[0] as { seqno: string | number; params_hash: string } | undefined;
    if (!row) return null;
    if (String(row.params_hash) !== paramsHash) return { conflict: true };
    const seqno = Number(row.seqno);
    store.store(key, seqno, paramsHash, now);
    return { seqno };
  } catch {
    // best-effort: DB failure must not block sends; memory verdict stands (miss).
    return null;
  }
}

/** Persistent store: memory + best-effort Postgres upsert. Never throws. */
export async function storePersistent(
  store: IdempotencyStore,
  db: DbLike | null,
  key: string,
  seqno: number,
  paramsHash: string,
  now = Date.now(),
): Promise<void> {
  store.store(key, seqno, paramsHash, now);
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO signer_idempotency (key, seqno, params_hash, created_at, updated_at)
       VALUES ($1,$2,$3,now(),now())
       ON CONFLICT (key) DO UPDATE SET seqno = EXCLUDED.seqno, params_hash = EXCLUDED.params_hash, updated_at = now()`,
      [key, seqno, paramsHash],
    );
  } catch {
    // best-effort: memory already has it; DB will catch up on next store.
  }
}
