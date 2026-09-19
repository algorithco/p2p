import { Pool } from 'pg';
import { config } from '../config';

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => {
  console.error('[db] pool idle client error', String((err as Error).message || err).slice(0, 300));
});

export const db = pool;

export async function connectDB() {
  await pool.query('SELECT 1');
  console.log('Connected to PostgreSQL');
  await ensureTables();
  console.log('Ensured DB tables');
}

/** Idempotently add a column to a table (e.g. ensureColumn('deals', 'tx_hash TEXT')). */
async function ensureColumn(table: string, columnDef: string) {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDef}`);
}

export async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      username TEXT,
      ton_address TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id SERIAL PRIMARY KEY,
      buyer_id BIGINT,
      seller_id BIGINT,
      buyer_telegram_id BIGINT,
      seller_telegram_id BIGINT,
      asset TEXT,
      amount NUMERIC,
      fee_bps INT,
      fee_amount NUMERIC,
      status TEXT,
      contract_address TEXT,
      payment_address TEXT,
      terms TEXT,
      deadline TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
      sender_telegram_id BIGINT,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS deal_links (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
      token TEXT UNIQUE,
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS deal_join_requests (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
      token TEXT,
      requester_telegram_id BIGINT,
      requester_username TEXT,
      requester_first_name TEXT,
      requester_photo_url TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_alerts (
      id SERIAL PRIMARY KEY,
      kind TEXT,
      text TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Canonical extra deal columns — boot stays idempotent on pre-existing installs.
  await ensureColumn('deals', 'tx_hash TEXT');
  await ensureColumn('deals', 'resolved_at TIMESTAMPTZ');
  await ensureColumn('deals', 'updated_at TIMESTAMPTZ');
  await ensureColumn('deals', "confirmations JSONB DEFAULT '{}'::jsonb");
  // Encrypted seller-buyer channel: per-deal symmetric key (base64 32B encrypted at rest if ENCRYPTION_KEY set)
  await ensureColumn('deals', 'chat_key TEXT');
  await ensureColumn('deals', 'chat_key_created_at TIMESTAMPTZ');
  // Seller payout address via web app (for buyer-approved release)
  await ensureColumn('deals', 'payout_address TEXT');
  // CHANNEL/GROUP escrow (custodial via @gramchioka) — additive, P2P untouched
  await ensureColumn('deals', "deal_type TEXT DEFAULT 'P2P'");
  await ensureColumn('deals', 'channel_username TEXT');
  await ensureColumn('deals', 'channel_id TEXT');
  await ensureColumn('deals', 'channel_title TEXT');
  await ensureColumn('deals', "channel_snapshot JSONB DEFAULT '{}'::jsonb");
  await ensureColumn('deals', 'channel_verified BOOLEAN DEFAULT false');
  await ensureColumn('deals', 'channel_verified_at TIMESTAMPTZ');
  await ensureColumn('deals', 'escrow_holder_id BIGINT');
  await ensureColumn('deals', 'transfer_to_escrow_at TIMESTAMPTZ');
  await ensureColumn('deals', 'transfer_to_buyer_at TIMESTAMPTZ');
  await ensureColumn('deals', 'pending_new_owner TEXT');
  // Crash-safe payouts (group A): PENDING marker + idempotency key committed BEFORE
  // any on-chain send, so a crash between send and final COMMIT is detectable and
  // never silently re-paid. fee_payout_failed persists fee-leg failures for reconcile.
  await ensureColumn('deals', 'payout_idempotency_key TEXT');
  await ensureColumn('deals', 'payout_attempted_at TIMESTAMPTZ');
  await ensureColumn('deals', 'fee_payout_failed BOOLEAN DEFAULT false');
  await ensureColumn('deals', 'fee_payout_error TEXT');
  await ensureColumn('deals', 'fee_retry_count INT DEFAULT 0');
  await ensureColumn('deals', 'fee_last_retry_at TIMESTAMPTZ');
  // P0-1 deposit token + buyer expected address for sender verification
  await ensureColumn('deals', 'deposit_token TEXT');
  await ensureColumn('deals', 'buyer_expected_address TEXT');
  // Idempotent deal creation: one UUID per frontend wizard session. Retried
  // POSTs with the same key return the existing deal (no ghost duplicates).
  await ensureColumn('deals', 'client_request_id TEXT');
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_client_request_id ON deals(client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> ''`,
    );
  } catch {}
  // unique index for deposit token (partial, only where not null)
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_deposit_token ON deals(deposit_token) WHERE deposit_token IS NOT NULL AND deposit_token <> ''`,
    );
  } catch {}
  await pool.query("UPDATE deals SET deal_type='P2P' WHERE deal_type IS NULL");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deals_type ON deals(deal_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deals_channel_id ON deals(channel_id) WHERE channel_id IS NOT NULL');

  // Messages E2E: ciphertext-only at rest, plus legacy content for migration
  await ensureColumn('messages', 'encrypted_content TEXT');
  await ensureColumn('messages', 'iv TEXT');
  await ensureColumn('messages', 'auth_tag TEXT');
  await ensureColumn('messages', 'is_encrypted BOOLEAN DEFAULT false');

  // Indexes for chat polling
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_deal_created ON messages(deal_id, created_at ASC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deal_links_expires ON deal_links(expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_join_requests_deal_token ON deal_join_requests(deal_id, token)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_join_requests_status ON deal_join_requests(status)');

  // Deal lookups by party/status: /api/deals/mine + /api/deals filter
  // `WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1`, the scheduler and the
  // listener seed filter on status. OR-queries use bitmap-or over single-column
  // indexes, so singles (not a composite) are the correct shape here.
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deals_buyer ON deals(buyer_telegram_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deals_seller ON deals(seller_telegram_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status)');
  // One pending join request per (deal, requester): closes the select-then-insert
  // race in createJoinRequest — the unique violation is caught and mapped to the
  // existing row (see dealService.createJoinRequest).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_join_requests_pending ON deal_join_requests(deal_id, requester_telegram_id) WHERE status = 'pending'`,
  );
  // Join-request requester photo: Telegram file_id only (file URLs embed the bot
  // token and must never be stored — the photo proxy resolves file_id server-side).
  await ensureColumn('deal_join_requests', 'requester_photo_file_id TEXT');

  // Telegram IDs exceed 32-bit range — widen legacy INTEGER id columns to BIGINT.
  await pool.query('ALTER TABLE deals ALTER COLUMN buyer_id TYPE BIGINT');
  await pool.query('ALTER TABLE deals ALTER COLUMN seller_id TYPE BIGINT');

  // Listener persistence (fix 2.4): per-address cursor so restarts don't skip deposits
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listener_cursors (
      address TEXT PRIMARY KEY,
      lt TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Fix 3.1: defense-in-depth DB check for positive amount
  try {
    await pool.query(`ALTER TABLE deals ADD CONSTRAINT chk_deals_amount_pos CHECK (amount > 0)`);
  } catch (e) {
    const msg = String((e as Error).message || '');
    if (!msg.includes('already exists') && !msg.includes('chk_deals_amount_pos')) {
      // If existing rows violate (e.g. NaN), log but don't crash boot
      console.warn('Could not add chk_deals_amount_pos (existing bad rows?)', msg.slice(0, 300));
    }
  }

  // Defense-in-depth: restrict deals.status to canonical enum. P2-8: BUYER_CONFIRMED removed from valid set (dead, never written).
  // Legacy rows with BUYER_CONFIRMED remain readable but new writes must not produce it.
  // Success-close: CLOSED added (RELEASED deals archived ~5 min after seller payout).
  try {
    // Attempt to migrate old constraint that included BUYER_CONFIRMED: drop if exists then add new
    await pool.query(`ALTER TABLE deals DROP CONSTRAINT IF EXISTS chk_deals_status`);
  } catch {}
  try {
    await pool.query(`ALTER TABLE deals ADD CONSTRAINT chk_deals_status CHECK (status IN (
      'AWAITING_DEPOSIT','DEPOSIT_CONFIRMED','ITEM_SENT',
      'RELEASE_PENDING','REFUND_PENDING','RELEASED','REFUNDED','CLOSED'
    ))`);
  } catch (e) {
    const msg = String((e as Error).message || '');
    if (!msg.includes('already exists') && !msg.includes('chk_deals_status')) {
      console.warn('Could not add chk_deals_status (existing bad rows?)', msg.slice(0, 300));
    }
  }
}

