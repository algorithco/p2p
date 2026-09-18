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

| Variable                                      | Default (code)                  | Description                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOT_TOKEN`                                   | —                               | BotFather token; without it polling is disabled and `/api/notify` returns 503                                                                                                        |
| `ADMIN_TELEGRAM_IDS`                          | empty                           | Comma-separated admin Telegram user ids                                                                                                                                              |
| `DATABASE_URL`                                | —                               | Postgres connection string                                                                                                                                                           |
| `PORT`                                        | `3000`                          | HTTP port (`src/index.ts`)                                                                                                                                                           |
| `TON_API_ENDPOINT`                            | derived from `TON_NETWORK`      | Optional verbatim override, e.g. `https://toncenter.com/api/v2/jsonRPC`                                                                                                              |
| `TON_NETWORK`                                 | `mainnet`                       | `testnet` or `mainnet`; selects the matching toncenter endpoint                                                                                                                      |
| `TONCENTER_API_KEY`                           | empty                           | Optional API key for toncenter (recommended in prod)                                                                                                                                 |
| `SIGNER_URL`                                  | `http://signer:3001`            | URL of the isolated W5 signer microservice                                                                                                                                           |
| `SIGNER_API_KEY`                              | empty                           | Must match `SIGNER_API_KEY` in `signer/.env` (32+ chars)                                                                                                                             |
| `ESCROW_CONTRACT_CODE_HEX`                    | empty (legacy, unused)          | Legacy stub for a removed Tact contract — leave empty; custody is off-chain                                                                                                          |
| `JETTON_MASTER_ADDRESS`                       | unset                           | Jetton master used for jetton deals                                                                                                                                                  |
| `USDT_JETTON_ADDRESS`                         | empty                           | Canonical USDT jetton address on TON                                                                                                                                                 |
| `JETTON_WALLET_CODE_HASH`                     | `0`                             | Decimal string of jetton wallet code hash                                                                                                                                            |
| `FEE_ADDRESS`                                 | empty                           | Fee collector address                                                                                                                                                                |
| `FEE_BPS`                                     | `100`                           | Fee in basis points (100 = 1%)                                                                                                                                                       |
| `FEE_PERCENTAGE`                              | `1`                             | Legacy percent alias; prefer `FEE_BPS`                                                                                                                                               |
| `MIN_CONFIRMATIONS`                           | `3`                             | Confirmations before a deposit is trusted                                                                                                                                            |
| `ADMIN_ADDRESS`                               | empty                           | On-chain arbiter/admin address                                                                                                                                                       |
| `WALLET_ADDRESS`                              | empty                           | W5 signer address (auto-derived from signer; set manually to override)                                                                                                               |
| `REQUIRE_ONCHAIN`                             | `false` (legacy)                | Legacy flag: `false` = custodial off-chain (the only supported mode); `true` only makes `GET /api/status/:address` attempt an on-chain read instead of returning `{mode:'offchain'}` |
| `WEBAPP_URL`                                  | empty                           | Public HTTPS Mini App URL (menu button + join links)                                                                                                                                 |
| `FRONTEND_URL`                                | `WEBAPP_URL` or localhost       | Allowed CORS origin for the Mini App                                                                                                                                                 |
| `BOT_USERNAME`                                | `savdochi_uzbot`                | Bot username for deep links                                                                                                                                                          |
| `API_KEY`                                     | unset                           | Legacy operator header; grants NO identity/admin since 2026-09 (verified `x-init-data` required). Prefer `ADMIN_API_KEY` workflows                                                   |
| `ADMIN_API_KEY`                               | unset                           | Operator admin secret: `x-admin-api-key` header or `Authorization: Bearer` (32+ chars)                                                                                               |
| `ALLOW_DEV_AUTH`                              | `false`                         | Dev-only `x-telegram-user-id` trust; requires `BOT_TOKEN`+`API_KEY` unset; ignored in production                                                                                     |
| `ENCRYPTION_KEY`                              | **required**                    | 64 hex chars (`openssl rand -hex 32`); boot refuses to start without it. MUST equal utradebot's key                                                                                  |
| `SERVE_STATIC`                                | `false`                         | `true` serves `webapp/public` from backend (local dev only)                                                                                                                          |
| `UBOT_URL` / `UBOT_API_KEY`                   | `http://ubot:3002` / empty      | Channel/group userbot endpoint + key                                                                                                                                                 |
| `UTRADE_URL` / `UTRADE_API_KEY`               | `http://utradebot:3003` / empty | Account-sale bot endpoint + key                                                                                                                                                      |
| `JETTON_MASTER_ADDRESS`                       | unset                           | **Required for USDT anti-forgery**: listener verifies jetton notifications come from this master's derived wallet; unset = check disabled (fake-master risk)                         |
| `ESCROW_HOLDER_ID` / `ESCROW_HOLDER_USERNAME` | `8992814642` / `@gramchioka`    | Channel-custody holder account                                                                                                                                                       |

