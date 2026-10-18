# Backend architecture

The backend is the API, indexer and LLM pipeline around the OracleDesk Soroban contracts. The contracts decide everything that matters for money: prices, positions, caps, resolution. The backend never overrides them.

## Request path

Express 5 with helmet, hpp, an env CORS allowlist, rate limits (global, `/auth/*`, `/markets/generate`), JSON bodies capped at 1 MB, and pino logging with secrets redacted. BigInts serialise as decimal strings through the app's JSON replacer. Every response uses the `{ ok, data, error, meta }` envelope. The full contract with the frontend is [api.md](api.md).

## Correlation ids

`src/lib/context.ts` keeps an `AsyncLocalStorage` context with a `requestId` and, where relevant, a `cycleId` or `jobId`. The first Express middleware assigns it: a well-formed inbound `X-Request-Id` (`[A-Za-z0-9._:-]{8,64}`, only when `TRUST_INBOUND_REQUEST_ID=true`) is kept, anything else is replaced and never logged. The id is echoed in the `X-Request-Id` response header and in `error.requestId`. Each cron tick and indexer poll runs in its own context with a fresh `cycleId`, and `POST /markets/generate` runs the cycle with a `jobId` plus the originating `requestId`. A pino mixin adds these ids to every log line, and `writeAgentLog()` (`src/lib/agent-log.ts`, the only writer of `AgentLog` rows) stores them in `data.correlation`. To follow one request or cycle, search the logs for `requestId=<id>` (or the JSON field).

## Login (SEP-10 style)

`auth.service.ts` builds a challenge transaction with `WebAuth.buildChallengeTx`, signed by `AUTH_SIGNING_SECRET` (a key that holds nothing and is not the agent key). It stores the transaction hash in Redis for 5 minutes. `/auth/verify` reads the challenge, enforces its time bounds without the SDK's grace period, consumes it atomically (`GETDEL`), checks the user's signature with `verifyChallengeTxSigners`, and issues a JWT. Admin rights are an env allowlist of G-addresses checked server-side.

## Chain access

`services/stellar/clients.ts` builds the generated binding clients. Reads are simulations. Writes go through `chain.service.ts`:

- Agent writes go **through the treasury** (`agent_create_market`, `agent_buy`, `agent_sell`) so its per-trade, per-market and daily caps apply on-chain, plus `reasoning_registry.publish_trace`.
- `dry-run` (default) builds and simulates, logs the result and returns it without signing. `live` signs with `AGENT_SECRET_KEY` via `basicNodeSigner`, and config validation refuses `live` off testnet.
- Contract errors are named from the `Error(Contract, #N)` code in the simulation text through each binding's `Errors` table.

The contracts repo's `agents/stellar/adapter.ts` covers similar ground, but its dry-run doesn't simulate and it lacks `agent_sell`, so this service mirrors its method names instead of depending on it. The intended long-term split is that the agents package owns signing and this repo stays the API, indexer and LLM pipeline (see [contract-requests.md](contract-requests.md)).

## Market creation (ADR 0001)

`market-chain.service.ts` turns a generated proposal into an on-chain market:

1. Build a signer-mode resolution spec (`RESOLUTION_SIGNERS`, default the agent).
2. Hash it as `sha256(XDR(ResolutionSpec))` with the resolver binding's own spec (`lib/resolution-spec.ts`). Tests check this against the contracts repo's Rust `spec-hash` tool.
3. Store the full spec and its hash next to the market, so anyone can later reveal it to `resolver.register_signer_spec`.
4. Pin the canonical question JSON; `question_hash` is the sha256 of those exact bytes and `meta_uri` is `ipfs://<cid>`.
5. Call `treasury.agent_create_market`. In live mode the returned id becomes `onChainMarketId` and the market goes `ACTIVE`; in dry-run it stays `PENDING`.

Backend categories are mapped to the contract enum by `toContractCategory()`.

## Reasoning traces

A trace is canonicalised once (sorted keys, same rules as `agents/core/trace.ts`), pinned byte for byte with Pinata's `pinFileToIPFS`, and `trace_hash` is the sha256 of those bytes. It is published to reasoning-registry once its market is on-chain. `POST /traces/verify` re-fetches the bytes by the on-chain CID and compares them with the on-chain hash, like `x402/trace-verification.ts`.