export async function saveNotification(chatId: number, message: string) {
  const res = await pool.query('INSERT INTO notifications (chat_id, message) VALUES ($1,$2) RETURNING *', [
    chatId,
    message,
  ]);
  return res.rows[0];
}

export async function listNotifications(limit = 100) {
  const res = await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function saveAdminAlert(kind: string, text: string, meta: Record<string, unknown> = {}) {
  try {
    const res = await pool.query('INSERT INTO admin_alerts (kind, text, meta) VALUES ($1,$2,$3::jsonb) RETURNING *', [
      kind,
      text,
      JSON.stringify(meta || {}),
    ]);
    return res.rows[0];
  } catch (e) {
    console.warn('[db] saveAdminAlert failed', String((e as Error).message || e).slice(0, 300), {
      kind,
      text: text.slice(0, 100),
    });
    return null;
  }
}

export async function listAdminAlerts(limit = 10) {
  try {
    const res = await pool.query('SELECT * FROM admin_alerts ORDER BY id DESC LIMIT $1', [limit]);
    return res.rows;
  } catch {
    // best-effort: alert listing is read-only admin UI; empty beats a 500.
    return [];
  }
}

export async function getUserByTelegramId(telegramId: number) {
  const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [telegramId]);
  return res.rows[0] || null;
}

