# Status

Last updated: 2026-10-07. This is the honest account of the Stellar port of the backend: what works, what isn't verified, and what a human has to decide. "Verified" means a command was run and its output observed in the session that wrote this file.

## ⚠️ Action required before anything else

1. **Rotate the Circle credentials.** `.env.example` carried commented-out lines with what look like a real Circle API key (`TEST_API_KEY:…`) and entity secret, committed in `6a605bf` and present in history since. They are removed on this branch (`cb86f4d`), but **they remain public in git history**, which was deliberately not rewritten. Rotate both in the Circle console. gitleaks flags the entity secret at `.env.example`, commit `6a605bf`.
2. **The frontend developer's local `.env`** (not committed) holds two 66-character private keys and Circle credentials under `NEXT_PUBLIC_*` names (`NEXT_PUBLIC_DEPLOYER_PRIVATE_KEY`, `NEXT_PUBLIC_POLYGON_PRIVATE_KEY`, `NEXT_PUBLIC_CIRCLE_API_KEY`, `NEXT_PUBLIC_CIRCLE_ENTITY_SECRET`). Next.js compiles any referenced `NEXT_PUBLIC_*` value into browser JavaScript. No tracked code ever referenced them, and the new build doesn't contain them (checked by grepping `.next/static` for the values). If any hosted deployment (e.g. Vercel) has them set, remove them there too, and treat those keys as compromised if they were ever exposed.

## Toolchain

