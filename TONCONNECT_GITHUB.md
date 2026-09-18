# TON Connect — GitHub Raw Hosting (no Cloudflare)

You asked to **delete cloudflare** and use **GitHub raw URL** for TON Connect.  
Local manifest is **kept** (`backend/src/index.ts` + `webapp/public/tonconnect-manifest.json`) but **not used now** — wallet will use GitHub raw. When you fully deploy with a real domain, switch back to local.

---

## 1. Files prepared (already done)

- `tonconnect-manifest.json` at repo root — **this is what you push to GitHub**
- `webapp/public/tonconnect-manifest.json` — local fallback (http://localhost:8080), kept for future full deploy
- `webapp/public/js/app-config.js` — sets `window.TONCONNECT_MANIFEST_URL` to GitHub raw
- `webapp/public/js/wallet.js` — now uses `getManifestUrl()` : if `TONCONNECT_MANIFEST_URL` is set and not a placeholder → GitHub raw, else → `location.origin + '/tonconnect-manifest.json'`
- `docker-compose.yml` — `cloudflared` + `cloudflared-backend` services **removed** (was 8 services → now 6)
- `webapp/nginx.conf` + `backend/src/index.ts` — comments updated, logic kept for local/future prod

---

## 2. Push manifest to YOUR GitHub

### a) Edit the placeholder

Open these 2 files and replace `YOUR_USERNAME` / `YOUR_REPO`:

1. `tonconnect-manifest.json` (repo root):

```json
{
  "url": "https://github.com/YOUR_USERNAME/YOUR_REPO",
  "name": "Savdochi",
  "iconUrl": "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/webapp/public/icon.png",
  "termsOfUseUrl": "https://github.com/YOUR_USERNAME/YOUR_REPO#terms",
  "privacyPolicyUrl": "https://github.com/YOUR_USERNAME/YOUR_REPO#privacy"
}
```

Use your real GitHub username and repo name. For `iconUrl` you can also use `icon.svg`.

2. `webapp/public/js/app-config.js`:

```js
window.TONCONNECT_MANIFEST_URL =
  'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/tonconnect-manifest.json';
// or CDN: "https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/tonconnect-manifest.json"
```

> If you leave `YOUR_USERNAME` placeholder, `wallet.js` will auto-fallback to local manifest — so TON Connect will still work locally but not via GitHub.

### b) Create repo and push

```bash
# from repo root: C:\Users\hamro\OneDrive\Desktop\p2p bot\escrow-bot

# 1. init if not already a git repo
git init
git add tonconnect-manifest.json webapp/public/js/app-config.js webapp/public/js/wallet.js docker-compose.yml
git commit -m "feat: GitHub raw TON Connect manifest, remove cloudflared"

# 2. create repo on github.com (via web UI) then:
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### c) Get raw URL

After push, your manifest will be at:

```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/tonconnect-manifest.json
```

Test in browser — must return JSON with 200 and `Access-Control-Allow-Origin: *`.

**Alternative CDN (recommended for wallets):**

```
https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/tonconnect-manifest.json
```

jsDelivr has proper `application/json` and CORS — same file, just different URL. Put this URL in `app-config.js` if you prefer.

---

## 3. How it works now (no cloudflare)

- `wallet.js` `getManifestUrl()` → reads `window.TONCONNECT_MANIFEST_URL` (GitHub raw) → `new TonConnectUI({ manifestUrl: "https://raw.githubusercontent.com/..." })`
- Wallet (Tonkeeper, MyTonWallet, etc.) fetches manifest directly from GitHub — **no tunnel, no HTTPS domain needed**
- Local `http://localhost:8080/tonconnect-manifest.json` is still served by backend/nginx but **ignored** until you deploy fully

---

## 4. When you deploy fully (real domain)

1. Set `window.TONCONNECT_MANIFEST_URL = ""` in `webapp/public/js/app-config.js` (or delete the line)
2. Wallet will fallback to `location.origin + '/tonconnect-manifest.json'`
3. That file is served by:
   - `webapp/public/tonconnect-manifest.json` (static) via nginx `location = /tonconnect-manifest.json` → `proxy_pass backend:3000`
   - or backend dynamic `app.get('/tonconnect-manifest.json')` which returns `https://your-domain`
4. Set `WEBAPP_URL=https://your-domain` in `backend/.env` and redeploy

Keep `tonconnect-manifest.json` in repo — just update its `url`/`iconUrl` to `https://your-domain`.

---

## 5. Remove cloudflare completely

Already done in `docker-compose.yml`. To apply:

```bash
docker compose down
docker compose up --build -d --remove-orphans
# --remove-orphans deletes the old cloudflared containers
docker compose ps # should show 6 services, no cloudflared
docker compose logs backend --tail 20 # Bot @savdochi_uzbot started
```

No more `trycloudflare.com` URLs in logs.

---

## 6. Local test before pushing

```bash
# backend still serves local manifest
curl http://localhost:8080/tonconnect-manifest.json
curl http://localhost:3000/tonconnect-manifest.json

# after pushing to GitHub, test raw
curl https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/tonconnect-manifest.json
```

If both return JSON, you are good.
