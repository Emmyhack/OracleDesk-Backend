# Contributing to the OracleDesk backend

Thanks for helping. This is a testnet-only, unaudited project; see
[docs/STATUS.md](docs/STATUS.md) for what works today.

## Setup

```bash
git clone --recurse-submodules https://github.com/OracleDesk/OracleDesk-Backend.git
cd OracleDesk-Backend
nvm use                      # Node 22 (see .nvmrc)
npm ci
docker compose up -d         # local Postgres (127.0.0.1:5433) and Redis (6379)
cp .env.example .env         # works as-is with the Compose services
npx prisma migrate dev
npm run dev
```

Forgot `--recurse-submodules`? Run `git submodule update --init`.

## Branches and commits

- Branch names: `feat/…`, `fix/…`, `docs/…`, `chore/…`, `test/…`.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. One logical change per
  commit.
- No force-pushes to shared branches.

## Checks (CI runs exactly these)

```bash
npm run check:contracts     # generated contract code matches the submodule
npx prisma migrate deploy   # against a scratch database
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code
npx tsx scripts/audit-constraints.ts --json audit.json
npm run build
npm test
```

With a server running, `scripts/smoke.sh` checks health, wallet login with
a throwaway key, market listing and a live testnet read.

## Database changes

Edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what>`.
Migrations are forward-only: never edit one that has been merged. If a
migration changes data (not just shape), say so in the PR and in a comment
at the top of the SQL.

When adding `CHECK` constraints or foreign keys to existing tables, follow the
`NOT VALID` -> audit -> `VALIDATE` pattern to avoid long-running exclusive locks:
1. Add the constraint or foreign key with `NOT VALID` (only acquires a fast lock).
2. Run `scripts/audit-constraints.ts [--fix]` to detect and repair or quarantine any invalid rows.
3. Validate the constraint in a subsequent migration using `ALTER TABLE ... VALIDATE CONSTRAINT ...` (takes `SHARE UPDATE EXCLUSIVE`, keeping tables available for reads and writes).

### Migration lint

CI (`migrations` job) runs `npm run lint:migrations` against the migrations a
PR adds. Locally, run it after committing so it can diff against the base
(`MIGRATIONS_BASE_REF=upstream/develop npm run lint:migrations`).

- Editing, deleting or renaming a merged migration fails the lint.
- Every new migration must start with `SET lock_timeout = '5s';` so a
  migration blocked by a busy table fails fast instead of queuing queries.
- New migrations are checked with a pinned [squawk](https://squawkhq.com/docs/)
  (lock-heavy changes such as non-concurrent indexes, column type changes,
  drops and renames are rejected).
- To suppress a rule, add an entry to `prisma/migration-allowlist.json` scoped
  to one migration, listing the rules, a `reason` and an `approvedBy` reviewer:
  `{ "migration": "<dir name>", "rules": ["ban-drop-column"], "reason": "...", "approvedBy": "@reviewer" }`.
- Enum values: add with `ALTER TYPE ... ADD VALUE` (the new value cannot be used
  in the same transaction). Removing or renaming values needs expand/contract
  (stop writing the value, migrate rows, recreate the type in a later release)
  and an allowlist entry.

## Chain writes

Anything that signs must go through `src/services/chain.service.ts`, which
routes agent writes through the treasury (so its on-chain caps apply) and
does nothing but simulate unless `CHAIN_EXECUTION_MODE=live`. Never call
`market_core.buy` with the agent key, never add a code path that signs in
`dry-run`, and keep live mode testnet-only.

## When the contracts change

The contracts live in
[OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract)
and are the source of truth. This repo pins them as the `contracts`
submodule and copies the generated code into `src/generated/`.

```bash
git -C contracts fetch origin
git -C contracts checkout <new commit>
npm run sync:contracts
npm run build && npm test   # tests/categories.test.ts fails if the Category enum changed
git add contracts src/generated
```

Never edit `src/generated/` by hand. If an event or entrypoint changed,
update `src/services/indexer.service.ts` / `chain.service.ts` and
`tests/fixtures/events.json`. If you think a contract needs
to change, write it up in [docs/contract-requests.md](docs/contract-requests.md)
and open the issue in the contracts repo.

## Working on a Drips Wave issue

This repo takes part in [Drips Wave](https://docs.drips.network/wave/).
Per the current Drips docs:

1. Find the issue on the Drips Wave **Explore** page (or in this repo's
   issues once a maintainer has added it to a Wave).
2. **Apply** for it on Drips. Don't start coding until a maintainer assigns
   you; the issue isn't yours before that.
3. Open a PR that links the issue (`Closes #123`).
4. Points are earned when the PR is merged and the issue is marked resolved
   **before the Wave ends**. Complexity (Trivial 100 / Medium 150 /
   High 200 points) is set by the maintainer; if an issue turns out harder
   than labelled, say so on the issue before it's resolved.

Drips also limits how many issues one person can be assigned per
organization in a Wave; check the Drips docs for the current numbers.
Issue drafts live in [docs/wave-issues/](docs/wave-issues/) before they're
filed.

## What a good PR includes

- A short description and the issue it closes.
- All checks above passing locally.
- Tests for new behaviour. Anything touching auth, payments or chain writes
  needs a test for the failure cases, not only the happy path (see
  `tests/auth.test.ts` and `tests/payment.test.ts`).
