# OracleDesk Backend

OracleDesk is an AI prediction-market terminal. Agents propose markets and trade them on Stellar, and every decision ships with a reasoning trace whose hash is recorded on-chain so anyone can check it. This repo is the API, the Stellar event indexer and the LLM pipeline. It handles wallet login and subscriptions, and creates markets and agent trades through the treasury contract (dry-run by default).

> **Testnet only, unaudited.** See [docs/STATUS.md](docs/STATUS.md) for what is verified.

## How the three repos fit

| Repo | Role |
|---|---|
| [OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract) | Soroban contracts, generated TypeScript bindings, testnet deployment, the x402 trace service. **Source of truth.** Pinned here as the `contracts` submodule. |
| **OracleDesk-Backend** (this repo) | API ([docs/api.md](docs/api.md)), indexer, agents. |
| [OracleDesk-Frontend](https://github.com/OracleDesk/OracleDesk-Frontend) | Next.js web app. Reads contracts directly, signs with the user's wallet. |

```mermaid
flowchart LR
  fe[Frontend] -->|REST + socket.io| api[Express API]
  subgraph Backend
    api --> db[(Postgres)]
    api --> redis[(Redis<br/>login challenges)]
    idx[Indexer<br/>getEvents poller] --> db
    idx -->|TRADE_EXECUTED<br/>REASONING_PUBLISHED| api
    agents[Market-maker + trader agents<br/>LLM pipeline] --> db
    agents --> chain[chain.service<br/>dry-run by default]
  end
  agents --> ipfs[(IPFS / Pinata)]
  chain -->|treasury.agent_create_market<br/>agent_buy / agent_sell<br/>reasoning_registry.publish_trace| rpc[(Stellar RPC testnet)]
  idx --> rpc
  api -->|verify payments,<br/>read market/resolver state| rpc
```

More detail in [docs/architecture.md](docs/architecture.md).

## Prerequisites

- Node.js 22 LTS (`.nvmrc`). Built and tested here with Node 24.13.1 and npm 11.8.0; CI uses Node 22.
- npm 10 or later.
- Docker with Compose, for the local PostgreSQL 16 and Redis 7 in `docker-compose.yml` (or your own servers).
- Optional: LLM keys (Anthropic or Gemini) for market generation, Pinata credentials for IPFS pinning, and NewsAPI or FRED credentials for news and macro signals. The server boots without them.
- Optional: the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) 27+ to cross-check contract state.

## Quick start

```bash
git clone --recurse-submodules https://github.com/OracleDesk/OracleDesk-Backend.git
cd OracleDesk-Backend
git submodule update --init      # if you cloned without --recurse-submodules
nvm use
npm ci
npm run sync:contracts           # no-op unless the submodule moved
docker compose up -d             # Postgres (with pgvector) on 127.0.0.1:5433, Redis on 6379
cp .env.example .env             # works as-is with the Compose services
npx prisma migrate dev
npm run dev                      # http://localhost:8000
```

Then, in another terminal, `scripts/smoke.sh` checks health, wallet login with a throwaway key, the market list and a live testnet read.

The server boots without LLM, Pinata or data-source keys; market generation and IPFS pinning fail until you add them. With an empty `JWT_SECRET` / `AUTH_SIGNING_SECRET` it generates throwaway ones per process and warns, so set real ones for anything shared.

## Configuration

All variables are listed and explained in [.env.example](.env.example). Everything defaults to Stellar Testnet and the contract ids in the synced deployments file. Config is validated at startup by `src/config/index.ts`; a bad or missing value stops the server with the variable's name. Never commit `.env`.

Key switches:

- `CHAIN_EXECUTION_MODE=dry-run` (default): every contract write is built and simulated, logged, and never signed. `live` signs with `AGENT_SECRET_KEY` and is refused on any network but testnet.
- `PAYMENTS_RECIPIENT`: where daily-pass payments must go. Defaults to the treasury contract; see [docs/STATUS.md](docs/STATUS.md) before relying on that.
- `ADMIN_ADDRESSES`: G-addresses allowed to trigger market generation.
- `SECRETS_PROVIDER`: `env` (default), `file` (`<NAME>_FILE` mounts) or
  `vault`. See [docs/architecture.md](docs/architecture.md#secrets-145).
- `IPFS_TRANSPORT=local` stores pinned bytes in `.ipfs-local/` for offline
  development; production refuses it.

### Offline seeded environment (#147)

```bash
IPFS_TRANSPORT=local npm run db:seed        # deterministic; writes .ipfs-local/
IPFS_TRANSPORT=local npm run dev
```

Every seeded question and trace hash commits to bytes stored under
`.ipfs-local/<cid>`, so `POST /traces/verify` and the trace-hash checks pass
without Pinata or network access. `npm run db:seed -- --reset` truncates first;
`--now` shifts timestamps; `--from-snapshot <dir>` loads an anonymised NDJSON
snapshot; `--with-raw-events <file>` writes a `getEvents` fixture.

## API at a glance

The full contract with the frontend, including request and response shapes, error codes and the socket.io payloads, is [docs/api.md](docs/api.md). All routes are under `/api/v1` and return `{ ok, data, error, meta? }`. On-chain ids are decimal strings, and on-chain amounts are 7-decimal base-unit strings ending in `Raw`.

| Area | Endpoints |
|---|---|
| Health | `GET /health`, `GET /readyz` |
| Auth | `POST /auth/challenge`, `POST /auth/verify` (signed challenge transaction → JWT) |
| Markets | `GET /markets`, `GET /markets/:id`, `GET /markets/on-chain/:onChainMarketId`, `GET /markets/on-chain/:onChainMarketId/state` (live from the chain), `POST /markets/generate` (admin), `GET /markets/generation-status/:jobId` |
| Traces | `GET /traces`, `GET /traces/:id`, `POST /traces/verify`, `POST /traces/:id/unlock` (daily pass, verified on-chain), `GET`/`PUT /traces/access/allowance`, `GET /traces/payments` |
| Portfolio | `GET /portfolio`, `GET /portfolio/positions`, `GET /portfolio/stats` |
| Copy trade | `POST /trade/copy`, `PATCH /trade/copy/:id/confirm` |
| Resolution | `GET /oracle/markets/:marketId/resolution` (read-only; outcomes are decided on-chain) |
| Realtime | socket.io events `TRADE_EXECUTED`, `REASONING_PUBLISHED` (from the indexer) |

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with reload |
| `npm run build` / `npm start` | Compile to `dist/` / build and run |
| `npm test` | Compile and run `tests/*.test.ts` with `node:test` |
| `npm run eval:markets -- --replay` | Offline evaluation of market generation against recorded model output (no keys; see `docs/architecture.md`) |
| `npm run calibrate:dedup` | Calibrate the semantic dedup threshold on labelled pairs (`--provider fake` needs nothing) |
| `npm run backfill:embeddings` | Embed markets that have no question vector (`-- --reembed` after a model change) |
| `npm run test:integration` | Integration tests against real Postgres + Redis (Docker or `TEST_DATABASE_URL`/`TEST_REDIS_URL`; see CONTRIBUTING.md) |
| `npm run test:all` | Unit then integration tests |
| `npm run sync:contracts` | Copy generated contract code from `contracts/` into `src/generated/` |
| `npm run check:contracts` | Fail if `src/generated/` is stale (CI runs this) |
| `npm run prisma:migrate` | `prisma migrate dev` |
| `npm run db:seed` | Deterministic local dataset (#147); `--reset`, `--now`, `--from-snapshot`, `--link-testnet` |
| `npm run snapshot:export -- --out <dir>` | Anonymised NDJSON snapshot (`SNAPSHOT_SALT` required) |
| `npm run reconcile:post-restore -- --manifest … --out …` | Replay the chain gap after a restore (#146) |
| `scripts/backup.sh` / `scripts/restore.sh` | Dump with manifest + checksum / restore (#146) |
| `scripts/check-migration-compat.mjs` | Expand/contract migration lint (#144) |
| `scripts/post-deploy-checks.sh` | Readiness, digest, indexer lag and burn-rate checks |
| `scripts/smoke.sh` | Smoke test a running server (health, login, markets, live chain read) |
| `docker compose up -d` / `down` | Start / stop local Postgres and Redis |
| `docker compose --profile backup up -d backup` | Optional backup loop |

## Project structure

```
src/
  agents/        Market-maker and trader cycles
  config/        Env validation (zod) and contract ids
  controllers/   HTTP handlers          routes/   Express routers
  services/      chain (Stellar writes/reads), indexer, auth, payments,
                 IPFS, trace publishing, market creation, LLM-backed logic
  services/stellar/  Binding clients and contract error names
  lib/           Prisma, Redis, logger, categories, amounts, resolution specs
  seed/          Deterministic dataset + raw-event encoder (#147)
  generated/     Copied from the contracts submodule. Do not edit.
prisma/          Schema, forward-only migrations, seed runner
tests/           node:test suites and fixtures
scripts/         Contract sync, seed/snapshot/reconcile, backup/restore, deploy checks
docker-compose.yml  Local Postgres and Redis
contracts/       OracleDesk-SmartContract submodule (pinned)
docs/            API contract, architecture, porting notes, status, backlog
```

## Deployed testnet contracts

From `src/generated/deployments.testnet.json` (contracts commit `eb5f3fd`):

| Contract | Id |
|---|---|
| market-core | `CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O` |
| treasury | `CBTFA3EPQ63PL5XXHOMU4LRDCAB2MHKOLEPDQI7E7TNK454YNBOMZLYB` |
| resolver | `CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR` |
| reasoning-registry | `CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M` |
| USDC (self-issued test asset, SAC) | `CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), including how to pick up a Drips Wave issue. Security reports: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