## REST API

Auth legend (see `src/auth/guard.ts`):

- **Telegram identity** — the Mini App sends `x-init-data` on every request;
  it is verified server-side against `BOT_TOKEN` using Telegram's
  HMAC-SHA256 scheme (`src/auth/initData.ts`, 24 h freshness window) and the
  authenticated user id is attached as `req.user`.
- **API key (legacy)** — `x-api-key: <API_KEY>` header only (never in query
  strings), compared timing-safely. Since 2026-09 it grants NO identity and NO
  admin rights (a shared static secret must not impersonate users); operator
  tooling uses `ADMIN_API_KEY` instead.
- **Dev fallback** — only when `ALLOW_DEV_AUTH=true` AND _both_ `BOT_TOKEN`
  and `API_KEY` are unset: trusts `x-telegram-user-id` (logs a one-time
  warning). Ignored in production.
- **Admin** — verified Telegram identity whose id is in `ADMIN_TELEGRAM_IDS`,
  OR `x-admin-api-key: <ADMIN_API_KEY>` / `Authorization: Bearer
<ADMIN_API_KEY>`. Generic `x-api-key` is explicitly NOT admin
  (`requireAdmin`, `src/auth/guard.ts`).

Rate limits (sliding window, per IP+route): global 300/min · create deal
10/min · join 20/min · recheck 20/min · chat post 60/min · deal-key 20/min ·
payout 10/min · utrade-code 5/min · admin-money 10/min · channel-verify 20/min ·
deal-action 20/min · notify 5/min · public TON 30/min.

