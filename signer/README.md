# Signer — TON W5 (V5R1) Microservice

Isolated key management for the escrow backend. Holds `SIGNER_MNEMONIC` (24 words) **only** inside this service; backend never sees the mnemonic and talks to signer over the internal docker network (`http://signer:3001`) authenticated via `SIGNER_API_KEY`.

- Wallet: `WalletContractV5R1` (`@ton/ton` `^15`, `@ton/crypto` `^3.3`, `@ton/core` `^0.63`)
- Network: `testnet` (default) or `mainnet` via `TON_NETWORK`
- Endpoints: `GET /health` (open), `GET /address`, `GET /info`, `POST /deploy`, `POST /send`, `POST /send-batch`, `POST /deploy-escrow` (all require `x-api-key`). Note: `deploy-escrow` is a generic state-init sender kept for compat — there is no Tact escrow contract in this repo; custody is the W5 wallet itself.

## Setup

```bash
cp .env.example .env  # fill SIGNER_MNEMONIC (24 words), SIGNER_API_KEY (32+ chars)
npm install
npm run build
npm start  # or npm run dev
# scripts
npm run info   # address / balance / seqno
npm run deploy # deploy W5 wallet (fund address first)
npm run send -- <to> <valueTON> [comment]
```

`.env` options: see `.env.example` (`SIGNER_MNEMONIC`, `SIGNER_API_KEY`, `TON_NETWORK`, `TON_API_ENDPOINT`, `TONCENTER_API_KEY`, `PORT`, `CORS_ORIGIN`, `WALLET_WORKCHAIN`).

## API

```bash
# health (no auth)
curl http://localhost:3001/health

# address/info (auth)
curl -H "x-api-key: $SIGNER_API_KEY" http://localhost:3001/address
curl -H "x-api-key: $SIGNER_API_KEY" http://localhost:3001/info

# send TON
curl -X POST -H "x-api-key: $SIGNER_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"UQ...","value":"0.1","comment":"payout"}' http://localhost:3001/send

# deploy escrow contract (LEGACY generic sender — no Tact contract in repo)
curl -X POST -H "x-api-key: $SIGNER_API_KEY" -H "Content-Type: application/json" \
  -d '{"escrowAddress":"EQ...","escrowStateInit":{"codeBoc":"<base64>","dataBoc":"<base64>"},"value":"0.12"}' \
  http://localhost:3001/deploy-escrow
```

## Security

- Never commit `.env`; file is git-ignored, not copied into Docker image.
- `SIGNER_API_KEY` must be 32+ chars; rotate if ever leaked.
- Logs redact `mnemonic`/`secretKey`.
- Run with `chmod 600 .env` and `USER signer` in Docker.

## Docker

See root `docker-compose.yml` — service `signer` builds from `signer/Dockerfile`, `expose: 3001`, healthcheck `GET /health`, restart `unless-stopped`.
