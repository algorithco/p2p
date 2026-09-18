# TonEscrow — Telegram Mini App

A Telegram Web App (Mini App) front-end for the P2P escrow bot, built with
Vite + TypeScript (`src/`, entry `src/main.ts`, output `dist/`). In
production it is served by a separate nginx service (see `Dockerfile` +
`nginx.conf`), which proxies `/api/*` to the backend — the backend does NOT
serve it (`SERVE_STATIC=false`). `public/` keeps legacy static assets
(`public/js/*.js`, CSS, manifest) alongside the Vite build; the TypeScript
sources under `src/lib/` + `src/views/` are the source of truth, with
`src/legacy/app.js` kept for reference during migration.

## Features

- **Deals dashboard** — stats, Active / Completed / All filters, live-polling deal cards
- **4-step create-deal wizard** — role selection, counterparty ID, TON/USDT asset + amount with fee estimate, terms & deadline, review; submits via the native Telegram **MainButton**
- **Deal detail** — status timeline, buyer/seller party cards, terms, metadata, custodial deposit address (copy + Tonviewer explorer link), deposit status chip, share invite link
- **Deal chat** — per-deal messaging with 4s polling and optimistic send
- **Join flow** — deep links (`#/deal/:id/join/:token`) and `start_param` support (`dealId.token`)
- **Account screen** — profile card, Auto/Light/Dark appearance override, API connectivity test, admin tools entry
- **Admin tools** — bot broadcast notifications + recent history (visible when your Telegram ID is in `ADMIN_TELEGRAM_IDS`)
- **Telegram integration** — `telegram-web-app.js`, theme sync via CSS variables, BackButton/MainButton, HapticFeedback, closing confirmation guard, safe-area insets, viewport height fix — all gracefully degraded to a "Preview mode" when opened outside Telegram

## Structure

```
index.html           Vite entry (loads src/main.ts)
src/
├── main.ts         app bootstrap
├── lib/            typed clients: api.ts (REST + x-init-data), wallet.ts (TONConnect), crypto.ts, tg.ts, ui.ts
├── views/          screens (deals, deal detail, chat, profile, admin)
├── legacy/app.js   pre-Vite implementation, kept for reference (not loaded by index.html)
└── styles/         CSS
public/              static assets copied verbatim to dist/ (manifest, icons, tonconnect-manifest.json)
└── js/              legacy static bundle (tg.js, api.js, ui.js, app.js) — superseded by src/, kept until migration completes
dist/                `npm run build` output (what nginx serves)
```

## Run locally

```bash
cd webapp
npm install
npm run dev        # vite dev on http://localhost:8080, /api proxied to http://localhost:3000
npm run build      # type-checked Vite build into dist/
npm run preview    # serve the dist/ build locally
```

In production the `frontend` service (nginx, `webapp/Dockerfile`) serves
`dist/` on `:80` (host `:8080`) and proxies `/api/*`,
`/tonconnect-manifest.json`, `/docs` to `http://backend:3000`. The backend
never serves the app in production (`SERVE_STATIC=false`); setting
`SERVE_STATIC=true` makes the backend serve `webapp/dist/` as a single-port
local-dev fallback only.

## Deploying inside Telegram

1. Host on a **public HTTPS URL** (required by Telegram).
2. Point the bot's menu button / inline `web_app` button at that URL.
3. Invite links use `{origin}/api/deals/{id}/join/{token}`; the app also accepts `start_param` in the form `dealId.token` when launched via `t.me/yourbot?startapp=...`.

## Backend expectations

| Endpoint                                       | Used for                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/info`                                | admin IDs + connectivity check                                  |
| `GET /api/deals/mine` (alias `GET /api/deals`) | private dashboard — only own deals (admin sees all)             |
| `GET /api/deals/:id?token=`                    | private detail — only buyer/seller/admin or valid invite token  |
| `POST /api/deals`                              | create (`{sellerId, buyerId, asset, amount, terms, deadline}`)  |
| `POST /api/deals/:id/join/:token`              | join via invite                                                 |
| `GET/POST /api/deals/:id/chat`                 | private deal chat (party/admin only)                            |
| `GET /api/status/:address`                     | legacy status read (custodial mode returns `{mode:'offchain'}`) |
| `POST /api/notify`, `GET /api/notifications`   | admin tools                                                     |

The client forwards `x-init-data` and `x-telegram-user-id` headers on every request so the backend can add initData validation later.

## Packaging as TWA (optional)

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://your-public-url/manifest.json
bubblewrap build
```
