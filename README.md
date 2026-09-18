# TON Escrow Bot

[![CI](https://github.com/algorithco/p2pbot/actions/workflows/ci.yml/badge.svg)](https://github.com/algorithco/p2pbot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/algorithco/p2pbot/actions/workflows/codeql.yml/badge.svg)](https://github.com/algorithco/p2pbot/actions/workflows/codeql.yml)
[![Secret scan](https://github.com/algorithco/p2pbot/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/algorithco/p2pbot/actions/workflows/gitleaks.yml)
[![Docker Publish](https://github.com/algorithco/p2pbot/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/algorithco/p2pbot/actions/workflows/docker-publish.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Telegram Mini App](https://img.shields.io/badge/Telegram-Mini_App-2CA5E0?logo=telegram)](https://core.telegram.org/bots/webapps)
[![TON](https://img.shields.io/badge/TON-W5-0098EA?logo=ton)](https://ton.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)

A peer-to-peer escrow service for Telegram: a grammY bot plus a Telegram Mini
App that lets two parties trade TON or USDT (jettons) safely. Funds are held
in a custodial W5 signer wallet (off-chain ledger in Postgres tracks every
deal) — there is no on-chain per-deal smart contract; trust rests in the
custodial backend wallet + guarded DB transitions, not in Tact code.

## Architecture — micro-architecture (7 services + Postgres)

```
 Telegram users (chat + Mini App:8080)          Bot API
        │  HTTPS (WEBAPP_URL)                    │
        ▼                                        ▼
┌──────────────────┐      ┌──────────────────────────┐
│  frontend        │      │  backend :3000 (API-only)│
│  webapp nginx    │─────►│  grammY bot + REST API   │
│  :8080 -> :80    │ /api │  /api/*, /docs, /api/info│
│  proxies /api    │      └──────────────────────────┘
└──────────────────┘                 │
                      ┌───────────────┼──────────────────┐
                      ▼               ▼                  ▼
                ┌──────────┐    ┌──────────────┐   ┌──────────────────┐
                │ Postgres │    │ signer (W5)  │   │ Custodial W5     │
                │  :5432   │    │ V5R1 wallet  │◄─►│ wallet: deposits,│
                │ (deals,  │    │ microservice │   │ release/refund   │
                │ msgs,    │    │ :3001        │   │ (off-chain ledger│
                │ trades)  │    └──────────────┘   │  is source of    │
                └──────────┘          │             │  truth)          │
                                      │             └──────────────────┘
                     ┌───────────────┼──────────────────┐
                     ▼               ▼                  ▼
               ┌──────────┐    ┌──────────────┐   ┌──────────────────┐
               │  ubot    │    │  utradebot   │   │  (frontend docs) │
               │ :3002    │    │  :3003       │   │  /docs + openapi │
               │ channel/ │    │  account     │   └──────────────────┘
               │ takeover │    │  sale escrow │
               └──────────┘    └──────────────┘
  escrow-net (bridge) isolates all; published: frontend :8080, backend :3000 (API)
```

- **frontend/** (`webapp/`) — **separate** nginx microservice (`nginx:alpine`, `:8080→:80`), serves static Mini App, **proxies `/api/*` → `http://backend:3000`** (micro-architecture, not same port). Telegram Web App requires `WEBAPP_URL`/`FRONTEND_URL` HTTPS in prod.
- **backend/** — **API-only** (`SERVE_STATIC=false`) grammY bot + Express REST (`:3000`), TON listener/deployer via `signer`, docs at `/api/docs`, `/docs`, `/api/openapi.json`, health `/api/info`, CORS allows `FRONTEND_URL` + `localhost:8080`.
- **signer/** — isolated W5 (V5R1) Wallet (`SIGNER_MNEMONIC` 24 words in `signer/.env`), internal `http://signer:3001`, `x-api-key`.
- **ubot/** — Telegram userbot (`teleproto@1.229.0`, QR login) for channel/group takeover (`channels.editCreator`, `channels.editAdmin`, `messages.migrateChat`), `API_ID`/`API_HASH`/`TWO_FA_PASSWORD` in `ubot/.env`, `:3002`.
- **utradebot/** — account sale escrow (`teleproto`), holds `StringSession`/`phone+code` trades, revokes seller, buyer code handoff, `auth.LogOut`, `:3003`.
- **Trust model** — custodial off-chain: Postgres is the deal ledger, the
  isolated `signer` W5 wallet moves funds. There is no `contracts/` Tact
  contract in this repo and no on-chain escrow enforcement.

## Quickstart

### A. Local (npm) — micro-architecture dev (frontend separate)

1. Run a local PostgreSQL and create the database (generate a strong
   password per deployment — never reuse the placeholder below):
   ```bash
   # openssl rand -base64 32   # use output as the password
   ```
   ```sql
   CREATE USER escrow WITH PASSWORD 'CHANGE_ME_STRONG_RANDOM';
   CREATE DATABASE escrow OWNER escrow;
   ```
2. Configure and run backend (API-only, `:3000`):
   ```bash
   cd backend
   cp .env.example .env    # edit BOT_TOKEN, ADMIN_TELEGRAM_IDS, SIGNER_URL, FRONTEND_URL=http://localhost:8080, SERVE_STATIC=false (or true for single-port dev)
   npm install
   npm run build
   npm start               # API + bot on http://localhost:3000 (docs at /api/docs, /docs)
   # or: npm run dev       # ts-node
   ```
3. In another terminal, run frontend (`:8080`, proxies /api → backend):
   ```bash
   cd webapp
   npm install
   npm start               # http-server public on http://localhost:8080 (or use nginx)
   # Open Mini App at http://localhost:8080 and talk to bot (API via proxy or direct http://localhost:3000)
   ```
   For single-port dev without docker, set `SERVE_STATIC=true` and `FRONTEND_URL=http://localhost:3000` in `backend/.env`, then `http://localhost:3000` serves both.

### B. Docker Compose — micro-architecture (robust, production-ready)

```bash
# 1) Configure every service (edit each .env, chmod 600)
cp backend/.env.example backend/.env       # BOT_TOKEN, ADMIN_TELEGRAM_IDS, SIGNER_URL, FRONTEND_URL=http://localhost:8080, WEBAPP_URL, API_KEY
cp signer/.env.example signer/.env         # SIGNER_MNEMONIC (24 words), SIGNER_API_KEY, TON_NETWORK, TONCENTER_API_KEY
cp ubot/.env.example ubot/.env             # API_ID, API_HASH, TWO_FA_PASSWORD, UBOT_SESSION_STRING, ENCRYPTION_KEY, UBOT_API_KEY
cp utradebot/.env.example utradebot/.env   # UTRADE_BOT_TOKEN, API_ID, API_HASH, ENCRYPTION_KEY

# 2) REQUIRED: set host POSTGRES_PASSWORD (compose fails fast without it — no weak default)
#    Generate per deployment, never commit (root .env is git-ignored):
#      openssl rand -base64 32
#    echo "POSTGRES_PASSWORD=<output>" > .env

# 3) Build & run (7 services, detached, healthchecks, resource limits)
docker compose up --build -d
docker compose ps          # all 7 healthy: postgres, signer, backend, frontend, ubot, utradebot, checker
docker compose logs -f backend   # or signer / frontend / ubot / utradebot

# Frontend (Mini App) — separate microservice, Nginx proxies /api → backend
curl http://localhost:8080/              # 200 HTML (Mini App)
curl http://localhost:8080/api/info      # 200 via proxy (same as backend)

# Backend API-only
curl http://localhost:3000/api/info      # health
curl http://localhost:3000/api/docs      # JSON docs
curl http://localhost:3000/docs          # HTML docs (also via http://localhost:8080/docs)

# Internal (expose only, uncomment ports in compose to reach from host)
# curl http://localhost:3001/health  # signer
# curl http://localhost:3002/health  # ubot
# curl http://localhost:3003/health  # utradebot
```

What the compose provides:

- **Services (7):** `postgres:5432`, `signer:3001` (W5), `backend:3000` **API-only** (`SERVE_STATIC=false`), **`frontend:80 → host 8080` (nginx, serves Mini App, proxies `/api` → `backend:3000`)**, `ubot:3002`, `utradebot:3003`, `checker:3004` (standalone read-only NFT ownership verifier, not in any deal flow) on `escrow-net`.
- **Micro-architecture:** each service independently buildable/scalable, isolated code/Dockerfile, separate ports (frontend `8080`, backend `3000`, signer `3001` internal, ubot `3002`, utradebot `3003`, checker `3004` internal), healthchecks, `depends_on: service_healthy` (frontend waits for backend, backend for postgres+signer).
- **Security:** each runs as non-root, `.env` never baked (`env_file` at runtime), `ENCRYPTION_KEY` + `x-api-key` between services, logs redacted, `CORS` allows `FRONTEND_URL`/`WEBAPP_URL`/`localhost:8080`.
- **Persistence:** volumes `pgdata`, `ubot_sessions`, `utrade_sessions` (600 perms).
- **Ops:** `restart: unless-stopped`, `deploy.resources.limits`, `logging: json-file` (`10m`/`3`), `HEALTHCHECK` per Dockerfile.
- For TLS: put **frontend** + **backend** behind Caddy/nginx with `WEBAPP_URL=https://your-domain` + `FRONTEND_URL` same — Telegram requires HTTPS.

## Environment

All variables are documented per-service:

- [`backend/.env.example`](backend/.env.example) — `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `DATABASE_URL`, `SIGNER_URL`, `SIGNER_API_KEY`, `API_KEY`, `WEBAPP_URL`, TON settings.
- [`signer/.env.example`](signer/.env.example) — `SIGNER_MNEMONIC` (24 words, **never in backend**), `SIGNER_API_KEY`, `TON_NETWORK`, `TONCENTER_API_KEY`.
- [`ubot/.env.example`](ubot/.env.example) — `API_ID`, `API_HASH`, `UBOT_SESSION_STRING`, `TWO_FA_PASSWORD`, `ENCRYPTION_KEY`, `UBOT_API_KEY`.
- [`utradebot/.env.example`](utradebot/.env.example) — `UTRADE_BOT_TOKEN`, `API_ID`, `API_HASH`, `ENCRYPTION_KEY`, `DATABASE_URL`.

Minimum for off-chain: `BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, `DATABASE_URL` (backend) + `SIGNER_MNEMONIC` in `signer` if you need on-chain. For production add `API_KEY`/`SIGNER_API_KEY`/`UBOT_API_KEY`/`UTRADE_API_KEY` (32+ chars each), `WEBAPP_URL`, `POSTGRES_PASSWORD`, and `ENCRYPTION_KEY` (64 hex).

## Webapp / Mini App hosting — micro-architecture

- **Frontend microservice** `webapp/` (`nginx:alpine`, `Dockerfile`, `nginx.conf`) serves `public/` on `:80` → host `:8080`, proxies `/api/*`, `/tonconnect-manifest.json`, `/docs` → `http://backend:3000`. Backend is **API-only** (`SERVE_STATIC=false`).
- Telegram **requires a public HTTPS URL** for Mini Apps. In prod, put **frontend** behind TLS (Caddy/nginx/LB) and set `WEBAPP_URL=https://your-domain` + `FRONTEND_URL` same — the bot menu button ("Open App") only appears when `WEBAPP_URL` is set. Backend `CORS` allows `FRONTEND_URL`.
- Deal cards deep-link into the app as `${WEBAPP_URL}?deal=<id>` and one-time join links as `${WEBAPP_URL}?deal=<id>&join=<token>`.
- `webapp/public` is **not** copied into the backend image anymore (see `backend/Dockerfile`); for single-port dev set `SERVE_STATIC=true`.

## Status & roadmap

| Status | Item                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅     | Bot commands and admin flows                                                                                                                      |
| ✅     | Deal lifecycle tracked off-chain (create → deposit → confirm → release/refund)                                                                    |
| ✅     | Telegram Mini App UI                                                                                                                              |
| ✅     | One-time join links + per-deal chat                                                                                                               |
| ✅     | W5 signer microservice (`signer/`) — isolated `SIGNER_MNEMONIC` (24 words)                                                                        |
| ℹ️     | Custodial model: no on-chain Tact contract — funds sit in the signer W5 wallet; Postgres + idempotent PENDING transitions are the source of truth |
| ⚠️     | Fund the W5 signer wallet (`SIGNER_MNEMONIC` in `signer/.env`, V5R1) with TON for gas                                                             |
| ❌     | Jetton master verification pending (`USDT_JETTON_ADDRESS` not yet validated on-chain)                                                             |

## Contributing — branching, commits, releases

- **No direct pushes to `main`.** Work on a short-lived branch, open a PR,
  wait for green CI, then squash-merge. Branch protection enforces this.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, …) — enforced
  locally by the commit-msg hook and in CI. They drive the changelog.
- **Local gates** (installed via `npm install` at the repo root): pre-commit
  runs prettier + eslint on staged files and a secret scan if `gitleaks` is
  installed. Run the full suite any time with `npm run verify`
  (typecheck + lint + format check).
- **CI gates every PR**: commitlint, ESLint, prettier, `tsc --noEmit` and
  `npm run build` per package, blocking `npm audit`, Gitleaks, CodeQL, and a
  Docker build + Trivy scan (images push only from `main`/`v*`, never PRs).
- **Releases are automatic** (release-please): merging `feat:`/`fix:` to
  `main` opens a release PR; merging it tags `v*`, publishes GitHub Release
  notes, and ships `semver` + `latest` GHCR images with provenance
  attestation. Deploy releases, not floating `main`.

## Security notes

- **Rotate any credential that has ever been committed** (BOT_TOKEN included).
  Treat everything in git history as compromised.
- Never commit a real `.env`; it is git-ignored.
- API auth (see `backend/src/auth/`): mutating routes require a Telegram
  identity — the Mini App's `x-init-data` is HMAC-verified server-side against
  `BOT_TOKEN` (sender/body ids are never trusted). The legacy `x-api-key`
  grants NO identity and NO admin rights. Admin-only routes (`notify`,
  `withdraw`, `refund`, notifications history, `admin/*`) require the caller
  to be in `ADMIN_TELEGRAM_IDS` (verified identity) or to present
  `ADMIN_API_KEY` via `x-admin-api-key`/`Bearer`. A dev fallback trusting
  `x-telegram-user-id` activates only when `ALLOW_DEV_AUTH=true` AND both
  `BOT_TOKEN` and `API_KEY` are unset — never in production.
- Custody model: funds sit in the isolated signer W5 wallet; Postgres is the
  ledger. Deposits are matched by unguessable memo token + amount, sender
  address, and (USDT) jetton-master verification — see `JETTON_MASTER_ADDRESS`
  in `backend/.env.example` (unset = forgery check disabled).
- Request bodies are capped at 256 KB. In-memory rate limits are active:
  global 300/min, deal creation 10/min, join/recheck 20/min, chat 60/min,
  deal-key 20/min, payout 10/min, utrade-code 5/min, admin-money 10/min,
  notify 5/min per IP+route.

## License

**GNU Affero General Public License v3.0 (AGPL-3.0) — Strict, Official, OSI-Approved.** See [LICENSE](LICENSE).

This is the strictest official OSI-approved license. It ensures anyone who runs a modified version over a network (e.g., as a Telegram bot / Mini App backend) must make the complete Corresponding Source available to all remote users via a network server at no charge (Section 13). Includes strong copyleft and explicit patent grant. Commercial use without source disclosure is not permitted — use the network clause to preserve user freedom for SaaS.

_Other strict official alternatives:_ `GPL-3.0` (copyleft without network clause) and `Apache-2.0` (permissive, patent grant, commercial-friendly). This project uses `AGPL-3.0` for maximum strictness.
