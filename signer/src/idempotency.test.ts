// AGPL-3.0 — signer idempotency unit tests (restart-window last defense).
import { describe, it, expect, vi } from 'vitest';
import {
  IdempotencyStore,
  paramsHashOf,
  IDEM_MAX_ENTRIES,
  IDEM_TTL_MS,
  checkPersistent,
  storePersistent,
} from './idempotency';

describe('paramsHashOf', () => {
  it('stable and sensitive to params', () => {
    expect(paramsHashOf({ a: 1 })).toBe(paramsHashOf({ a: 1 }));
    expect(paramsHashOf({ a: 1 })).not.toBe(paramsHashOf({ a: 2 }));
  });
});

describe('IdempotencyStore', () => {
  it('miss then store then replay hit (no re-send)', () => {
    const s = new IdempotencyStore();
    const h = paramsHashOf({ to: 'UQ_x', value: '1' });
    expect(s.check('release:1', h)).toBeNull();
    s.store('release:1', 42, h);
    expect(s.check('release:1', h)).toEqual({ seqno: 42 });
  });

  it('same key + different params => conflict (409)', () => {
    const s = new IdempotencyStore();
    s.store('release:1', 1, paramsHashOf({ to: 'A' }));
    expect(s.check('release:1', paramsHashOf({ to: 'B' }))).toEqual({ conflict: true });
  });

  it('expired entries are treated as miss', () => {
    const s = new IdempotencyStore();
    const h = paramsHashOf({ to: 'A' });
    s.store('k', 1, h, 0);
    expect(s.check('k', h, IDEM_TTL_MS + 1)).toBeNull();
  });

  it('bounded size (evicts oldest)', () => {
    const s = new IdempotencyStore();
    for (let i = 0; i < IDEM_MAX_ENTRIES + 5; i++) s.store(`k${i}`, i, paramsHashOf(i));
    expect(s.size).toBeLessThanOrEqual(IDEM_MAX_ENTRIES);
  });
});

describe('checkPersistent / storePersistent (Postgres)', () => {
  it('memory hit short-circuits DB', async () => {
    const s = new IdempotencyStore();
    const h = paramsHashOf({ to: 'A' });
    s.store('k1', 7, h);
    const db = { query: vi.fn() };
    expect(await checkPersistent(s, db, 'k1', h)).toEqual({ seqno: 7 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('DB hit warms memory (restart recovery)', async () => {
    const s = new IdempotencyStore();
    const h = paramsHashOf({ to: 'A' });
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ seqno: 99, params_hash: h }], rowCount: 1 }) };
    expect(await checkPersistent(s, db, 'release:5', h)).toEqual({ seqno: 99 });
    // warmed: second check needs no DB
    const db2 = { query: vi.fn() };
    expect(await checkPersistent(s, db2, 'release:5', h)).toEqual({ seqno: 99 });
    expect(db2.query).not.toHaveBeenCalled();
  });

  it('DB conflict on params mismatch', async () => {
    const s = new IdempotencyStore();
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ seqno: 1, params_hash: 'other' }], rowCount: 1 }) };
    expect(await checkPersistent(s, db, 'k', paramsHashOf({ to: 'new' }))).toEqual({ conflict: true });
  });

  it('DB miss returns null; DB error degrades to miss (never blocks send)', async () => {
    const s = new IdempotencyStore();
    const empty = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    expect(await checkPersistent(s, empty, 'missing', 'h')).toBeNull();
    const failing = {
      query: vi.fn().mockRejectedValue(new Error('db down')),
    };
    expect(await checkPersistent(s, failing, 'missing', 'h')).toBeNull();
  });

  it('storePersistent writes memory + upserts DB (DB failure never throws)', async () => {
    const s = new IdempotencyStore();
    const h = paramsHashOf({ to: 'A' });
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    await storePersistent(s, db, 'k', 3, h);
    expect(s.check('k', h)).toEqual({ seqno: 3 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO signer_idempotency'), ['k', 3, h]);
    const failing = { query: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(storePersistent(new IdempotencyStore(), failing, 'k', 1, h)).resolves.toBeUndefined();
  });
});
