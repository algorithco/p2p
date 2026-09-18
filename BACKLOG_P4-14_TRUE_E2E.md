# P4-14 vNext — True E2E Chat (operator-blind)

**Decision (GO — defer, keep relabeled encrypted-at-rest):** Per 2026-09-18 go/no-go, keep current `GET /api/deals/:id/key` model (server generates per-deal 32-byte key, encrypts at rest with `ENCRYPTION_KEY`, serves to party/admin). It is **not** E2E against operator and is now honestly documented as “encrypted at rest, admin-accessible for moderation/dispute” (`src/index.ts:834`, `SECURITY.md:36`).

**True E2E backlog — scope if product decides operator-blind is needed:**

- Client-side key generation + DH/Double-Ratchet exchange through existing deal chat channel (server relays ciphertext only, never plaintext).
- Server stores only public keys / wrapped keys it cannot decrypt; `ENCRYPTION_KEY` no longer decrypts chat.
- Key-loss recovery UX (if both parties lose key, chat history unrecoverable).
- Moderation trade-off: admin loses ability to read disputed chats — need alternate dispute evidence (e.g., client-provided transcript export).

**Tracking:** Keep until product prioritizes; reference P4-14 in SECURITY.md and `src/index.ts:834` note.
