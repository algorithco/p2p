# Security Policy

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security problems.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability** (https://github.com/algorithco/p2pbot/security/advisories/new).

You can expect:

- **Acknowledgement** within 72 hours.
- An initial **assessment and remediation plan** within 7 days.
- A **fix or mitigation** coordinated with you before any public disclosure.
- Credit in the release notes (unless you prefer to remain anonymous).

## Scope

| Component    | Description                                                                             |
| ------------ | --------------------------------------------------------------------------------------- |
| `backend`    | Telegram bot + REST API + off-chain deal ledger                                         |
| `signer`     | Isolated W5 wallet service (signs all fund movements)                                   |
| ` custodial` | Off-chain escrow ledger (Postgres) + W5 wallet — no on-chain Tact contract in this repo |
| `ubot`       | Telegram userbot — channel/group takeover                                               |
| `utradebot`  | Telegram account-sale escrow bot                                                        |
| `webapp`     | Telegram Mini App                                                                       |

Out of scope: upstream dependencies (report to their maintainers), social
engineering of platform staff, and denial-of-service by volume.

## High-value targets — please scrutinize these areas

1. **Key material**: `SIGNER_MNEMONIC`, `UBOT_SESSION_STRING`, 2FA passwords,
   Telegram `StringSession` values. These must never leave the signer/userbot
   containers or appear in logs, API responses, or the database in plaintext.
2. **Auth boundaries**: `x-init-data` Telegram initData validation, **scoped `x-api-key` vs `x-admin-api-key` (P0-2)** — generic `API_KEY` (signer/ubot service-to-service) does NOT grant admin; `ADMIN_API_KEY` or verified `ADMIN_TELEGRAM_IDS` required for `POST /api/withdraw`, `POST /api/refund`, `POST /api/notify`, `GET /api/notifications`. One-time join-link tokens.
3. **Fund flows**: deposit matching by **unguessable `deposit_token` (P0-1)** — per-deal 128-bit random token minted at creation, encrypted in payload, matched first; legacy `escrow#<id>` only for old in-flight deals. Fallback sender verification: if buyer's wallet `buyer_expected_address` / `users.ton_address` is known, deposit `src` must match else flagged `sender_mismatch` for manual review (no auto-confirm). Residual: if no buyer address knowable at deposit time, memo-token unpredictability is the primary defence — set TonConnect wallet at deal creation to enable sender check. Guarded status transitions, custodial release/refund paths, fee split. Note: custody is entirely off-chain in the signer W5 wallet — there is no on-chain contract enforcing escrow.
4. **Deal integrity**: approval permissions (buyer-only approvals), dispute
   handling, admin commands, E2E chat key derivation.

## Supported versions

Security fixes go to the latest GitHub Release (`v*` tag) and `main`.
Deploy release images (`ghcr.io/…/p2pbot-<service>:<version>` or `:latest`
from a `v*` tag) — never floating `main`/`edge` builds in production.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | ✅                 |
| Older releases | ❌ (upgrade first) |

## Operator security requirements

- Rotate every credential that has ever been committed to git history
  (bot tokens included) — treat history as compromised.
- Keep the signer wallet balance minimal; hold reserves in cold storage.
- Never commit `.env` files, `sessions/` directories, or any mnemonic/seed
  phrase. The mnemonic must exist only in the signer's runtime environment.
- Restrict network access: the signer, ubot, and utradebot must never be
  exposed outside the internal Docker network.
