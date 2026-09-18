/**
 * Owner bindings: wallet <-> telegram_id, as proven by the checker.
 * Own table (checker_owners) on the shared Postgres server when
 * DATABASE_URL is set; otherwise persistence stays disabled (honest 503).
 */
import { Pool } from 'pg';
import { config } from './config';
import logger from './logger';

let pool: Pool | null = null;

export function persistenceEnabled(): boolean {
  return config.databaseUrl.trim() !== '';
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
    pool.on('error', (err) => logger.warn('checker pg pool error', err));
  }
  return pool;
}

export async function ensureOwnersTable(): Promise<void> {
  if (!persistenceEnabled()) {
    logger.warn('DATABASE_URL empty — owner bindings will NOT be saved');
    return;
  }
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS checker_owners (
      item_address TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      item_kind TEXT NOT NULL,
      username TEXT,
      slug TEXT,
      owner_wallet TEXT NOT NULL,
      proof TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_checker_owners_tg ON checker_owners(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_checker_owners_wallet ON checker_owners(owner_wallet);
  `);
  logger.info('checker_owners table ensured');
}

export interface OwnerBinding {
  itemAddress: string;
  telegramId: number;
  itemKind: 'username' | 'gift' | 'nft';
  username: string | null;
  slug: string | null;
  ownerWallet: string;
  proof: string;
  verifiedAt: string;
  updatedAt: string;
}

function row(r: any): OwnerBinding {
  return {
    itemAddress: String(r.item_address),
    telegramId: Number(r.telegram_id),
    itemKind: r.item_kind,
    username: r.username ?? null,
    slug: r.slug ?? null,
    ownerWallet: String(r.owner_wallet),
    proof: String(r.proof),
    verifiedAt: new Date(r.verified_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function upsertOwner(b: Omit<OwnerBinding, 'verifiedAt' | 'updatedAt'>): Promise<OwnerBinding> {
  const res = await getPool().query(
    `INSERT INTO checker_owners
       (item_address, telegram_id, item_kind, username, slug, owner_wallet, proof, verified_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     ON CONFLICT (item_address) DO UPDATE SET
       telegram_id = EXCLUDED.telegram_id,
       item_kind = EXCLUDED.item_kind,
       username = EXCLUDED.username,
       slug = EXCLUDED.slug,
       owner_wallet = EXCLUDED.owner_wallet,
       proof = EXCLUDED.proof,
       verified_at = now(),
       updated_at = now()
     RETURNING *`,
    [b.itemAddress, b.telegramId, b.itemKind, b.username, b.slug, b.ownerWallet, b.proof],
  );
  return row(res.rows[0]);
}

export async function getByTelegram(telegramId: number): Promise<OwnerBinding[]> {
  const res = await getPool().query('SELECT * FROM checker_owners WHERE telegram_id = $1 ORDER BY updated_at DESC', [
    telegramId,
  ]);
  return res.rows.map(row);
}

export async function getByWallet(walletRaw: string): Promise<OwnerBinding[]> {
  const res = await getPool().query('SELECT * FROM checker_owners WHERE owner_wallet = $1 ORDER BY updated_at DESC', [
    walletRaw,
  ]);
  return res.rows.map(row);
}