- `docs/api.md` updated in the same PR when a request or response changes
  (it is the contract with the frontend; the frontend keeps a copy).
- On-chain amounts as `bigint` / decimal strings ending in `Raw`, never
  floats.

## Never commit secrets

No `.env` file, no Stellar secret seeds (`S…`), no API keys or JWT secrets,
in code, tests, fixtures or logs. Tests generate throwaway keys with
`Keypair.random()`. New config goes in `.env.example` with an empty value. If you commit a secret by accident, tell a
maintainer privately (see [SECURITY.md](SECURITY.md)) so it can be rotated;
removing it in a later commit is not enough.

## Tests

There are two tiers:

| Command | What runs | Needs |
|---|---|---|
| `npm test` | Unit tests (`tests/*.test.ts`), Prisma and Redis mocked | nothing |
| `npm run test:integration` | `tests/integration/*.int.test.ts` against real Postgres 16 + Redis 7 | Docker, or `TEST_DATABASE_URL` + `TEST_REDIS_URL` |
| `npm run test:all` | both | as above |

Integration tests get services from Testcontainers locally, or from
`TEST_DATABASE_URL` (an admin connection, used for `CREATE DATABASE`) and
`TEST_REDIS_URL` when set, as in CI. A migrated template database is created
once; each test file gets its own clone, and tests truncate all tables in
`beforeEach`. Without Docker or the `TEST_*` URLs, the tier skips with a message.

Writing an integration test:

- Call `await integrationEnv('<label>')` in an async `before()` hook, **then**
  dynamically import `src` modules (`config` and `prisma` read env at import).
- Seed data with the factories in `tests/helpers/factories.ts`.
- Use `withRedisPrefix()` from `tests/helpers/redis.ts` so parallel files don't
  share Redis keys.

## Recording cassettes

The agent-cycle tests (`tests/agents-cycle.test.ts`) run `runMarketMakerCycle()`
and `runTraderCycle()` end to end without a network. Every Anthropic, Gemini,
NewsAPI, FRED and GDELT request goes through a transport seam
(`setAnthropicTransport`, `setGeminiTransport`, `setSignalHttp`) and is served
from a cassette in `tests/cassettes/`. The library is `tests/helpers/cassettes.ts`.

`CASSETTE_MODE` selects the mode:

| Mode | What happens | Where |
|---|---|---|
| `replay` (default) | Requests are matched by fingerprint and answered from the cassette. An unmatched request fails with `CassetteMiss` and a diff against the closest recorded request; an interaction no request used fails the test. | everywhere, the only mode in CI |
| `record` | Requests go to the real providers and the normalised, redacted pairs are written when the test finishes. Needs `CASSETTE_RECORD=1`. | locally |
| `off` | Real providers, nothing written. | locally |

A fingerprint ignores API keys (any `apiKey`/`api_key`/`key`/`authorization`
field), query-parameter order, ISO timestamps, UUIDs and the random nonces of
the untrusted-data blocks. Any other prompt change is a miss on purpose: if you
change a prompt, the signals it sees or the request a data source sends, you
re-record.

**Re-recording one cassette.** You need the keys of the providers the scenario
calls: `ANTHROPIC_API_KEY` (and `GEMINI_API_KEY` for the fallback scenario),
`NEWSAPI_KEY` and `FRED_API_KEY`. GDELT needs none. Export them in your shell
(never in a committed file), then run only the scenario you are recording:

```bash
npm run build:test
CASSETTE_MODE=record CASSETTE_RECORD=1 \
  node --test --test-concurrency=1 --test-name-pattern "market maker: news\+fred" \
  dist-tests/tests/agents-cycle.test.js
```

`--test-name-pattern` takes a regular expression over the test name; the file
must be the compiled `dist-tests/tests/agents-cycle.test.js`. Then run
`npm test` again in replay mode. A scenario whose outcome depends on a specific
provider failure (the Anthropic 529 → Gemini fallback) cannot be produced on
demand by a live provider: author it with scripted responses
(`CASSETTE_UPSTREAM=scripted`, using the scenario's `upstream`), which marks the
file `"synthetic": true`. The committed cassettes are all synthetic for now;
replace them with live recordings when you have keys.

Before a cassette is written, the secret guard scans it for the configured key
values and key-shaped strings (`sk-ant-…`, `AIza…`, 32-hex values in key
fields) and refuses to write it. `tests/cassettes-secrets.test.ts` runs the
same scan over every committed cassette on every `npm test`. NewsAPI article
text is third-party content: the recorder keeps only the six articles the
prompt can show, cuts titles and descriptions to 180 characters and drops the
article body.

**Reviewing a cassette** (author and reviewer):

- No personal data: no names of private individuals, emails, phone numbers or
  wallet addresses other than test ones.
- No secrets: the guard and the scan pass, and you looked anyway.
- Prompts inspected: read the recorded `request.system` / `messages` and make
  sure they are what you meant to send, and that no market price reaches a
  forecaster prompt.
- Responses plausible: the scenario's assertions should follow from the
  recording, not from luck.
- The diff touches only the cassettes of the scenarios you re-recorded.