export async function createUserIfNotExists(telegramId: number, username?: string) {
  // Try to insert; if there's a unique constraint on telegram_id this will update the username
  const res = await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [telegramId, username || null],
  );
  return res.rows[0];
}

export async function upsertUserByTelegramId(telegramId: number, username?: string) {
  return createUserIfNotExists(telegramId, username);
}

// Monthly buyer leaderboard — only successful deals count (RELEASED, plus CLOSED
// which is RELEASED archived ~5 min later), and only the buyer
// (the side that sent TON/USDT) earns rating. Window = current calendar month
// by completion time (resolved_at — preserved at release, not re-stamped on close). One row per buyer+asset, ranked by volume.
export interface BuyerRatingRow {
  telegram_id: number;
  username: string | null;
  asset: string;
  volume: string;
  deals: number;
}

export async function getMonthlyBuyerRating(asset: string, limit = 50): Promise<BuyerRatingRow[]> {
  const a = String(asset || 'TON').toUpperCase();
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 50));
  const res = await pool.query(
    `SELECT d.buyer_telegram_id AS telegram_id,
            MAX(u.username) AS username,
            UPPER(d.asset) AS asset,
            COALESCE(SUM(d.amount), 0)::text AS volume,
            COUNT(*)::int AS deals
       FROM deals d
       LEFT JOIN users u ON u.telegram_id = d.buyer_telegram_id
       WHERE d.status IN ('RELEASED','CLOSED')
        AND d.buyer_telegram_id IS NOT NULL
        AND UPPER(d.asset) = $1
        AND COALESCE(d.resolved_at, d.updated_at, d.created_at) >= date_trunc('month', now())
      GROUP BY d.buyer_telegram_id, UPPER(d.asset)
      ORDER BY COALESCE(SUM(d.amount), 0) DESC, COUNT(*) DESC
      LIMIT $2`,
    [a, n],
  );
  return res.rows as BuyerRatingRow[];
}

export async function listDeals(limit = 100) {
  const res = await pool.query('SELECT * FROM deals ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function getDealLinks(dealId: number) {
  const res = await pool.query('SELECT * FROM deal_links WHERE deal_id = $1 ORDER BY id DESC', [dealId]);
  return res.rows;
}

export async function getDealLink(token: string) {
  const res = await pool.query('SELECT * FROM deal_links WHERE token = $1 LIMIT 1', [token]);
  return res.rows[0] || null;
}
