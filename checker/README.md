# escrow-checker

Standalone NFT ownership checker. **Reads only, never signs**: own port
(`:3004`), own table (`checker_owners`), no imports from `backend/` /
`signer/` / `ubot/`. It is **not called by the deposit listener or any deal
flow** — it runs as an independent compose service (see `checker:` in
`docker-compose.yml`, covered by CI typecheck/build/test/audit) for manual
ownership verification only.

## What it verifies (on-chain first)

| Input                               | Resolution                                                   | Proof                                                     |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| NFT username (`@name`, `t.me/name`) | pure on-chain: root DNS (config#4) → `.t.me` resolver → item | `get_nft_data().owner` + collection == `.t.me` resolver   |
| Gift URL (`t.me/nft/<name>`)        | seller wallet NFT enumeration (TonAPI) + metadata name match | `get_nft_data().owner`; off-chain fallback `getUserGifts` |
| Raw item address                    | direct                                                       | `get_nft_data().owner`                                    |

Keys: `TONCENTER_API_KEY` (majburiy darajada — kalitsiz 429), `TONAPI_KEY`
(gift uchun), `BOT_TOKEN` (gift binding uchun).

Owner + `telegram_id` bindings are saved (`checker_owners`) **only** on a
verified check that carries an authenticated `telegramId`.

## Verdicts

`verified | wrong_owner | not_nft | not_tokenized | offchain_only | unresolved | not_delivered | collection_mismatch | uninitialized`

Rules: `host_id`/active handle is NOT ownership. Indexed hints are never
proof — ownership is always re-read from the item contract.

## Setup

```bash
cp .env.example .env   # PORT, TON_NETWORK, keys, DATABASE_URL
npm install
npm run dev            # :3004 (ts-node)
npm run build && npm start
```

`DATABASE_URL` empty = persistence disabled (save endpoints answer 503,
checks still work). Gifts/usernames live on **mainnet**.

## API

```bash
# classify + verify anything
curl -X POST localhost:3004/api/check/url \
  -H 'Content-Type: application/json' \
  -d '{"url":"t.me/nft/PlushPepe"}'

# username: verify + bind owner wallet <-> telegram id
curl -X POST localhost:3004/api/check/username \
  -H 'Content-Type: application/json' \
  -d '{"username":"durov","telegramId":123456}'

# gift: verify holder, optional expected wallet + telegram binding
curl -X POST localhost:3004/api/check/gift \
  -H 'Content-Type: application/json' \
  -d '{"name":"PlushPepe","number":"42","wallet":"UQ...","telegramId":123456}'

# raw item
curl -X POST localhost:3004/api/check/nft \
  -H 'Content-Type: application/json' \
  -d '{"itemAddress":"EQ...","expectedOwner":"UQ..."}'

# saved bindings
curl localhost:3004/api/owners/123456
curl localhost:3004/api/owners/by-wallet/UQ...

# wait until the item reaches the buyer (long-poll, <=110s per call)
curl -X POST localhost:3004/api/watch \
  -H 'Content-Type: application/json' \
  -d '{"itemAddress":"EQ...","expectOwner":"UQ...","timeoutSec":100}'

curl localhost:3004/api/openapi.json
```

## Limits (honest)

- Gift `name -> address` has no deterministic on-chain path; resolution is
  indexer-assisted (gift page + metadata match). Unmatched = `unresolved`.
- Basic (non-tokenized) usernames are not provable on-chain (`not_tokenized`).
- Arbitrary users' Telegram account IDs are not resolvable by a bot;
  `telegramId` must come from an authenticated caller context (bot/mini-app).