| Method | Path                                     | Auth                                     | Description                                                                                                                                        |
| ------ | ---------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/info`                              | public                                   | `{feeBps, paymentAddress, network}` — also the health probe target                                                                                 |
| GET    | `/api/deals`                             | Identity (party or admin)                | Private: only deals where caller is buyer/seller (admin sees all 100)                                                                              |
| GET    | `/api/deals/:id`                         | Identity (party or admin, token preview) | Single deal — only buyer/seller/admin or valid `?token=` invite                                                                                    |
| GET    | `/api/deals/:id/key`                     | Identity (party or admin)                | Per-deal chat key (20/min; NOT E2E vs operator)                                                                                                    |
| GET    | `/api/deals/:id/chat`                    | Identity (party or admin)                | Deal chat messages (ciphertext only)                                                                                                               |
| POST   | `/api/deals/:id/ship`                    | Identity (seller)                        | Seller marks sent: `DEPOSIT_CONFIRMED` → `ITEM_SENT`                                                                                               |
| POST   | `/api/deals/:id/approve`                 | Identity (buyer)                         | Buyer confirms: `ITEM_SENT` → `RELEASED`, seller paid                                                                                              |
| POST   | `/api/deals/:id/dispute`                 | Identity (party)                         | Open dispute for admin review (no auto money movement)                                                                                             |
| POST   | `/api/deals/:id/recheck`                 | Identity (party or admin)                | Force immediate on-chain re-poll (20/min)                                                                                                          |
| POST   | `/api/deals/:id/payout-address`          | Identity (seller or admin)               | Set payout destination; frozen once payout starts (10/min)                                                                                         |
| GET    | `/api/users/me`                          | Identity                                 | Own profile                                                                                                                                        |
| POST   | `/api/users/me/ton-address`              | Identity                                 | Save own TON address                                                                                                                               |
| GET    | `/api/deals/:id/payload`                 | Identity (party or admin, token preview) | Deal TON payloads — party/admin or `?token=`                                                                                                       |
| GET    | `/api/status/:address`                   | public                                   | Legacy status read (custodial `{mode:'offchain'}` unless `REQUIRE_ONCHAIN`)                                                                        |
| GET    | `/api/deals/mine`                        | Identity                                 | Alias for `GET /api/deals` — deals where caller is buyer or seller                                                                                 |
| POST   | `/api/deals`                             | Identity                                 | Create `{role: buy\|sell, asset, amount, terms≤2000, deadline?, dealType?, channelUsername?}`; caller takes role slot, counterparty joins via link |
| POST   | `/api/deals/:id/join/:token`             | Identity                                 | `202 {pending:true}` — join REQUEST for creator approval (link not consumed yet)                                                                   |
| POST   | `/api/deals/:id/chat`                    | Identity (party or admin)                | Post `{ciphertext}` (sender forced to caller)                                                                                                      |
| POST   | `/api/deals/:id/channel/*`               | Identity (seller/buyer/admin)            | `verify`, `request-escrow`, `confirm-escrow`, `payout`, `set-new-owner`, `transfer-to-buyer` (20/min; transfer 10/min)                             |
| GET    | `/api/inbox`                             | Identity                                 | Pending join requests across caller deals                                                                                                          |
| GET    | `/api/rating`                            | Identity                                 | Counterparty rating summary                                                                                                                        |
| POST   | `/api/utrade/trades`                     | Identity                                 | Create account-sale trade (phone E.164 validated)                                                                                                  |
| GET    | `/api/utrade/trades/mine`                | Identity                                 | Own trades                                                                                                                                         |
| GET    | `/api/utrade/trades/:id`                 | Identity (party or admin, else 403)      | Single trade                                                                                                                                       |
| POST   | `/api/utrade/trades/:id/phone`           | Identity (seller or admin)               | Set phone; rejected once final/expired                                                                                                             |
| POST   | `/api/utrade/trades/:id/buyer`           | Identity (seller or admin)               | Bind buyer one-shot (guarded); 410 when expired                                                                                                    |
| POST   | `/api/utrade/trades/:id/confirm-payment` | Identity (seller or admin)               | `SELLER_REMOVED/AWAITING_PAYMENT` → `PHONE_SHARED` (guarded)                                                                                       |
| POST   | `/api/utrade/trades/:id/code`            | Identity (buyer, 5/min)                  | Code/2FA → `AWAITING_CODE`/`AWAITING_BUYER_LOGIN` (never auto-`COMPLETED`; requires `PHONE_SHARED` first)                                          |
| GET    | `/api/admin/stuck`                       | Admin                                    | `RELEASE_/REFUND_PENDING` review queue                                                                                                             |
| GET    | `/api/admin/fee-failures`                | Admin                                    | Failed fee legs                                                                                                                                    |
| POST   | `/api/admin/fee-retry/:id`               | Admin                                    | Retry one fee leg (atomic, max 5)                                                                                                                  |
| POST   | `/api/notify`                            | Admin                                    | Send a bot message `{chatId: int, message: ≤1000 chars}`                                                                                           |
| GET    | `/api/notifications`                     | Admin                                    | Last 200 notifications                                                                                                                             |
| POST   | `/api/withdraw`                          | Admin                                    | Release via custodial signer (guarded; 10/min)                                                                                                     |
| POST   | `/api/refund`                            | Admin                                    | Refund via custodial signer (guarded; 10/min)                                                                                                      |

Full machine-readable reference with error codes: `GET /api/docs` (JSON),
interactive `GET /api/swagger`, human `GET /docs`.

### Headers sent by the webapp

The Mini App attaches `x-init-data` and `x-telegram-user-id` to every request
(`webapp/src/lib/api.ts`). The backend verifies the initData HMAC-SHA256
signature against `BOT_TOKEN` (24 h window); the user id is taken from the
VERIFIED payload only — header/body ids are never trusted. Unauthenticated
requests get 401 (no open fallback in a configured deployment).

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
