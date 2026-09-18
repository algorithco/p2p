# P5-17 vNext — CSP Hardening (remove unsafe-inline)

**Decision (GO — defer, keep accepted risk):** Per 2026-09-18 go/no-go, keep `script-src 'unsafe-inline'` for Mini App (Telegram WebView injects inline bootstrap scripts outside our build pipeline; `frame-ancestors 'none'`, `nosniff`, and no remote script hosts remain). Removing it now would break the app on real clients without a full webapp build + Telegram test matrix.

**Follow-up scope:**

- Rebuild `webapp/` to emit nonces/hashes for all inline scripts/styles (`vite` + `csp` plugin, `__CSP_NONCE__` placeholder).
- Set `Content-Security-Policy: script-src 'self' 'nonce-{random}' https:` per-request, plus `style-src` hashes.
- Verify in Telegram WebView (iOS/Android/Desktop) and standalone browser; add `report-uri` / `report-to`.

**Tracking:** Frontend hardening backlog; reference P5-17.
