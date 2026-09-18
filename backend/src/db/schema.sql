-- Canonical backend schema — mirrors src/db/queries.ts ensureTables().
-- ensureTables() is authoritative at boot; this file documents/creates the same shape.
-- Deal statuses (canonical webapp-first): AWAITING_DEPOSIT, DEPOSIT_CONFIRMED,
-- ITEM_SENT, BUYER_CONFIRMED (legacy), RELEASE_PENDING / REFUND_PENDING
-- (transient payout-in-progress, see escrowService guardedTransition),
-- RELEASED, REFUNDED.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  username TEXT,
  ton_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  -- DEPRECATED (write-only, never read — ownership is buyer/seller_telegram_id):
  -- buyer_id / seller_id are kept for backward-compat only. Do not add new readers;
  -- a future migration may stop writing them. See createDealRecord.
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
  created_at TIMESTAMPTZ DEFAULT now(),
  tx_hash TEXT,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  confirmations JSONB DEFAULT '{}'::jsonb,
  payout_address TEXT,
  chat_key TEXT,
  chat_key_created_at TIMESTAMPTZ,
  deal_type TEXT DEFAULT 'P2P',
  channel_username TEXT,
  channel_id TEXT,
  channel_title TEXT,
  channel_snapshot JSONB DEFAULT '{}'::jsonb,
  channel_verified BOOLEAN DEFAULT false,
  channel_verified_at TIMESTAMPTZ,
  escrow_holder_id BIGINT,
  transfer_to_escrow_at TIMESTAMPTZ,
  transfer_to_buyer_at TIMESTAMPTZ,
  pending_new_owner TEXT,
  -- Crash-safe payouts: PENDING marker committed before any on-chain send.
  payout_idempotency_key TEXT,
  payout_attempted_at TIMESTAMPTZ,
  fee_payout_failed BOOLEAN DEFAULT false,
  fee_payout_error TEXT,
  fee_retry_count INT DEFAULT 0,
  fee_last_retry_at TIMESTAMPTZ,
  -- P0-1 deposit token: unguessable per-deal memo, replaces predictable escrow#<id>
  deposit_token TEXT,
  buyer_expected_address TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_deposit_token ON deals(deposit_token) WHERE deposit_token IS NOT NULL AND deposit_token <> '';
CREATE INDEX IF NOT EXISTS idx_deals_type ON deals(deal_type);
CREATE INDEX IF NOT EXISTS idx_deals_channel_id ON deals(channel_id) WHERE channel_id IS NOT NULL;
-- Party/status lookups (/api/deals/mine, scheduler, listener seed). Singles, not a
-- composite: the hot query is `buyer=$1 OR seller=$1` (bitmap-or shape).
CREATE INDEX IF NOT EXISTS idx_deals_buyer ON deals(buyer_telegram_id);
CREATE INDEX IF NOT EXISTS idx_deals_seller ON deals(seller_telegram_id);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
-- Enum guard (boot applies via try/catch ADD CONSTRAINT — PG has no IF NOT EXISTS
-- for constraints — see queries.ts ensureTables).
ALTER TABLE deals ADD CONSTRAINT chk_deals_status CHECK (status IN (
  'AWAITING_DEPOSIT','DEPOSIT_CONFIRMED','ITEM_SENT','BUYER_CONFIRMED',
  'RELEASE_PENDING','REFUND_PENDING','RELEASED','REFUNDED'
));

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
  encrypted_content TEXT,
  iv TEXT,
  auth_tag TEXT,
  is_encrypted BOOLEAN DEFAULT false,
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
  requester_photo_file_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_messages_deal_created ON messages(deal_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_deal_links_expires ON deal_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_join_requests_deal_token ON deal_join_requests(deal_id, token);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON deal_join_requests(status);
-- One pending request per (deal, requester); app maps the violation to "already requested".
CREATE UNIQUE INDEX IF NOT EXISTS uq_join_requests_pending ON deal_join_requests(deal_id, requester_telegram_id) WHERE status = 'pending';