Publication is durable (#131). Each trace that should be on-chain gets a `trace_publications` row holding the exact document, worked by `src/jobs/trace-publication.worker.ts` every `TRACE_PUBLISH_CRON` (default 30 s):

| Status | Meaning |
|---|---|
| `AWAITING_PIN` | Pin the stored payload. A missing Pinata config parks the row for an hour; other pin errors retry. |
| `AWAITING_MARKET` | Wait for `Market.onChainMarketId` (re-checked every 5 min, not counted as an attempt). A `CANCELLED` market fails the row with `MARKET_CANCELLED`. |
| `READY` | Never publish twice: a trace already linked by the indexer, or the same agent + `trace_hash` among the market's 10 newest registry traces (`market_trace_at`), is confirmed without a write. Otherwise `publish_trace` is called once. |
| `SUBMITTED` | Waiting for the indexer. After `TRACE_CONFIRM_TIMEOUT_MS` the submitted trace id is re-read on-chain before any retry, so a landed transaction isn't repeated. |
| `CONFIRMED` | Set by the indexer's `TracePublished` event (matching `trace_hash`) or by the chain checks above. |
| `FAILED` | `AgentNotRegistered` / `EmptyAction` / `EmptyCid`, a voided market, or `TRACE_PUBLISH_MAX_ATTEMPTS` reached. `lastError` says which. |

Transient errors retry with backoff `min(2^attempts × 30 s, 1 h)`. Rows are claimed with `FOR UPDATE SKIP LOCKED` and leased, and chain calls run after the claim commits, so several processes can run the worker. `verified` is set only by indexer confirmation (or the duplicate checks, which read the same on-chain record) and by `POST /traces/verify`; dry-run never confirms a row or sets `verified`. The creation trace is pinned with `onChainMarketId: null` when its market is still pending and is **not** re-pinned later: that would change `trace_hash`; the `market_id` argument of `publish_trace` provides the link. Action strings live in `src/lib/trace-actions.ts`.

## Payments

A daily pass is granted only after `payment-verification.service.ts` reads the transaction with Stellar RPC `getTransaction` and confirms all of the following:

- it succeeded;
- it is a single `transfer` on the USDC contract;
- `from` is the logged-in wallet;
- `to` is `PAYMENTS_RECIPIENT`;
- the amount is at least `DAILY_PASS_PRICE_RAW`.

Each hash is usable once (unique `PaymentEvent.txHash`). There is no development bypass; tests inject a fake RPC reader. Per-trace unlocks are sold by the x402 service in the contracts repo, which the frontend calls directly.

## Resolution

Outcomes are decided on-chain by the resolver contract. The backend only reads `resolver.state` and `market_core.get_market`; the old endpoint that let any user set an outcome is gone. When the indexer sees `MarketResolved`, it updates the database and closes positions.

## Indexer

`indexer.service.ts` polls Stellar RPC `getEvents` for the four contract ids every `INDEXER_POLL_MS`:

- Events are decoded with each binding's spec (`Spec.parseEvent`) and stored in `chain_events` keyed by the RPC event id, so re-reads are idempotent.
- The ledger cursor lives in `indexer_cursors`. If it is older than RPC retention (about 7 days on testnet), the indexer warns and resumes from the oldest retained ledger; anything in between is lost to it.
- New `Trade` and `TracePublished` events are pushed to clients over socket.io as `TRADE_EXECUTED` and `REASONING_PUBLISHED`.

## Health and degraded mode (#111)

`/livez` checks only the process; `/readyz` probes Postgres, Redis, RPC and the indexer lag. `HEALTH_CRITICAL` decides which failures return 503. By default Redis and Postgres are critical (login and every data endpoint need them) and RPC is not: an instance without RPC stays ready and keeps serving database reads, while on-chain state, resolution, trace and payment endpoints return 502. The indexer fails when it is more than `INDEXER_MAX_LAG_LEDGERS` behind or its cursor is older than `INDEXER_MAX_STALENESS_MS`; with no cursor yet it reports `initialising`. On SIGTERM `/readyz` returns 503 `draining` for `SHUTDOWN_DRAIN_MS` before the server stops accepting connections.

## Generated code

`src/generated/` is copied from the pinned `contracts` submodule by `scripts/sync-contracts.mjs`, with a do-not-edit header and `// @ts-nocheck`. CI fails if it's stale.

## LLM router (#157)

All generation goes through `src/lib/llm/router.ts`. Each `LlmTask`
(`market_generation`, `hedge_conditions`, `forecasting`, `attestation`,
`generic_json`, `generic_text`) maps to an ordered list of `ModelSpec`s
(provider, model, temperature, max tokens, timeout, optional base URL). The
default policy reproduces the old Anthropic → Gemini behaviour. Override any
task with `LLM_POLICY` (JSON) or `LLM_POLICY_FILE`; missing tasks keep the
default, and an invalid task/spec fails at boot with a per-task message.

Providers live in `src/lib/llm/providers/` (Anthropic, Gemini,
OpenAI-compatible). They normalise SDK errors into `LlmError.kind`
(`rate_limited`, `quota_exhausted`, `auth`, `invalid_request`, `timeout`,
`server`, `content_filtered`, `empty`, `parse`). The router:

- skips providers with no key (without counting a failure);
- retries inline only when `retryAfterMs <= 5s`; longer waits cool the
  provider down and fail over;
- opens a 1-hour circuit on quota exhaustion;
- cools a provider for 60s after 3 server/timeout failures;
- fails over on auth/invalid-request/empty/parse;
- parses JSON in the router, so an invalid response tries the next model;
- returns provenance (`provider`, `model`, `attempts`, `latencyMs`, `usage`)
  for agent logs and trace payloads (`llm: { provider, model } | null`).

Text mode never sets a JSON response format; only `mode: "json"` does.

## IPFS content store (#100)

`pinJson()` writes the exact pinned bytes to `ipfs_content` (Postgres
`bytea`) after the pin succeeds; a store failure is logged and does not fail
the pin. `fetchVerifiedBytes(cid, expectedSha256, verifiedBy)`:

1. reads the local row and re-hashes its bytes;
2. returns it only when both the stored hash and the freshly computed hash
   equal the expected hash (on-chain or pin hash);
3. otherwise consults the gateway, stores bytes only after they verify, and
   returns unverified bytes without caching so callers can report a mismatch.

sha256 is the admission criterion; the CID is only a lookup key. A CID can
never map to two hashes (`IPFS_CID_HASH_CONFLICT`). Objects above
`IPFS_CACHE_MAX_OBJECT_BYTES` are not stored. An hourly job evicts
`GATEWAY_VERIFIED` rows by least-recent access, then 30-day-old `PINNED` rows,
never touching content referenced by an unpublished trace or a `PENDING`
market (one SQL `NOT EXISTS` query, batches of 500).

## Transparency reports (#159)

`src/services/transparency-report.service.ts` builds a deterministic
`oracledesk.transparency-report` v1 document from chain reads and
`chain_events` only (no DB floats). Amounts are base-unit decimal strings.
The daily job pins the canonical bytes, publishes the hash through the
reasoning registry under the sentinel `u64::MAX` market id with action
`report`, and persists the index row. A crash after pin re-publishes the
stored bytes rather than recomputing. See `docs/transparency-reports.md`.

## Database Invariants & Schema Hardening

The Postgres database enforces key invariants at the storage layer via Postgres enums and `CHECK` constraints:
- **Enums**: `PaymentEventType` (`DAILY_PASS`, `PER_TRACE`, `REFUND`), `PaymentEventStatus` (`PENDING`, `CONFIRMED`, `FAILED`, `REFUNDED`), `GenerationJobStatus` (`PROCESSING`, `COMPLETED`, `FAILED`), and `SettlementCurrency` (`USDC`).
- **Probabilities**: `Market.initialYesProb`, `Market.currentYesProb`, `ReasoningTrace.probabilityEstimate`, `ReasoningTrace.marketProbability`, `Position.entryPrice`, and `Position.currentPrice` are constrained to `[0, 1]`.
- **Confidence intervals**: `confidenceInterval` JSON is constrained to object shape `{ "lower": number, "upper": number }` with `lower <= upper`.
- **Hashes and IDs**: 64-character lowercase hex strings (`^[0-9a-f]{64}$`) for transaction hashes, question hashes, resolution hashes, and trace hashes. On-chain IDs (`onChainMarketId`, `onChainTraceId`) must be non-negative.
- **Amounts**: Base-unit decimal strings ending in `Raw` (`seedAmountRaw`, `amountRaw`) must consist solely of digits. Numeric amounts (`Trade.amount`, `CopyTrade.amount`, `Subscription.amountPaid`, `SpendingAllowance` limits) must be non-negative.
- **Foreign keys and cascading**: `PaymentEvent.traceId` and `Position.hedgeMarketId` reference their targets with `ON DELETE SET NULL`. Audit history (`copy_trades` -> `market`, `copy_trades` -> `trace`) is protected using `ON DELETE RESTRICT` so market deletion cannot silently erase copy-trade records.
- **Constraint migrations**: Implemented using the `NOT VALID` -> repair -> `VALIDATE` pattern, with `scripts/audit-constraints.ts` providing pre-migration and CI verification.

## Resilience, Bulkheads, and Cancellation

External dependencies (Stellar RPC, Pinata IPFS, Gemini LLM, GDELT, and FRED) are wrapped with:
- **Bulkheads**: Per-dependency concurrency and queue capacity limits via `Bulkhead` in `src/lib/resilience.ts` to prevent pool exhaustion and cascading failures.
- **Timeouts & Deadlines**: Explicit per-call timeouts (`withTimeout`) and end-to-end deadlines for multi-step agent cycles (`market-maker`, `trader`).
- **Signal propagation**: Express request aborts (`req.signal`) propagate down to external network calls.
- **Graceful shutdown**: `src/lib/shutdown.ts` coordinates teardown across HTTP, database, Redis, and background cron loops.

## Reasoning Trace Auditing

Reasoning traces are audited and verified against the on-chain registry (`reasoning_registry`):
- `trace-audit.service.ts` periodically audits published and pending traces, classifying them as `VERIFIED_ON_CHAIN`, `UNLINKED_IN_DB`, `CONTENT_HASH_MISMATCH`, `MISSING_ON_CHAIN`, or `ARCHIVED_ON_CHAIN`.
- Live published traces start unverified (`verified: false`) until independently verified by the auditor or verified explicitly via `POST /traces/verify`.
- Admin endpoints (`/admin/trace-audits`) allow triggering on-demand audits and inspecting audit histories.

## Copy-Trade On-Chain Verification

Copy trades are verified against on-chain transaction metadata:
- Copy trade requests are tracked through states (`PENDING`, `CONFIRMING`, `CONFIRMED`, `FAILED`, `EXPIRED`).
- When a user submits an on-chain transaction hash (`POST /trade/copy/:id/confirm`), `copy-trade.service.ts` inspects the transaction status, envelope, and contract events (`CONTRACTS.marketCore` `Trade` event in `resultMetaXdr`) to verify market ID, trader wallet, outcome, direction (`is_buy`), and collateral amount.
- Pending transactions return `202 CONFIRMING` and are swept by the indexer projection and a background cron job.


## Secrets (#145)

`src/config/secrets.ts` is the only runtime source of secret values.

- `SECRETS_PROVIDER=env` (default) reads the environment; `file` reads
  `<NAME>_FILE` mounts and re-reads them on refresh; `vault` reads a Vault KV v2
  path using a token file. AWS Secrets Manager can be added through the same
  `SecretsProvider` interface.
- Boot resolves files in `loadConfig`, then `initSecrets` validates and stores
  raw values as Buffers. Empty or invalid refresh values keep the previous
  value; a provider failure keeps everything.
- JWT rotation keeps the previous key for
  `JWT_PREVIOUS_SECRET_GRACE_SECS` (default 24h), then zeroes it. Expired tokens
  are never retried against the previous key.
- SDK clients (Gemini, Anthropic) rebuild when the key version changes.
  Values already copied into an SDK are immutable strings; zeroing the store
  only guarantees the long-lived copy is gone.
- `AGENT_SECRET_KEY` is deliberately not in the runtime secret store: rotating
  the agent identity is an on-chain registration change, so it stays env-only
  and requires a restart. `DATABASE_URL` must be available at boot (env or
  `DATABASE_URL_FILE`); rotating it through Vault would not rebuild Prisma.

## Seed and snapshots (#147)

`npm run db:seed` builds a deterministic dataset through `src/seed/scenario.ts`.
Every question/trace hash is computed with the production helpers and the exact
bytes are written under `.ipfs-local/` (CIDv1 raw/sha2-256). It refuses
production, live-chain mode and non-local databases unless
`SEED_ALLOW_REMOTE=1`.

`npm run snapshot:export -- --out <dir>` streams anonymised NDJSON. The column
map is fail-closed: a new column without an anonymisation rule stops the export.
Hashed identifiers use `SNAPSHOT_SALT`; Stellar addresses are mapped to
deterministic throwaway G-addresses.

## Backups (#146)

Custom-format dumps plus a manifest (migrations, cursor, max ledger, counts)
and checksums. Restore then replays the chain gap with
`scripts/post-restore-reconcile.ts`; see the runbook.
