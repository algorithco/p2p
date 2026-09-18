# Backend

TypeScript service that runs the Telegram bot (grammY), the REST API
(Express) and the TON blockchain integration. API-only: it does NOT serve
the Mini App in production (`SERVE_STATIC=false`, frontend is a separate
nginx service); `SERVE_STATIC=true` is a local-dev fallback only.

## Scripts

| Script | Command         | What it does                         |
| ------ | --------------- | ------------------------------------ |
| build  | `npm run build` | Compile `src/` → `dist/` with tsc    |
| start  | `npm start`     | Run compiled `node dist/index.js`    |
| dev    | `npm run dev`   | Run in-place with ts-node (no build) |

## Environment variables

Copy `.env.example` to `.env`. Names match `src/config.ts` exactly.

| Variable                   | Default (code)             | Description                                                                                                                                                                          |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOT_TOKEN`                | —                          | BotFather token; without it polling is disabled and `/api/notify` returns 503                                                                                                        |
| `ADMIN_TELEGRAM_IDS`       | empty                      | Comma-separated admin Telegram user ids                                                                                                                                              |
| `DATABASE_URL`             | —                          | Postgres connection string                                                                                                                                                           |
| `PORT`                     | `3000`                     | HTTP port (`src/index.ts`)                                                                                                                                                           |
| `TON_API_ENDPOINT`         | derived from `TON_NETWORK` | Optional verbatim override, e.g. `https://toncenter.com/api/v2/jsonRPC`                                                                                                              |
| `TON_NETWORK`              | `mainnet`                  | `testnet` or `mainnet`; selects the matching toncenter endpoint                                                                                                                      |
| `TONCENTER_API_KEY`        | empty                      | Optional API key for toncenter (recommended in prod)                                                                                                                                 |
| `SIGNER_URL`               | `http://signer:3001`       | URL of the isolated W5 signer microservice                                                                                                                                           |
| `SIGNER_API_KEY`           | empty                      | Must match `SIGNER_API_KEY` in `signer/.env` (32+ chars)                                                                                                                             |
| `ESCROW_CONTRACT_CODE_HEX` | empty (legacy, unused)     | Legacy stub for a removed Tact contract — leave empty; custody is off-chain                                                                                                          |
| `JETTON_MASTER_ADDRESS`    | unset                      | Jetton master used for jetton deals                                                                                                                                                  |
| `USDT_JETTON_ADDRESS`      | empty                      | Canonical USDT jetton address on TON                                                                                                                                                 |
| `JETTON_WALLET_CODE_HASH`  | `0`                        | Decimal string of jetton wallet code hash                                                                                                                                            |
| `FEE_ADDRESS`              | empty                      | Fee collector address                                                                                                                                                                |
| `FEE_BPS`                  | `100`                      | Fee in basis points (100 = 1%)                                                                                                                                                       |
| `FEE_PERCENTAGE`           | `1`                        | Legacy percent alias; prefer `FEE_BPS`                                                                                                                                               |
| `MIN_CONFIRMATIONS`        | `3`                        | Confirmations before a deposit is trusted                                                                                                                                            |
| `ADMIN_ADDRESS`            | empty                      | On-chain arbiter/admin address                                                                                                                                                       |
| `WALLET_ADDRESS`           | empty                      | W5 signer address (auto-derived from signer; set manually to override)                                                                                                               |
| `REQUIRE_ONCHAIN`          | `false` (legacy)           | Legacy flag: `false` = custodial off-chain (the only supported mode); `true` only makes `GET /api/status/:address` attempt an on-chain read instead of returning `{mode:'offchain'}` |
| `WEBAPP_URL`               | empty                      | Public HTTPS Mini App URL (menu button + join links)                                                                                                                                 |
| `API_KEY`                  | unset                      | Shared API secret; **unset = all protected routes are open**                                                                                                                         |

## REST API

Auth legend (see `src/auth/guard.ts`):