Node v24.13.1, npm 11.8.0 (CI: Node 22 via `.nvmrc`), TypeScript 6.0.3, Express 5.2.1, Prisma 6.19.3, zod 4.4.3, `@stellar/stellar-sdk` 16.3.1 (the bindings' major), Stellar CLI 27.1.0, gitleaks 8.30.1, Docker 29.8.2 with `pgvector/pgvector:pg16` (Postgres 16 plus the `vector` extension, required by the #69 migration; managed Postgres needs `CREATE EXTENSION vector`) and `redis:7-alpine`. Contracts submodule pinned at `OracleDesk-SmartContract@eb5f3fd`.

## Phases

| Phase | Status | Evidence |
|---|---|---|
| 0. Recon and safety | ✅ | gitleaks over full history; `.env.example` cleaned; `dist/`, `backend.log`, `.DS_Store` untracked; `docs/PORTING.md`; baseline recorded below |
| A. API contract | ✅ | `docs/api.md` covers every call in the frontend's `lib/api/*.ts` (call map at the end of the file) plus the auth endpoints |
| B1. Deps and config | ✅ | viem, ethers and xss-clean removed; zod config with named errors (`tests/config.test.ts`) |
| B2. Bindings sync | ✅ | `npm run check:contracts` exits 1 when stale, 0 after `sync:contracts` |
| B3. Chain service | ✅ code, ⚠️ live mode never run | Treasury-routed writes, dry-run simulates and returns. Live signing is implemented but no transaction was ever signed (by design) |
| B4. Resolution commitment | ✅ | TS hash equals the Rust `spec-hash` tool for 2 signer and 2 price fixtures (`tests/resolution-spec.test.ts`) |
| B5. Traces | ✅ unit, ⚠️ real Pinata unverified | Exact-bytes pin/hash with a mocked transport; no real Pinata upload was made (no keys used) |
| B6. Indexer | ✅ unit, ⚠️ synthetic fixtures | RPC retention held no OracleDesk events; fixtures encoded from the contract specs |
| B7. Dead integrations | ✅ | Circle, Polymarket, webhook, CCTP code deleted; `grep` clean (below) |
| B8. Auth, payments, resolution | ✅ | 6 auth tests, 2 payment test groups (10 failure/success cases), resolve endpoint 404 |
| B9. Security pass | ✅ | CORS allowlist test, rate limits, pino redaction, admin allowlist test |
| D. End to end | ✅ (read paths) | See "Phase D" below |
| E. Contributor readiness | ✅ files, ⚠️ CI never ran on GitHub | README, CONTRIBUTING, SECURITY, CoC, LICENSE, templates, CI workflow |
| F. Backlog | ✅ | 14 drafts in `docs/wave-issues/` (4 good first issues) |

## Baseline (before any change)

- `npm ci`, `npx prisma generate`, `npm run build`: exit 0.
- `npm test`: **failed**, 0 of 2 test files ran. Config validation exited because `GEMINI_API_KEY` was required and unset. Once runnable, `market-reasoning.test.ts` also had a regex typo ("within confidence interval" vs the real "within the confidence interval"), fixed in `1d6803c`.
- Existing migrations applied cleanly to an empty Postgres 16, with no drift against the schema.

## Secrets scan

- `gitleaks detect --log-opts=--all` (32 commits): 2 findings. `CIRCLE_ENTITY_SECRET` in `.env.example` (commit `6a605bf`): **real**, see Action required. `EURC_TOKEN_ADDRESS`: a public token address, false positive.
- Regex sweep of `git log -p --all` (seed, 64-hex, `sk-`, `AIza`, `PRIVATE_KEY=`, `SECRET=`, `TEST_API_KEY:`, PEM): additionally the commented `CIRCLE_API_KEY=TEST_API_KEY:…` line (gitleaks missed it), and an 11-character `0x…` placeholder in an old README.
- Every commit on this branch was scanned first with `gitleaks git --pre-commit --staged`. One false positive (the phrase "NewsAPI/FRED keys" in the README) was reworded rather than allowlisted.

## Fully verified (commands run, output observed)

- `npm run build` → exit 0.
- `npm test` → `tests 30, pass 30, fail 0`: categories (3), resolution spec (2), amounts/hashing/exact-bytes IPFS round trip (3), auth (6), config (2), HTTP (5), indexer (4), market maths (3), payments (2).
- `npm run check:contracts` → "generated files match contracts@eb5f3fd" (exit 0); exits 1 with six "stale" lines before syncing.
- `npx prisma migrate dev` on a fresh database (`oracledesk_fresh`) → "Your database is now in sync with your schema." The new migration was also applied over an existing EURC market row: the row became USDC and the migration succeeded. `prisma migrate diff` afterwards: empty.
- The README quick start, run verbatim (`docker compose up -d`, `cp .env.example .env` unchanged, `npx prisma migrate dev`, `npm run dev`), boots and passes `scripts/smoke.sh`. An earlier run with only `DATABASE_URL` and `REDIS_URL` changed in `.env` showed the same log: logs "Database connected", the ephemeral-secret warning, `mode: "dry-run"`, the indexer started, "running on port 8000". No secret values appear in the log (grep for `S…` seeds and JWTs: 0).
- `scripts/smoke.sh` → "smoke: all steps passed": health; challenge; verify with a throwaway key; replay rejected (`CHALLENGE_NOT_FOUND`); markets list; `GET /markets/on-chain/0/state` live from testnet (`Resolved YES`, yesBps 5319, reserves 1407129456 / 1599000000).
- An unknown market returns `CHAIN_ERROR` with `contractError: "MarketNotFound"`.
- A fresh `git clone --recurse-submodules -b feat/stellar-port` checks out `contracts` at `eb5f3fd`, and `npm ci`, `check:contracts`, `prisma generate`, `build` and `npm test` (30/30) pass in it.
- `.github/workflows/ci.yml` parses (js-yaml): one job, 8 steps, with Postgres and Redis services.
- `grep -rnE "viem|ethers|0x[0-9a-f]{40}|\bArc\b" src --exclude-dir=generated` → no matches.
- `POST /api/v1/oracle/resolve` and `POST /api/v1/auth/connect` → 404.
- Resolution-spec hashes, all byte-equal to `scripts/spec-hash` (Rust) at `eb5f3fd`: `4ef7a0fb…` (signers 1/3600), `1bd304d2…` (signers 2/0), `a35631a6…` (price, other:BTC), `771d8cf4…` (price, stellar address, negative threshold).

## Phase D (with the frontend)

The backend ran locally in dry-run against testnet; the frontend's own `lib/stellar` code ran in `npm run e2e:testnet` (frontend repo):

1. Backend market `e2e-market-1` (seeded with `onChainMarketId = 1`; the backfill is backlog #01) joined to `get_market(1)`: Resolved, yesBps 5319, category Macro matches `contractCategory`.
2. FPMM `yesBps` 5319 = binding `get_price` 5319 = `stellar contract invoke … -- get_price --market_id 1 --outcome Yes` 5319 (market 0: also 5319).
3. Login with a throwaway keypair: `scripts/smoke.sh` (above).
4. Trace #1 published by `scripts/demo.sh`: its exact bytes were rebuilt from the script's template (timestamp 1789999207, 10 s before `published_at`). sha256 equals the on-chain `38f728a8…`; a tampered copy fails; the real gateway can't serve the placeholder CID `ipfs://demo-trace-placeholder`, so live fetch is `unavailable`. Trace #0 came from an earlier interactive run with a different template and couldn't be rebuilt.

## Not verified (and how to verify)

| Item | Why not | How to verify |
|---|---|---|
| `CHAIN_EXECUTION_MODE=live` writes (create market, buy, sell, publish trace) | Ground rule: never sign with a real key. The only funded agent key (`oracledesk-agent` in the developer's `stellar keys`) was not touched. | On testnet only: set `AGENT_SECRET_KEY` to the registered agent's seed and `CHAIN_EXECUTION_MODE=live`, run `POST /markets/generate` as an admin, and check the market on Stellar Expert. |
| Real Pinata pin + gateway fetch of the same bytes | No Pinata credentials used | Set Pinata keys, generate a market, then `POST /traces/verify` once the trace is published. |
| Payment verification against a real transaction | Tests use real Soroban envelopes behind a fake RPC reader; no USDC was moved | Frontend `/premium` flow (docs/manual-test.md), then check `payment_events`. |
| Indexer against real events | Testnet RPC retention (about 7 days) held none; Horizon has no metadata for the demo transactions | Backlog #14: record events after fresh testnet activity. |
| socket.io events reaching a browser | Emission is unit-tested; no browser session | Open `/markets` with a live backend while a trade happens. |
| CI workflow | Never pushed, so it never ran on GitHub | Push the branch and open a PR. |
| Intermediate commits | Only the branch tip is built and tested; some intermediate commits don't compile on their own (e.g. `3b6483b` deletes `circle.service.ts` before its importers change) | Not needed unless you bisect. |

## Decisions made, and why

- **Auth uses a SEP-10 challenge transaction, not signMessage.** In stellar-wallets-kit 2.5.0, Ledger, Trezor, Albedo, Bitget, Klever and OneKey report `signMessage` as unsupported; every module signs transactions. The SDK's `readChallengeTx` allows 5 minutes of grace past the time bounds, so expiry is enforced separately.
- **EURC dropped.** market-core takes exactly one collateral token; a "display-only" EURC label would describe markets that can't settle in EURC. The migration converts existing rows.
- **Per-trace unlocks go through x402 directly from the frontend;** the backend keeps the daily pass only (`x402/trace-api.ts` is built for the client to pay the resource server).
- **The chain service doesn't reuse `agents/stellar/adapter.ts`:** its dry-run doesn't simulate, it imports bindings by package name, and it has no `agent_sell`. Method names match so they can converge (contract-requests #5).
- **Contracts as a git submodule** pinned at the same commit as the frontend, copied into `src/generated/` by a script with a CI staleness check.
- **Arc-era columns dropped, not renamed.** The old `sha256Hash` hashed a re-serialised object (and the old `sha256Json` replacer silently dropped nested keys), so carrying it into `traceHash` would make unverifiable traces look verifiable.
- **Dev-only ephemeral secrets.** Empty `JWT_SECRET` / `AUTH_SIGNING_SECRET` are generated per process outside production, so the server boots from `.env.example`; production refuses to start without them.
- **`/portfolio/stats` reimplemented without padding.** The unpushed draft (commit `207464d`, found only in the frontend's old submodule and preserved here as branch `rescued/platform-stats-207464d`) added constants such as `+1284` subscribers and `+142000` volume.
- **`hedging.service.ts` kept:** it has no chain or Polymarket calls (`PORTING.md` corrected). Its `autoHedge` writes PENDING trades that nothing executes; backlog #11.
- **License: MIT,** matching the contracts repo (package.json said ISC with no LICENSE file).

## Decisions left for a human

1. **Rotate the Circle credentials** (see the top of this file), and clear the `NEXT_PUBLIC_*` secrets from the frontend `.env` and any hosting.
2. **Where payments go.** `PAYMENTS_RECIPIENT` defaults to the treasury contract. The treasury's trading capital *is* its USDC balance, so subscription revenue would become agent trading capital. A separate revenue account is probably wanted; set `PAYMENTS_RECIPIENT` (backend) and `NEXT_PUBLIC_PAYMENTS_RECIPIENT` (frontend) to it.
3. **EURC.** Dropped here (reason above). If EUR markets matter, they need a second market-core deployment or a contract change.
4. **Submodule choice.** Both repos pin the contracts as a submodule at `eb5f3fd`. The frontend's broken `OracleDesk-Backend` submodule was removed rather than bumped.
5. **License.** MIT, copied from the contracts repo. Confirm.
6. **SECURITY contact.** `SECURITY.md` has a placeholder address (`SECURITY-CONTACT-TBD@example.invalid`) and a TODO for a response timeline.
7. **Daily-pass price and the premium tiers.** The backend sells one product, a 24-hour pass at `DAILY_PASS_PRICE_RAW` (0.50 USDC). The frontend's old "$20 / $50 per month" tiers weren't backed by anything and now show the daily pass and "Not available yet".
8. **Admin addresses and auth domain.** Set `ADMIN_ADDRESSES`, `AUTH_SIGNING_SECRET` (a fresh unfunded key) and `AUTH_HOME_DOMAIN` for any shared deployment.
9. **Local Docker containers.** The README's `docker-compose.yml` services are running (`oracledesk-backend-postgres-1`, `oracledesk-backend-redis-1`, with a `pgdata` volume). Stop them with `docker compose down` (add `-v` to delete the data).