- **Telegram identity** — the Mini App sends `x-init-data` on every request;
  it is verified server-side against `BOT_TOKEN` using Telegram's
  HMAC-SHA256 scheme (`src/auth/initData.ts`, 24 h freshness window) and the
  authenticated user id is attached as `req.user`.
- **API key** — `x-api-key: <API_KEY>` header only (never in query strings), intended for
  server-to-server callers. Compared timing-safely.
- **Dev fallback** — only when _both_ `BOT_TOKEN` and `API_KEY` are unset:
  trusts `x-telegram-user-id` (logs a one-time warning). Never happens with a
  configured deployment.
- **Admin** — Telegram identity whose id is in `ADMIN_TELEGRAM_IDS`, or any
  api-key caller.

Rate limits (sliding window, per IP+route): create deal 10/min · join 20/min ·
chat post 60/min · notify 5/min.

| Method | Path                         | Auth                                     | Description                                                                                                        |
| ------ | ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/info`                  | public                                   | Admin ids + `feeBps` — also the health probe target                                                                |
| GET    | `/api/deals`                 | Identity (party or admin)                | Private: only deals where caller is buyer/seller (admin sees all 100)                                              |
| GET    | `/api/deals/:id`             | Identity (party or admin, token preview) | Single deal — only buyer/seller/admin or valid `?token=` invite                                                    |
| GET    | `/api/deals/:id/chat`        | Identity (party or admin)                | Deal chat messages (ciphertext only)                                                                               |
| GET    | `/api/deals/:id/payload`     | Identity (party or admin, token preview) | Deal TON payloads — party/admin or `?token=`                                                                       |
| GET    | `/api/status/:address`       | public                                   | On-chain `getStatus()` for an escrow address                                                                       |
| GET    | `/api/deals/mine`            | Identity                                 | Alias for `GET /api/deals` — deals where caller is buyer or seller                                                 |
| POST   | `/api/deals`                 | Identity                                 | Create deal `{sellerId, asset, amount[, terms, deadline]}`; `buyerId` forced to caller; returns one-time join link |
| POST   | `/api/deals/:id/join/:token` | Identity                                 | Consume one-time link, assign missing role (caller id used)                                                        |
| POST   | `/api/deals/:id/chat`        | Identity (party or admin)                | Post `{content}`; sender forced to caller                                                                          |
| POST   | `/api/notify`                | Admin                                    | Send a bot message `{chatId, message}`                                                                             |
| GET    | `/api/notifications`         | Admin                                    | Last 200 notifications                                                                                             |
| POST   | `/api/withdraw`              | Admin                                    | Release wrapper (guarded DB transition; on-chain send stubbed until wallet configured)                             |
| POST   | `/api/refund`                | Admin                                    | Refund wrapper (same caveat as withdraw)                                                                           |

### Headers sent by the webapp

The Mini App attaches `x-init-data` and `x-telegram-user-id` to every request
(`webapp/public/js/api.js`). The backend verifies the initData signature
against `BOT_TOKEN`; requests without valid initData fall back per the auth
legend above. Set `API_KEY` in production even for read endpoints if you do
not want them publicly enumerable.

## Database

Schema lives in [`src/db/schema.sql`](src/db/schema.sql): `users`, `deals`,
`notifications`, `messages`, `deal_links`. `ensureTables()` in
`src/db/queries.ts` creates the same shape at boot, so no manual migration is
needed for a fresh database.

## Off-chain custodial mode (the only supported mode)

The system runs as an off-chain custodial ledger: deals, roles, links, chat
and confirmations all work against Postgres, and fund movement goes through
the isolated signer W5 wallet. There is no on-chain per-deal contract — do
not represent custody as smart-contract enforced. `REQUIRE_ONCHAIN` is a
legacy flag (default `false`); setting it `true` does not enable on-chain
escrow, it only makes `GET /api/status/:address` attempt an on-chain read.
