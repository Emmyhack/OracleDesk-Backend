# Backend architecture

The backend is the API, indexer and LLM pipeline around the OracleDesk Soroban contracts. The contracts decide everything that matters for money: prices, positions, caps, resolution. The backend never overrides them.

## Request path

Express 5 with helmet, hpp, an env CORS allowlist, rate limits (global, `/auth/*`, `/markets/generate`), JSON bodies capped at 1 MB, and pino logging with secrets redacted. BigInts serialise as decimal strings through the app's JSON replacer. Every response uses the `{ ok, data, error, meta }` envelope. The full contract with the frontend is [api.md](api.md).

## Correlation ids

`src/lib/context.ts` keeps an `AsyncLocalStorage` context with a `requestId` and, where relevant, a `cycleId` or `jobId`. The first Express middleware assigns it: a well-formed inbound `X-Request-Id` (`[A-Za-z0-9._:-]{8,64}`, only when `TRUST_INBOUND_REQUEST_ID=true`) is kept, anything else is replaced and never logged. The id is echoed in the `X-Request-Id` response header and in `error.requestId`. Each cron tick and indexer poll runs in its own context with a fresh `cycleId`, and `POST /markets/generate` runs the cycle with a `jobId` plus the originating `requestId`. A pino mixin adds these ids to every log line, and `writeAgentLog()` (`src/lib/agent-log.ts`, the only writer of `AgentLog` rows) stores them in `data.correlation`. To follow one request or cycle, search the logs for `requestId=<id>` (or the JSON field).

## Login (SEP-10 style)

`auth.service.ts` builds a challenge transaction with `WebAuth.buildChallengeTx`, signed by `AUTH_SIGNING_SECRET` (a key that holds nothing and is not the agent key). It stores the transaction hash in Redis for 5 minutes. `/auth/verify` reads the challenge, enforces its time bounds without the SDK's grace period, consumes it atomically (`GETDEL`), checks the user's signature with `verifyChallengeTxSigners`, and issues a JWT. Admin rights are an env allowlist of G-addresses checked server-side.

Three hardening layers sit around this (#48, #50). Every stored challenge names its issuing key; verification looks that key up in the current `AUTH_SIGNING_SECRET` plus `AUTH_PREVIOUS_SIGNING_KEYS`, so a signing key can rotate with an overlap and a retired key stops being accepted (an unknown or retired issuer is `INVALID_CHALLENGE`, and the record is still consumed). Issuance is bounded per address and per hashed client IP by a single Lua script (`redis-scripts.ts`) that prunes expired entries and evicts the oldest, and above `AUTH_POW_THRESHOLD_PER_MIN` per minute clients must present a hashcash-style proof of work over a single-use salt. Keys live in one Redis Cluster slot under the `auth:{auth}:` hash tag — `challenge:<hash>`, `outstanding:addr:<address>`, `outstanding:ip:<sha256>`, `issued:<minute>`, `pow:<salt>` — and every one carries a TTL. All of this is fail-closed: with Redis down, `checkRedisPolicy()` at boot logs the degraded state and challenge issuance/verification returns `503 AUTH_UNAVAILABLE` rather than accepting an unverifiable challenge.

## Login for contract accounts (SEP-45, #47)

`sep45.service.ts` serves `C…` (smart-wallet) accounts. `GET /auth/contract/challenge` builds two `web_auth_verify` authorization entries with a shared argument map and a random single-use nonce, signs the server entry with `authorizeEntry`, stores the nonce, and returns the pair as base64 XDR. `POST /auth/contract/verify` re-decodes the pair, checks the arguments and the server's ed25519 signature, spends the nonce with `GETDEL`, checks expirations, then simulates the invocation in `enforce` auth mode; only a successful simulation issues a JWT tagged `accountType: "contract"`, which is rejected by the admin check. Disabled unless `SEP45_ENABLED=true` and `WEB_AUTH_CONTRACT_ID` is set.

## Chain access

`services/stellar/clients.ts` builds the generated binding clients. Reads are simulations. Writes go through `chain.service.ts`:

- Agent writes go **through the treasury** (`agent_create_market`, `agent_buy`, `agent_sell`) so its per-trade, per-market and daily caps apply on-chain, plus `reasoning_registry.publish_trace`.
- `dry-run` (default) builds and simulates, logs the result and returns it without signing. `live` signs with `AGENT_SECRET_KEY` via `basicNodeSigner`, and config validation refuses `live` off testnet.
- Contract errors are named from the `Error(Contract, #N)` code in the simulation text through each binding's `Errors` table.

The contracts repo's `agents/stellar/adapter.ts` covers similar ground, but its dry-run doesn't simulate and it lacks `agent_sell`, so this service mirrors its method names instead of depending on it. The intended long-term split is that the agents package owns signing and this repo stays the API, indexer and LLM pipeline (see [contract-requests.md](contract-requests.md)).

### Sequence numbers (#36)

Every Stellar transaction consumes one sequence number of its source account. Several paths write with the same agent account (the market-maker cron, the trader cron's fire-and-forget trace publication, and the admin `POST /markets/generate`), and every backend instance runs its own crons. Two builds that read the same RPC account produce two transactions with the same sequence and only one can land.

`services/stellar/sequence.ts` serialises live writes per source account:

- `withSourceAccount(account, fn)` takes a **fair** lock: waiters take a monotonic ticket from `lock:src:<net>:<account>:fence` and only the head of the `<lock>:queue` sorted set may take the lock, so one busy cron cannot starve an admin call. The lock itself is a single `SET NX PX` (`SEQ_LOCK_TTL_MS`, renewed by a heartbeat every `SEQ_LOCK_HEARTBEAT_MS`), released by a compare-and-delete Lua script, so a crashed holder cannot block the queue for longer than its TTL. A waiter that exceeds `SEQ_LOCK_WAIT_MS` fails with a retryable `SEQUENCE_LOCK_TIMEOUT` instead of hanging.
- The **fencing token** (the ticket) is written next to the cached sequence (`seq:<net>:<account>`, `seq:<net>:<account>:fence`) by an atomic Lua script that refuses to move the sequence backwards, so a holder that lost its lock can never corrupt the counter. Before `sendTransaction`, the caller calls `ctx.assertHeld()`; a stale holder aborts without submitting.
- The cached sequence is initialised from `rpc.getAccount` at startup and after a `txBadSeq` rejection, and advanced by exactly one only when the network **accepted** the envelope. A rejected submission never advances it. A timed-out submission re-syncs before the next build.
- Dry-run takes no lock and never touches the sequence cache. Simulation does not consume a sequence. Redis being unavailable makes a live write fail closed (`SEQUENCE_LOCK_UNAVAILABLE`), never submit unlocked.
- The binding clients build through `rpc.getAccount` themselves, so the allocated sequence cannot be handed to them directly. After simulation, `rebuildWithSequence` rewrites the built transaction with `TransactionBuilder.cloneFrom` (replacing the source account and re-applying the Soroban data), which is a clean seam that does not edit `src/generated`. Auth entries are unaffected because the agent uses source-account credentials.

The lock covers one attempt, from sequence allocation until `sendTransaction` returns; confirmation polling happens after release, which is safe because the sequence is already reserved.

### Write failure classification and retry (#40)

A live write failure is classified from the actual Stellar result codes (`services/stellar/failures.ts`) into one of `TRANSIENT_RPC`, `BAD_SEQUENCE`, `INSUFFICIENT_FEE`, `EXPIRED`, `RESOURCE_OR_STATE`, `CONTRACT_ERROR`, `AUTH`, `INSUFFICIENT_BALANCE`, `UNKNOWN_OUTCOME` or `UNKNOWN`. Only the first five are retried, and only when the envelope is provably *not* applied:

- `TRANSIENT_RPC` (e.g. `TRY_AGAIN_LATER`, a connection error before send) rebuilds.
- `BAD_SEQUENCE` re-syncs the cached sequence and rebuilds.
- `INSUFFICIENT_FEE`, `EXPIRED` and `RESOURCE_OR_STATE` rebuild, because the previous envelope was rejected, not applied.
- `CONTRACT_ERROR`, `AUTH`, `INSUFFICIENT_BALANCE` and `UNKNOWN` are permanent and never retried.
- `UNKNOWN_OUTCOME` (a send timeout, a `DUPLICATE`, a `NOT_FOUND` poll) is ambiguous: the transaction may have been applied. It is **never** re-submitted with a rebuilt transaction; the cached sequence is re-synced and the failure surfaces as a `TransactionError` with `submitted: true`.

Backoff is jittered exponential, `min(CHAIN_RETRY_MAX_MS, CHAIN_RETRY_BASE_MS × 2^attempt) × U(0.5, 1)`, capped by `CHAIN_RETRY_MAX_ATTEMPTS` attempts and `CHAIN_RETRY_DEADLINE_MS` total. Trade execution re-quotes `min_shares_out` on each rebuild so a retry never reuses a bound a moved price has invalidated, and it marks a `PENDING` trade `FAILED` only for a permanent classification — transient or ambiguous failures stay retryable. The market-maker's on-chain creation likewise leaves a market `PENDING` rather than failed.

### Transactional outbox (#35)

A live chain write is not atomic with anything the backend does around it: the process can die between signing and sending, or after the network accepted the envelope, and the caller would then record the wrong outcome (a market stuck `PENDING` after the treasury spent the seed, a `FAILED` trade whose shares the treasury holds). Every live write therefore persists a `chain_transactions` row and moves it through an explicit state machine with compare-and-set transitions:

```
BUILT ──→ SIGNED ──→ SUBMITTED ──→ PENDING ──→ SUCCESS
   │          │           │            │   └──→ FAILED
   │          │           │            └──────→ EXPIRED
   └──────────┴───────────┴── (crash) ──→ resolved by the recovery worker
```

- `BUILT`: built and simulated; `kind`, `refId`, `args` and the simulated value are durable.
- `SIGNED`: the signed envelope, hash, sequence and timebounds are in the database **before** `sendTransaction`. A write whose built transaction has no `maxTime` is refused: past the RPC retention window (~7 days on testnet), timebounds are the only way left to resolve a row.
- `SUBMITTED`: the network has the envelope (`PENDING` and `DUPLICATE` send results both count; `ERROR` is terminal `FAILED`, e.g. `txBadSeq` can never land; `TRY_AGAIN_LATER` throws retryable without consuming the row's hash).
- `PENDING`: the inline wait (`OUTBOX_INLINE_WAIT_MS`) expired; the write returned a `CHAIN_PENDING` error carrying the outbox id and hash, the caller recorded an intermediate state (the Trade stays `PENDING`, never `FAILED`), and the recovery worker owns resolution.
- Terminal states record `landedHash`, `ledger` and the decoded `returnValue`.

The recovery worker (`startOutboxWorker`) runs one pass at boot — before the indexer and crons issue new writes — then every `OUTBOX_POLL_MS`, under a best-effort Redis lock (`outbox:recover`) so one instance recovers at a time (transitions are compare-and-set, so a second recoverer cannot double-apply either way). A pass resolves every non-terminal row by polling `getTransaction` over all known hashes: landed rows transition and run their completion handler; `NOT_FOUND` past `maxTime` becomes `EXPIRED`; a `SIGNED` row older than 30 s (crash between sign and send) is resubmitted **byte-for-byte** from the stored envelope — safe because the hash and sequence are fixed, so at most one copy can execute; a `BUILT` row older than the grace was never signed and fails. Terminal rows whose handler never ran (crash in between) are swept too. The indexer short-circuits all of this: a stored event whose `txHash` matches a non-terminal row triggers recovery immediately.

Completion handlers, registered per `kind` in the owning service, are the **single writers** of write success state and must be idempotent: `market.create` links the landed market id (`linkLandedMarket`, never overwriting a different existing link), `trade.buy` marks the Trade `EXECUTED` and creates the Position (guarded on `PENDING`; `Position.tradeId` is unique), `trade.sell` applies the exit only while it is still `SUBMITTED`, and `trace.publish` links `onChainTraceId` when still null. The inline path runs the `SUCCESS` handler before `write()` resolves, so callers read their success state back instead of writing it; failures thrown to a live caller are marked handled (the caller's error path — e.g. #40 classification or the #42 expiry rebuild — stands in for the handler), so worker-driven failure handlers only fire for rows no caller was around to see. Attempt retries under #40 build a fresh envelope and a fresh row; the superseded row is terminal `FAILED`, so recovery can never resubmit an envelope the retry replaced.

### Fee bumps (#38)
A transaction whose inclusion fee is below the surge price is not rebuilt: a rebuilt transaction is a new hash with a new sequence that can execute alongside the original, which would double-execute a treasury trade. Instead the stored inner envelope is wrapped unchanged in a `FeeBumpTransaction` (`services/stellar/fee-bump.ts`) paid by `FEE_PAYER_SECRET`, so at most one envelope can ever land.

The outer fee is `resourceFee + inclusionPerOp × (operations + 1)` — the `+1` accounts for the fee-bump operation — where `inclusionPerOp = max(prev × FEE_BUMP_MULTIPLIER, p90 surge price, innerInclusion + 1)` and `resourceFee` is read from the inner `sorobanData.resourceFee()`. It is refused with `FEE_BUMP_CAP_EXCEEDED` above `FEE_BUMP_MAX_STROOPS`. The SDK builder only computes `baseFee × (operations + 1)`, so the total is set explicitly after asserting the builder's base-fee semantics, then the outer transaction is signed by the fee payer (the inner signatures are never touched).

Both hashes are tracked: the inner `hash` is the outbox identity and dedup key, and every build appends its outer hash to `feeBumpHashes` before submission. Recovery (`services/stellar/outbox.ts`) polls `[hash, ...feeBumpHashes]`; whichever lands first resolves the row and sets `landedHash`. If the inner lands first, an outstanding bump is automatically invalid (`txFeeBumpInnerFailed`/`txBadSeq`) and its error is ignored after a re-poll. Domain rows store the landed hash in `txHash`/`creationTxHash`/`publishTxHash` and the inner hash in the matching `*InnerTxHash` column, and the indexer resolves an event's outer hash back to the inner hash through the outbox. Rows are only bumped while pending past `FEE_BUMP_AFTER_LEDGERS`, under `FEE_BUMP_MAX_ATTEMPTS`, and never within one ledger of the inner `maxTime` (a bump cannot extend timebounds). A fee bump cannot change `resourceFee`, so a resource/state failure stops bumping rather than escalating.



### Dynamic inclusion fees and resource budgets (#39)

Stellar Soroban fees follow a two-part model:
1. **Inclusion fee**: Classic Stellar transaction bid that prioritises the transaction in the ledger queue. The fee oracle (`src/services/stellar/fees.ts`) queries RPC `getFeeStats` with single-flight caching, selects the configured percentile for the operation class (`market_create`, `trade`, `trace_publish`, `maintenance`), and clamps it between the class `floor` and `cap`. If stats are missing, stale, or RPC fails, it falls back to the last good stats within `FEE_STATS_MAX_AGE_MS` or to the class floor.
2. **Resource fee**: Soroban execution and storage fee computed during simulation (`tx.simulation.minResourceFee`). The transaction envelope's built fee equals `inclusionFee + minResourceFee`.

**Operation Class Policies and Budgets**:
- `market_create`: percentile `p90`, floor 0.01 XLM (100,000 stroops), cap 0.5 XLM (5,000,000 stroops), resource budget 5 XLM (50,000,000 stroops).
- `trade`: percentile `p80`, floor 0.001 XLM (10,000 stroops), cap 0.2 XLM (2,000,000 stroops), resource budget 2.5 XLM (25,000,000 stroops).
- `trace_publish`: percentile `p50`, floor 0.001 XLM (10,000 stroops), cap 0.1 XLM (1,000,000 stroops), resource budget 1.5 XLM (15,000,000 stroops).
- `maintenance`: percentile `p50`, floor 0.001 XLM (10,000 stroops), cap 0.1 XLM (1,000,000 stroops), resource budget 1.5 XLM (15,000,000 stroops).

Overrides can be provided at boot via `FEE_POLICY_JSON`.

**Budget Enforcement and Calibration**:
Before any live transaction is signed, `minResourceFee` is checked against the class budget. If it exceeds the budget, execution halts immediately with `FEE_BUDGET_EXCEEDED` (carrying simulation details and no secrets). In dry-run mode, the breach is logged as a warning and simulation continues.
To calibrate budgets for production:
1. Run cycles in dry-run mode (`CHAIN_EXECUTION_MODE=dry-run`).
2. Search application logs for `dry-run: simulated, not submitted` and inspect the recorded `simulated.fee` and `minResourceFee` across operation classes.
3. Set each class budget in `FEE_POLICY_JSON` to ~1.3x–1.5x the observed peak simulation fee to accommodate ledger state growth and contract rent variations without risking unbounded agent spend.
Confirmed transactions record fee accounting in `chain_fees`, exposed via `GET /admin/fees` with daily p50/p95 charged quantiles and oracle health snapshots.

### Transaction lifetime (#42)

Every transaction built by `chain.service.ts` carries explicit timebounds (`minTime = 0`, `maxTime = submissionTime + timeoutInSeconds`) passed through generated binding options (`MethodOptions.timeoutInSeconds`).

**Per-class Timeouts**:
- `market_create`: `TIMEOUT_MARKET_CREATE_SECONDS` (default: 60 s, range: 15–300 s)
- `trade`: `TIMEOUT_TRADE_SECONDS` (default: 30 s, range: 10–120 s)
- `trace_publish`: `TIMEOUT_TRACE_PUBLISH_SECONDS` (default: 45 s, range: 10–180 s)
- `maintenance`: `TIMEOUT_MAINTENANCE_SECONDS` (default: 30 s, range: 10–120 s)

**Auth Entry Expiration**:
`authExpirationLedger` is derived strictly from the transaction deadline: `latestLedger + ceil(timeoutInSeconds / 5) + AUTH_EXPIRY_MARGIN_LEDGERS` (default margin: 12 ledgers). An auth entry never expires before its enclosing transaction, nor outlives it by more than the margin.

**Explicit Polling and Expiry Determination**:
Instead of relying on SDK internal polling, `chain.service.ts` submits the transaction via `sendTransaction` and polls `getTransaction` every 2 seconds. The pure function `decideExpiry()` decides the state using Stellar ledger close time from the RPC response (never the local host clock):
- `LANDED`: RPC status `SUCCESS`. Returns unwrapped execution value.
- `FAILED`: RPC status `FAILED`. Throws typed `ChainError`.
- `EXPIRED`: RPC status `NOT_FOUND`, latest ledger close time is strictly past `maxTime + skew` (skew: 10 s), and the submission is within the RPC retention window. Throws `ExpiredError` (code `CHAIN_TX_EXPIRED`) carrying `attemptId` and `txHash`.
- `UNKNOWN`: RPC status `NOT_FOUND` where submission is older than the RPC retention window (`oldestLedgerCloseTime`). Non-inclusion cannot be proven. Throws `ChainError` with code `CHAIN_TX_UNKNOWN`, preserving the transaction hash.
- `PENDING`: Transaction not yet included, but ledger time has not definitively passed `maxTime + skew`. If the poll loop reaches its local cap while still `PENDING` or `UNKNOWN`, it reports an ambiguous timeout (`CHAIN_SUBMISSION_TIMEOUT`) preserving `txHash`, never a failure or expiry.

All submissions are tracked in `chain_submissions` (`tx_hash`, `op_class`, `min_time`, `max_time`, `auth_expiration_ledger`, `submitted_ledger`, `submitted_at_close_time`, `decision`, `rebuild_count`, `attempt_id`).

**Safe Rebuild Rules**:
- **Trades**: An expired trade catches `ExpiredError`. If `rebuildCount < MAX_REBUILD_COUNT`, the caller re-runs `quoteBuy` to obtain the fresh on-chain price and verifies that the edge still exceeds `MIN_EDGE_THRESHOLD` (8%). If edge degraded, the trade cancels with `INSUFFICIENT_EDGE`. If edge still holds, it resubmits with incremented `rebuildCount`, linking the old attempt.
- **Trace Publication**: Trace publication is idempotent by `trace_hash`. On `ExpiredError`, it links the previous attempt and marks the queue row `READY` for immediate resubmission.
- **Market Creation**: Rebuilds only after a definitive `EXPIRED` decision, and never after `UNKNOWN`.

### Channel accounts (#37)

To allow concurrent writes by autonomous agent workers without sequence collisions, the backend maintains a pool of channel accounts (`src/services/stellar/channels.ts`):

- **Lease Coordination**: Channel accounts are leased across processes using Redis exclusive keys (`channel:lease:<public_key>`, `SET NX PX` with a Lua compare-and-delete release). Round-robin acquisition with jittered backoff distributes load.
- **Signer Composition**: A leased channel serves as the transaction source account (signing the outer transaction envelope with `basicNodeSigner(channelKeypair)`). Privileged contract invocations require invocation authentication signed by the agent key (`AGENT_SECRET_KEY`).
- **Simulated Auth Verification**: Before signing, auth entries from simulation are decoded: `needsNonInvokerSigningBy()` must return strictly the agent's public key (or empty); credentials must be address credentials for the agent; and the root invocation must match the expected method without unexpected sub-invocations.
- **Expiration and Re-simulation**: Auth entries are signed with an expiration ledger derived from the transaction deadline (`authExpirationLedger` from #42). The transaction is re-simulated after signing auth entries to account for signature verification footprint before the channel signs the envelope.
- **Lease Retention**: The channel account remains leased until the transaction leaves `PENDING` (confirming `LANDED`, `FAILED`, `EXPIRED`, or `UNKNOWN`), preventing sequence skew from lagging RPC nodes.
- **Balance Monitoring**: A periodic background monitor inspects on-chain XLM balances via RPC, automatically removing channels below `CHANNEL_MIN_BALANCE_XLM` (default: 5 XLM) from rotation and emitting warnings with public keys only.
- **Dry-run and Fallback**: In `dry-run` or when no channels are configured (`CHANNEL_SECRET_KEYS` empty), `write()` uses the agent account as source and skips leasing completely.

## Market creation (ADR 0001)

`market-chain.service.ts` turns a generated proposal into an on-chain market:

1. Build a signer-mode resolution spec (`RESOLUTION_SIGNERS`, default the agent).
2. Hash it as `sha256(XDR(ResolutionSpec))` with the resolver binding's own spec (`lib/resolution-spec.ts`). Tests check this against the contracts repo's Rust `spec-hash` tool.
3. Store the full spec and its hash next to the market, so anyone can later reveal it to `resolver.register_signer_spec`.
4. Pin the canonical question JSON; `question_hash` is the sha256 of those exact bytes and `meta_uri` is `ipfs://<cid>`.
5. Call `treasury.agent_create_market`. In live mode the returned id becomes `onChainMarketId` and the market goes `ACTIVE`; in dry-run it stays `PENDING`.

### Idempotent market creation across ambiguous outcomes (#41)

Because market creation locks treasury capital (`seed_amount`), duplicate creations spend capital twice. `market-chain.service.ts` wraps creation in an idempotent protocol:

1. **Question Document Hash Invariant**: The question document pinned to IPFS embeds `backendMarketId: market.id`. If a proposal already has a stored `questionHash`, re-pinning must produce the exact same sha256 hash or creation aborts (`QUESTION_HASH_MISMATCH`).
2. **Atomic Claim & Fencing**: An attempt record is created in `market_creation_attempts` with `INSERT ... ON CONFLICT DO NOTHING` followed by `SELECT ... FOR UPDATE`. Stale or retried attempts increment the `attempts` counter with a fencing check, preventing split-brain execution across slow or resumed workers.
3. **Discovery Before Submission**: Before calling the treasury, the backend checks if the market already exists on-chain:
   - Queries RPC `getTransaction` if a `txHash` is stored on the attempt.
   - Searches indexed `MarketCreated` events in `chain_events` matching `question_hash` where `creator` is the treasury contract.
   - Executes a bounded backwards scan of on-chain markets (`marketCount` downwards up to 50 markets).
   Every candidate is confirmed by reading `get_market` and validating that `question_hash`, `resolution_hash`, and `creator === treasury` match. If found, it links immediately without submitting.
4. **Pre-Submission Count**: Before submitting, the current on-chain `market_count` is recorded with the attempt.
5. **Handling Ambiguous Outcomes**: Any error after `sendTransaction` marks the attempt as `UNKNOWN`, records `txHash`, and immediately triggers discovery. A retry is permitted only when `decideExpiry` returns `EXPIRED`.
6. **Atomic Linking**: Linking updates both `markets` (`onChainMarketId`, `status: ACTIVE`) and `market_creation_attempts` (`status: LANDED`) in one transaction. A unique constraint violation on `onChainMarketId` logs `CREATION_ID_CONFLICT` and never overwrites existing markets.
7. **Periodic Reconciliation**: A sweep in the ingestion cron periodically inspects unresolved attempts (`UNKNOWN` or `EXPIRED`) and links any landed markets.

Backend categories are mapped to the contract enum by `toContractCategory()`.

### Price-mode markets (#90)

A `CRYPTO` proposal that names a registered asset can commit to a Reflector
(SEP-40) price feed instead of a signer set. This needs no human: after close,
`resolver.resolve_price` reads the feed at `close_time`, compares it to the
threshold and finalises market-core directly.

- **Feed registry**: addresses are configuration, never hard-coded. They come
  from `REFLECTOR_FEEDS_JSON` (keyed by network passphrase → symbol → feed),
  validated in `config/index.ts`. Every entry carries a `source` citation. An
  empty registry disables price mode, so every CRYPTO market falls back to
  signer mode.
- **Structured proposals**: the generation schema carries optional
  `price_asset`/`price_threshold`/`price_direction`/`price_close_timestamp`
  fields. `planPriceMarket()` parses them and, on any problem (parse,
  unregistered asset, dead feed, or more fractional digits than `decimals()`),
  logs `PRICE_SPEC_FALLBACK` and returns null so creation keeps the signer spec.
- **Exact threshold**: `toFixedPoint(human, decimals)` uses string arithmetic
  (never `parseFloat`) and rejects excess precision rather than rounding, since
  a wrongly-scaled threshold silently flips outcomes.
- **Deterministic text**: `renderPriceQuestion()` renders the question from the
  structured fields, and that rendering replaces the LLM text for price markets,
  so the human question and the committed spec cannot disagree. The pinned
  question document gains a `priceResolution` block with the raw threshold,
  decimals and direction.
- **Pre-creation checks**: `checkFeed()` asserts the feed supports the asset and
  that `lastprice` exists and is younger than `maxStaleness` — a dead feed today
  is dead at close.
- **Reveal**: right after a live creation `register_price_spec` commits the
  spec; `MarketAlreadyConfigured` counts as success. Failures are retried by the
  5-minute cron, which reveals any price market the resolver still reports
  `Unconfigured`.
- **Resolution**: the same cron calls `resolve_price` for closed price markets.
  `MarketNotClosed` retries (ledger time may lag). `PriceUnavailable` and
  `StalePrice` retry with exponential backoff up to
  `PRICE_RESOLUTION_MAX_WAIT_SECS`, then log an `ERROR`
  `PRICE_RESOLUTION_STUCK` so a guardian can decide on `guardian_void_market`.
  `AlreadyFinalized` ends the loop quietly. Resolution always uses the stored
  spec, never the current registry, so changing feeds never affects existing
  markets.

`validateResolutionSpec()` requires `maxStaleness > 0` (matching the contract's
`InvalidConfig`), and, only at reveal time, rejects a negative threshold; the
spec-hash fixtures still hash unchanged.

### Resolvability and the timing rule (#74)

The resolver is strict about time: `attest` is rejected before
`market.close_time`, and `finalize_signers` only succeeds after
`proposed_at + dispute_window`. Before a proposal is persisted or pinned,
`resolvability.service.ts` (pure, no I/O) checks that its text, close time and
source fit that timeline:

```
event deadline ──► source publishes ──► close_time ──► attestation ──► dispute window ──► finalise
                   (+ publication lag)   [lag, lag+6h]   (≤ 48 h SLA)    (RESOLUTION_DISPUTE_WINDOW_SECS)
```

- `earliestClose = deadline + lag`; `latestClose = earliestClose + 6 h` (bounds trading after the answer is public).
- `close + dispute window + 48 h` must be within 120 days of now.
- The deadline comes from a table-driven grammar (`by`, `on`, `before`, `for <month>`, `in Q3`, `end of …`, `at its <month> meeting`); "by X" is end of day X in the source's time zone (built as local 23:59:59 then converted, never `+86400 s`). Two distinct deadlines are `AMBIGUOUS_DEADLINE`.
- Meetings resolve through `resolvability.calendar.ts` (FOMC/ECB). **Update it yearly**; a test fails when the table has no future meeting.
- `resolution_oracle` must map to an allowlisted source (`RESOLUTION_SOURCES`) that can resolve the category; the source carries the publication lag, time zone, URL and signer instructions.
- If only the close time is off and the deadline is unambiguous, it is clamped into `[max(earliestClose, now + 1 day), latestClose]` (`PROPOSAL_EXPIRY_REPAIRED`); otherwise the proposal is rejected (`PROPOSAL_UNRESOLVABLE`, with reason codes). Repair happens before `pinJson`, so the pinned document carries the final `closeTime`. The resolution hash does not cover close time and is unaffected.
- The resolution block is stored in `Market.resolutionDetails` and pinned in question document v2 (see `docs/api.md`).

## Signal store (#73)

Every market and trade is justified by signals (NewsAPI articles, FRED observations, GDELT events). They are stored as normalised rows with stable identities, so a pinned trace can be audited against the exact evidence long after the fetch. `src/services/ingestion.service.ts` fetches; `signal-normalize.ts` holds the pure rules; `signal-store.service.ts` holds the store (`prismaSignalStore`, and `MemorySignalStore` for tests).

| Table | Role |
|---|---|
| `signals` | One row per article or observation. `dedupKey` is unique: sha256 of the canonical URL, or of `FRED:<series>:<observation date>`. Keeps `url`, `publisher`, `publishedAt`, `firstSeenAt` / `lastSeenAt` / `seenCount`, `category` + `categoryConfidence`, `clusterId`, `numericValue` (FRED) and a 64-bit `simhash`. Title and summary are stored already sanitised (#70). |
| `signal_fetches` | One row per provider call: request fingerprint (credentials removed), status `ok` / `error` / `timeout` / `skipped_no_key`, duration, item and rejected counts. |
| `signal_raw_payloads` | The provider response with credential-named keys stripped, kept `SIGNAL_RAW_RETENTION_DAYS` (default 7). |

`signal_cache` is no longer written and is dropped in a follow-up migration.

**Identity.** The canonical URL lowercases scheme and host, drops `www.`, the fragment and tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref`), and sorts the remaining parameters. NewsAPI `[Removed]` placeholders and articles without a URL are dropped; GDELT `seendate` (`YYYYMMDDTHHMMSSZ`) is parsed as UTC and an unparseable date is rejected, never stored as "now"; FRED `"."` (missing) observations are skipped. Rejections are counted in `signal_fetches.rejectedCount`. FRED's `api_key` is sent in `params` (the request URL is unchanged), so it can be stripped from every stored echo; no stored row contains a key (`tests/ingestion.test.ts`).

**Writes.** One `INSERT … ON CONFLICT ("dedupKey") DO UPDATE SET "lastSeenAt" = …, "seenCount" = "seenCount" + 1` per 100 rows via `$queryRaw`, safe across replicas. There is no per-row Prisma upsert.

**Near-duplicates.** Syndicated copies have different URLs, so they are different rows that share a `clusterId`. A new signal is compared with signals of the same category published in the last 48 h: SimHash Hamming distance ≤ 3, or Jaccard ≥ 0.6 over 5-word shingles of `title + first 200 chars of summary`, makes it a near-duplicate. Including the summary keeps templated headlines ("Stocks rise as …") apart. Cluster assignment is not atomic across replicas, so it is made idempotent: a signal always joins the oldest matching cluster (earliest `firstSeenAt`, then smallest id), and only rows without a `clusterId` are updated. FRED observations never cluster.

**Reads.** A source is fetched only when its last `ok` fetch is older than `SIGNAL_REFRESH_MINUTES` (default 15); otherwise the agents read the store. `aggregateSignals()` takes signals last seen in the past 24 h and returns one representative per cluster (highest source weight, then newest; for FRED, the latest observation per series), each with `signalId`, `url`, `publisher` and `clusterSize`, sorted by

```
relevanceScore = sourceWeight × recencyDecay × log2(1 + clusterSize)
recencyDecay   = 0.5 ^ (ageHours / 12)
```

`sourceWeight` is `SOURCE_WEIGHTS` (NEWSAPI 0.7, GDELT 0.6, FRED 0.9). Age is measured from `publishedAt`, except for FRED, whose observation date is the start of the reporting period: it ages from `lastSeenAt`. Syndication raises a story's score only logarithmically.

**Traces.** `sourcesUsed` entries carry `signalId`, `url`, `publisher` and `publishedAt` (built by `evidenceFromSignals`), and their `weight` is the relevance score instead of a constant. The market maker records the signals its proposal cited in `grounding_signal_ids`. The free `previewSources` keep only `{source, publisher, signal}`. Traces written before #73 have no `signalId`; readers treat these fields as optional, and pinned payloads are never rewritten.

**Retention.** Nightly at 03:41 (`startMonitorCron`): raw payloads older than `SIGNAL_RAW_RETENTION_DAYS`, fetch rows older than 30 days, and signals last seen more than 30 days ago that no trace cites. "Cited" is `reasoning_traces."sourcesUsed" @> '[{"signalId": …}]'`, served by a GIN `jsonb_path_ops` index on `sourcesUsed` (chosen over a `trace_signals` join table: the containment probe is an index lookup and needs no second write path). Deletes run in batches of 1 000.

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

### LLM provenance (#66)

A pinned trace used to prove only that *these bytes were committed*. It now
also says what produced the decision. `tracePayload.provenance`
(`oracledesk.trace.provenance/1`, documented in `docs/api.md`) is added before
canonicalisation, so it is inside the pinned bytes and the on-chain hash. It is
built by `callLLMStructured` (provider, model, prompt id/version/hash, params,
usage, latency, attempts, `fallbackFrom`, `outputSha256`) and assembled in
`generateReasoningTrace`, which merges the market proposal's entry (passed as
`upstreamProvenance` by the market maker) with its own hedge-conditions entry.
Hedge conditions that came from the hard-coded defaults are recorded as
`source: "default"`, with no model fields.

Prompts live in `src/lib/prompts/`, one file per version. `contentHash` covers
the template text, so editing a template changes the hash;
`tests/prompts.test.ts` compares every `{ id, version, contentHash }` with
`tests/fixtures/prompts.snapshot.json` and fails with "template changed; bump
version". A change ships as a new version file and a new registry entry; old
versions stay importable for replay and evaluation.

What provenance proves: that the backend *claimed*, at pin time and under the
agent's commitment, that this provider, model and prompt version produced the
output whose hash is `outputSha256`. What it does not prove: that the model
really produced it. Nothing is signed by the provider, and the raw prompt and
output are not published (they contain third-party text), so a reader can check
a copy of the output against `outputSha256` but cannot reproduce the call.
Provider error messages are never recorded, only a bounded `errorClass`.

### End-to-end x402 test (#64)

The paid product relies on one invariant: the bytes `pinJson` pins are the
bytes whose sha256 is recorded on-chain, and they are exactly what the
contracts repo's x402 service re-hashes before serving. `tests/x402-e2e.test.ts`
proves it by running the submodule's real `createTraceApi` (loaded in place from
`contracts/oracledesk-stellar/x402/` through `tsx`, nothing copied into `src/`)
against traces produced by `generateReasoningTrace` and `pinAndPublishDocument`.
IPFS is an in-memory map, the facilitator is an in-process stub (it accepts any
well-formed payload: the test covers the server path and content parity, not
payment cryptography) and global `fetch` is guarded so any non-loopback request
fails the test. It checks the 402 challenge, a paid 200 whose content equals the
canonical payload, a tampered-bytes 502, an unknown-trace 404 and that a failed
settlement serves nothing. `tests/canonical-parity.test.ts` compares
`canonicalJson` with the contracts `canonicalize` over an edge-case corpus; the
one known divergence is `Date` (ISO string vs `{}`), so `pinJson` rejects
non-plain objects (`IPFS_NON_PLAIN_DOCUMENT`) and a test walks `tracePayload`
for class instances.

```
git submodule update --init
npm run test:x402:prepare   # npm ci in contracts/oracledesk-stellar/x402
npm run test:e2e:x402       # builds the tests and runs the e2e file
```

Locally the tests skip with guidance when the submodule or its dependencies are
missing; with `CI=true` they fail instead. The bindings package the x402
`package.json` links to is only dynamically imported by
`registry-trace-repository.ts`, so it does not need building. CI caches the
package's `node_modules` keyed on its lockfile.

## Payments

A daily pass is granted only after `payment-verification.service.ts` reads the transaction with Stellar RPC `getTransaction` and confirms all of the following:

- it succeeded;
- it is a single `transfer` on the USDC contract;
- `from` is the logged-in wallet;
- `to` is `PAYMENTS_RECIPIENT`;
- the amount is at least `DAILY_PASS_PRICE_RAW`.

Each hash is usable once (unique `PaymentEvent.txHash`). There is no development bypass; tests inject a fake RPC reader. Per-trace unlocks are sold by the x402 service in the contracts repo, which the frontend calls directly.

## Position valuation (#78)

Agent positions are share counts, not futures-style floats. `agent_buy` returns the shares; the position stores `sharesRaw`, `costBasisRaw` and `feesPaidRaw` (`NUMERIC(39,0)`, converted with `decimalToBigint`, never through a JS number). Each trader cycle starts with `markOpenPositions()`: it reads reserves once per market (newest indexed market-core `Trade` event when the indexer is current, otherwise `get_market`; `fee_bps` is fixed per market and cached) and computes, for the held outcome with `src/generated/fpmm.ts`:

- mid value = `shares × price_bps / 10000`
- liquidation value = `collateralOutForShares(reserve_sold, reserve_other, shares, fee_bps)`, `0` with `illiquid` if the pool can't absorb the sale
- unrealised PnL = liquidation value − cost basis

Worked example: reserves YES 400 / NO 600 USDC, fee 1%, a YES position of 10 USDC of shares (100,000,000 raw), cost 5.5 USDC. Price of YES is `600 / 1000 = 60%`, mid value 6.00 USDC. Selling all shares into the pool returns 5.9161929 USDC (liquidation value), so unrealised PnL is +0.4161929 USDC. The same shares on NO (reserve_sold = NO) liquidate at 3.9362880 USDC: swapping the reserves is the classic bug. Stop-loss triggers when `unrealisedPnlRaw ≤ −15% × costBasisRaw`, hedge detection at −10%. Run `npx tsx scripts/backfill-position-shares.ts` once after deploying to fill pre-existing rows (exact from the indexed `Trade` event, otherwise estimated with `calcBuy`, dry-run leftovers reported and skipped).

## Position exits (#77)

`exitPosition()` (`exit.service.ts`) sells through `treasury.agent_sell`; `closePosition()` only closes the database row. market-core `sell` takes an exact `collateral_out`, so the plan inverts the FPMM: `collateralOutForShares`, verified with `calcSell` (lowered a unit at a time until it burns no more than the target), cross-checked with `quote_sell`, and bounded by `max_shares_in = min(held, target × (1 + 1%))`. Shares held are read for the treasury contract (the holder), not the agent key. A position changes only from a confirmed live result; dry-run exits are recorded `SIMULATED`. Every attempt writes a `position_exits` row. `SlippageExceeded` re-plans (twice), `InsufficientShares` re-reads the balance (once), `MarketClosed`/`MarketNotOpen`/`Paused` fail without retry, and an ambiguous submission stays `SUBMITTED`, blocking new exits for that position until the next call reconciles it with the on-chain balance. Exits within 60 s of `close_time` are left to settlement.

## Agent controls (#79)

`agent_controls` holds a pause per scope (`ALL`, `MARKET_MAKER`, `TRADER`) shared by all instances; `agent_control_events` is the audit trail. See the Agent controls section of `docs/api.md` for the endpoints, automatic pauses and the guarantee boundary.

## Resolution

Outcomes are decided on-chain by the resolver contract. The backend only reads `resolver.state` and `market_core.get_market`; the old endpoint that let any user set an outcome is gone. When the indexer sees `MarketResolved`, it updates the database and closes positions.

### Resolution signers (#91)

Markets created with a `signers` spec commit to an m-of-n signer set. `signer-portal.service.ts` serves the people in that set; it coordinates and never holds a signer key.

- **Authority is the committed spec, not the environment.** `RESOLUTION_SIGNERS` can change after a market exists, so membership is read from `Market.resolutionSpec`, and that JSON is trusted only after it re-hashes (`resolutionHash()`) to `Market.resolutionHash` and to the market's on-chain `resolution_hash`. Any mismatch is `409 SPEC_MISMATCH`.
- **Prepare** builds `resolver.attest` with a client whose `publicKey` is the signer and which has no signer callback, so the signer is the transaction source and source-account auth satisfies `signer.require_auth()`. The transaction is simulated, must need no other signers, carries time bounds, and is stored with its hash in `signer_attestations`.
- **Submit** parses the signed envelope, requires its hash to equal the prepared hash (signatures do not change a hash, a different transaction or network does), checks expiry, verifies the wallet's signature, claims the row (`PREPARED` → `SUBMITTED`) so a double submit broadcasts once, then polls for the result.
- **Counts are api-observed.** The resolver emits no per-attestation event and has no count view, so progress counts only attestations confirmed through this API. The proposal comes from the indexed `ResolutionProposed` event, and a proposal the observed counts cannot explain is reported as `attestationsOutsideApi`.
- **No help equivocating.** A second outcome for a signer with a confirmed attestation is refused (`CONFLICTING_ATTESTATION`) unless `allowConflict=true`.

### Disputes and guardian actions

This is the runbook for the guardian: the resolver admin, configured here as `RESOLVER_GUARDIAN_ADDRESS` (the resolver has no admin view, so this is configuration; a wrong value shows up as `GUARDIAN_MISMATCH`).

**Why it exists.** In signer mode an outcome is not final when the threshold is reached. The resolver stores a proposal, emits `ResolutionProposed`, and anyone may call `finalize_signers` once `dispute_window` seconds of *ledger time* have passed. Until then only the guardian can call `cancel_proposal`. With the default configuration (the agent as sole signer, threshold 1) a compromised key or a faulty attestation pipeline can propose a wrong outcome with no one else involved, so something has to notice.

**What the monitor does.** For each `ResolutionProposed` the indexer inserts one `DisputeReview` per event id (idempotent). A separate step, not the indexer tick, then:

1. re-hashes the stored spec and compares it to `Market.resolutionHash` (a mismatch is `ERROR` and `CRITICAL`: a proposal on a market whose rules the backend cannot verify is itself suspicious);
2. fetches the question document from IPFS and checks its sha256 against `Market.questionHash` (a mismatch is `ERROR`);
3. evaluates the market independently from the resolution source. The evaluator is blind: it is not given the proposed outcome, the signers' evidence or any `ReasoningTrace`. It uses its own prompt and, by default, a different primary model from attestation (`dispute_review` task). Evidence is sanitised, delimited as data, instruction-like items are dropped and a decision must cite evidence ids that were really sent;
4. compares the result with the proposal and alerts.

**Verdicts** (`DISPUTE_AGREE_MIN_CONFIDENCE`, default 0.8):

| Verdict | Meaning | Alert |
|---|---|---|
| `AGREE` | Independent outcome equals the proposal, confidence at or above the threshold. | None, except `INFO` when the market has a single signer with threshold 1 and it is the agent: there is no second opinion on-chain. |
| `DISAGREE` | Independent outcome differs, confidence at or above the threshold. | `CRITICAL` immediately. |
| `INSUFFICIENT` | Low confidence, no determination, or evidence that cannot be trusted alone. | `WARN` immediately; `CRITICAL` when less than 25% of the window remains and nobody has acknowledged it. |
| `ERROR` | Spec or question document does not verify. | `CRITICAL` immediately. |

On a market holding at least `DISPUTE_HIGH_VALUE_LIQUIDITY` USDC, `AGREE` also needs a cited primary (non-news) source, so a manipulated news story cannot fool the signers and the review alike. A proposal observed after its window already ended (indexer catch-up) gets `INFO` only. A proposal found only by the 30-minute polling pass (event missed) gets a `WARN`, with `proposedAt` unknown.

**Time.** Remaining window is measured against the latest ledger close time (RPC `getLatestLedger`, then the indexer's newest event), because the contract compares ledger time. Alerts and the admin API show it; the API also shows server time and which source was used.

**Alerts.** Sinks: `ALERT_WEBHOOK_URLS` (JSON, signed `X-OracleDesk-Signature: sha256=<hmac>` with `ALERT_WEBHOOK_SECRET`) and `ALERT_SLACK_WEBHOOK_URL`. Each has a 5 s timeout, 3 attempts with backoff, and is deduplicated by `reviewId:level:sink` in `alert_deliveries` (so restarts and multiple instances do not repeat an alert, and a failed delivery is retried by the next 5-minute pass). Webhook URLs contain tokens: they are never logged, never put in an error message and never stored; sinks are identified by a hash of the URL, and the logger redacts them. If `RESOLVER_GUARDIAN_ADDRESS` is unset, alerts say so.

**What to do when you get one.**

1. `GET /admin/disputes` for the evidence and time left. Open the cited sources yourself; the review is a prompt to look, not a ruling.
2. If the proposal is wrong, `POST /admin/disputes/:id/cancel-tx`. It returns `{ xdr, networkPassphrase, validUntil }`: a simulated `cancel_proposal` whose source is the guardian. Sign it with your own wallet or the Stellar CLI (for example `stellar tx sign` with the guardian key, then `stellar tx send`), within `validUntil`. The backend never signs or sends it.
3. **Cancelling does not clear attestation counts.** The same signers cannot re-attest the same outcome (`AlreadyAttested`), and an outcome that already had threshold votes keeps them. If the whole signer set was wrong, new signers will not help for that market; the remedy is `POST /admin/disputes/:id/void-tx` (`guardian_void_market`), which voids the market through market-core (the indexer then records a `MarketResolved` without an outcome and marks the market `CANCELLED`). Choose between the two before acting. (A resolver that cleared counts on cancel would be a contract change; see `docs/contract-requests.md`.)
4. `POST /admin/disputes/:id/ack` to record that you looked; acknowledged reviews stop escalating.

**Timings.** The review runs within seconds of the indexed event (poll interval plus evaluation time). Escalation and retries run every 5 minutes, the missed-event pass every 30. With the default 24 h window `CRITICAL` for an unconfirmed proposal arrives with six hours left. `cancel_proposal` only works on a proposal that has not been finalized, and anyone may finalize once the window ends, so treat the window end as the deadline.

## Event bus and socket fan-out (#93)

Socket events used to be emitted by the process that indexed them, so with several API instances clients on the others missed events. Now:

```
indexer ──publish──▶ Redis Stream (oracledesk:events) ──▶ one fan-out leader ──io.emit──▶ socket.io Redis Streams adapter ──▶ every instance's clients
```

- **Identity.** Each bus message carries `id = chain_events.id` (the RPC event id), `ledger`, `marketKey` (the on-chain market id) and the payload (bigints as strings).
- **Publication is tied to the committed row.** `chain_events.published` is false when an event is stored. After side effects, `publishPending()` publishes unpublished rows in `(ledger, id)` order and flags each one once the bus accepted it. A crash between store and publish loses nothing; the next pass publishes it. It stops at the first failure so a later event never overtakes an earlier one, and the live path and recovery share one queue per process. If Redis is down the indexer keeps storing events, the server keeps serving, and the backlog drains when Redis returns. Rows that existed before the migration are marked published.
- **Delivery semantics: at-least-once publication, effectively-once delivery.** A crash between XADD and the flag, or two indexing instances racing, can put the same id on the stream twice. The fan-out records every delivered id (`seen` keys with a TTL) and skips ids it has already delivered, so clients still get each event once.
- **Fan-out design.** One instance, elected with `SET leader NX PX` (renewed by compare-and-set), reads the bus with a blocking `XREAD` on its own connection (`getBlockingRedis`, never the shared client) and calls `io.emit`; the streams adapter carries that to every instance. *Alternative considered:* every instance consumes and emits only to its own sockets, with no adapter. It is simpler, but each future feature (per-market rooms, private per-user events) would have to reimplement cross-instance routing, and private events need the adapter anyway. The leader persists the stream id of the last event it delivered (`oracledesk:fanout:cursor`), so a successor resumes there with no gap; the `seen` check prevents the one event that may straddle the switch from being delivered twice. Leadership is re-verified (fenced) before delivering, so a paused leader that lost the lock stops emitting.
- **Ordering.** One stream and one consumer preserve publish order, which is `(ledger, id)` order, so per-market order holds.
- **Retention.** `XADD ... MAXLEN ~ EVENT_BUS_MAXLEN` (default 100000) bounds the stream, a delivery buffer only. `chain_events` is the durable history; anything that must replay far back (for example a resumable SSE feed) should read that table.
- **Not covered here.** Leader election for the *indexer* and splitting API/worker roles (the design works whether one or all instances index), coalescing during a large historical catch-up (the stream stays bounded but is not throttled), and per-market rooms (the `marketKey` field is there for them).
- **Boot without Redis.** The server starts and logs the degraded state. The streams adapter reports a rejected subscribe as an unhandled rejection while Redis is down (it is logged, not fatal). `EVENT_BUS_ENABLED=false` swaps in an in-process bus and no adapter, for a single instance.

## Socket authentication and private events (#94)

- The handshake accepts the REST API's JWT in `auth.token` through `verifyAccessToken()`, the same function `requireAuth` uses (HS256 only, previous-secret rotation included). No token is an anonymous socket; a bad one fails the handshake with a code; a token in the query string is refused.
- Private events (`PAYMENT_CONFIRMED`, `PASS_EXPIRING`, `COPY_TRADE_CONFIRMED`) go only through `emitToUser`/`notifyUser`, which target `user:<userId>`. The public emitter wraps `assertPublic`, and a test fails if any file under `src/` emits a private event name directly.
- A session ends at the token's `exp` (re-armed in chunks, because `setTimeout` overflows above about 24.8 days). The socket gets `SESSION_EXPIRED` and leaves its user room but stays connected for public events, so a long-lived page keeps live prices; `reauth` with a token for the same user restores private events. Switching users on a live socket is refused.
- Emission happens after the database commit: `PAYMENT_CONFIRMED` after the payment transaction (not on the idempotent re-submit), `COPY_TRADE_CONFIRMED` after the status update, `PASS_EXPIRING` after claiming the pass with a conditional update on `expiryNotifiedAt`, which makes it at-most-once even with several instances.
- Tokens are never logged; only the user id is.


## Indexer

`indexer.service.ts` polls Stellar RPC `getEvents` for the four contract ids every `INDEXER_POLL_MS`:

- Events are decoded with each binding's spec (`Spec.parseEvent`) and stored in `chain_events` keyed by the RPC event id, so re-reads are idempotent.
- The ledger cursor lives in `indexer_cursors`. If it is older than RPC retention (about 7 days on testnet), the indexer warns and resumes from the oldest retained ledger; anything in between is lost to it.
- New `Trade` and `TracePublished` events are published to the event bus and delivered to clients over socket.io as `TRADE_EXECUTED` and `REASONING_PUBLISHED` (see [Event bus and socket fan-out](#event-bus-and-socket-fan-out-93)).
- `ResolutionProposed` and `ResolutionFinalized` open and close dispute reviews (see [Disputes and guardian actions](#disputes-and-guardian-actions)). The independent evaluation never runs inside the poll.

The indexer and the reconciler (below) both write `markets.chainSyncedLedger`, the ledger a row's chain-derived state reflects. A price or status write applies only when it is not older than that, so the two can never overwrite each other with stale information, and `applyMarketFinality` (`market-finality.ts`) is the one place a market becomes `RESOLVED`/`CANCELLED` and its positions close.

## Market lifecycle reconciler (#83)

`market-reconciler.service.ts` runs every ten minutes (`3,13,…,53`, `RECONCILE_ENABLED`) on one instance (a Postgres advisory lock held by a transaction, so a pooled connection cannot leak it). It reads `market_core.get_market` with the ledger the simulation ran against, for linked markets in bounded batches (`RECONCILE_MAX_MARKETS`, `RECONCILE_CONCURRENCY`, `RECONCILE_MAX_RPC_CALLS`; open markets first, then never/least-recently reconciled), and classifies each difference with the pure `classifyDrift`:

| Class | Action |
| --- | --- |
| `MISSED_RESOLUTION` / `MISSED_VOID` | repaired through `applyMarketFinality`, `resolvedAt` = observation time |
| `CLOSED_BUT_ACTIVE` | `ACTIVE → RESOLVING` (close_time is ledger time: compared with the observation ledger's close time plus 60 s grace) |
| `PRICE_STALE` (> 0.5 pp) | `currentYesProb` from the reserves |
| `CLOSE_TIME_MISMATCH` | `expiryTimestamp` from chain, unless the row also has a hash mismatch |
| `HASH_MISMATCH`, `STATUS_REGRESSION`, `NOT_FOUND_ON_CHAIN` | reported only: `MARKET_INTEGRITY_DRIFT` agent log at `ERROR` and a `MARKET_DRIFT` socket event to admins |

Resolution-class findings are deferred while the indexer cursor trails the observation by more than `RECONCILE_INDEXER_LAG_LEDGERS` (the indexer may be about to process the event); after three deferrals in a row they are repaired and flagged `forced`. RPC errors other than `MarketNotFound` are not drift: they are counted and the market is retried first next run. The reference ledger's close time comes from `getLedgers`; if that fails the newest indexed event's time (or the wall clock) stands in. Runs and findings persist in `reconcile_runs` / `market_drift_reports` and are readable through the admin endpoints in [api.md](api.md).

## Market correlations (#80)

The trader caps correlated exposure before opening a position (5% of the bankroll, pairs with |ρ| ≥ 0.60). The correlation behind that comes from `CorrelationSnapshot`, recomputed by the monitor cron at `2,17,32,47` (just before the trader) by `computeCorrelationSnapshot`; the trading path only reads the latest snapshot (cached five minutes) and never computes inline.

- **Series.** `price-history.service.ts` rebuilds each market's YES price from stored `MarketCreated`/`Trade`/`MarketResolved` events (`priceYesBps` on the reserves after each trade, BigInt throughout), collapses same-ledger trades to the last one and resamples onto a `CORRELATION_GRID_SECS` grid with last-observation-carried-forward; the series is `null` before the first point and from the resolution on. An index on `((params->>'market_id')::numeric, ledger)` serves the per-market query.
- **Estimate.** Logit-price changes (prices clamped to the contract's 1%–99%) over intervals where **both** markets had an external trade (carried-forward values would give zero returns and bias ρ toward 0; trades by the treasury count for price levels but not as activity, since the agent's own trades would make markets it bought together look correlated). Fewer than `CORRELATION_MIN_OVERLAP` such intervals, or zero variance, uses the category prior (`method: "prior"`). Otherwise `ρ̂ = (1 − δ)·ρ_sample + δ·ρ_prior`, `δ = clamp(κ/(κ+n), 0.1, 1)`, κ = `CORRELATION_PRIOR_KAPPA`. This is Ledoit–Wolf-inspired fixed-target shrinkage, not the full optimal-intensity estimator: pairwise-complete data breaks its assumptions.
- **Scope.** Markets with open positions plus ACTIVE markets expiring within 14 days (≤ 100); pairs use backend ids with `a < b`. The newest 48 snapshots are kept.
- **Sizing.** A snapshot older than two hours is ignored (`CORRELATION_SNAPSHOT_STALE` is logged) and any pair it lacks falls back to the matrix; each pair records which one was used. A pair counts when |ρ| ≥ 0.60 and contributes `ρ_eff × size`, with `ρ_eff = ρ` for holdings on the same side and `−ρ` on opposite sides: positive ρ on the same side adds risk, positive ρ on opposite sides hedges, negative ρ on the same side (YES+YES on complements) hedges, negative ρ on opposite sides adds risk. Net exposure never goes below zero.
- **Reporting.** `GET /portfolio` also returns the full matrix projected onto the nearest PSD matrix (eigenvalue clipping with a small Jacobi solver, ≤ 50 positions); sizing keeps the raw pairwise values.

## Trader forecasts (#75)

The trader trades where its own probability differs from the price by at least 0.08. That estimate comes from `forecast.service.ts`, and no forecaster ever sees the price: `ForecastInput` has no current or initial YES probability and no creator interval. (Before #75 the "estimate" was a weighted mean of signals whose `rawValue` *was* the price, so the edge was always zero.)

- **Inputs.** The question, category, close time, resolution source, up to eight relevant signals (sharing meaningful tokens with the question, or of its category; the dedup tokeniser) and the pinned question document. The document is fetched by `metaUri` and used only if its bytes hash to `questionHash` (`verifyTraceHash`); only `question`, `category`, `closeTime`, `resolutionSource`, `resolution` and `priceResolution` are kept. A failed fetch or a mismatch forecasts without it.
- **LLM forecaster** (prompt `forecast` v1, task `forecasting`, schema-constrained): base rate, per-signal adjustments citing signal ids, `p`, a 50% interval and a rationale. σ = (p_high_50 − p_low_50) / 1.349, p clamped to [0.02, 0.98]. `FORECAST_LLM_SAMPLES` > 1 takes the median p and adds the samples' variance. Untrusted text is sanitised and nonce-delimited as in #70; an instruction-like question document is dropped.
- **Base-rate forecaster.** `forecast.base-rates.json`: reference-class frequencies by category and question pattern, each with its source and a deliberately wide σ (≥ 0.15). Unmatched questions get p = 0.5, σ = 0.25. The figures are approximate tallies; change them as a reviewed code change.
- **Ensemble.** Log-odds, weights ∝ 1/s² with s = σ/(p(1−p)) and σ floored at 0.05 (so no member dominates by claiming certainty), pooled variance 1/Σ(1/s²), mean multiplied by (1 − `FORECAST_SHRINK`, default 0.15), `ci = logistic(μ ± 1.645·σ)` (90%). The trace's `forecast` block holds every member's p, σ, weight, rationale and `inputsDigest`; the trace's `confidenceInterval` is the ensemble's, not the jackknife over sources.
- **Sizing.** Kelly runs on the conservative end of the interval *for the side being bought*: YES uses `ci.lower` against the YES price; NO uses `1 − ci.upper` against the NO price `1 − p_market` (the NO side used to be compared with the YES price). A point edge above 0.08 whose conservative end is not 0.08 better than the price sizes to zero; that is intended and logged as `SIZE_ZERO_WIDE_CI`.
- **Cost.** At most `FORECAST_MAX_MARKETS_PER_CYCLE` (5) markets and `FORECAST_MAX_LLM_CALLS_PER_CYCLE` (10) LLM calls per cycle; candidates without a recent forecast go first, soonest close first. Results are cached in Redis under `forecast:{marketId}:{digest}` (question hash + relevant signals) for `FORECAST_CACHE_TTL_HOURS` (6). A forecast with no LLM member (budget, cap or provider failure) is not traded on.
- **Residual risk.** A model can still read a price out of news ("traders see 70% odds"). The prompt tells it to ignore quoted odds, and the recorded adjustments show which signal moved the estimate.

## Treasury-aware sizing (#76)

The treasury contract enforces `max_trade` per call, cumulative `max_market` per market and a rolling `max_daily` on every agent spend. The trader sizes from the same numbers (`treasury-budget.service.ts`), read once per cycle with `available_capital()`, `get_config()` and `daily_usage()`:

- **Bankroll** = `available_capital()` (the treasury's free USDC: it includes subscription revenue paid to the treasury and excludes capital locked in markets). Kelly, the daily drawdown check and the correlated-exposure cap all use it. A failed read skips the cycle (`TREASURY_READ_FAILED`): there is no constant to fall back to.
- **Daily headroom** = `max_daily − daily_usage().amount`. The view already rolls the window over (a window anchored at the first spend after expiry, not UTC midnight), so an expired window reads as 0 used; it resets at `day_start + 86 400`.
- **Market headroom** = `max_market −` the market's cumulative treasury spend: the latest indexed `TradeAuthorized.market_total` when present, otherwise executed trades plus the seed for agent-created markets (marked `estimated`). Sells never reduce it.
- **Clamp.** In 7-decimal base units, before any trace exists: `final = min(kelly → correlation, max_trade, market headroom, daily headroom, available)`, with `TREASURY_HEADROOM_SAFETY_BPS` (default 5%) taken off the market and daily headroom for races with market creation and window rollover. Orders below 1 USDC are skipped. A budget older than 60 s is re-read, and each buy is debited from the cycle's copy so later orders see it.
- **Trace.** `sizing: { kellyRaw, correlationRaw, marketExposureRaw, marketExposureEstimated, finalRaw, binding, safetyBps, budget }`, with `binding` one of `KELLY | CORRELATION | MAX_TRADE | MAX_MARKET | DAILY | AVAILABLE`.
- **Execution.** `executeTrade` submits `amountRaw` as `collateral_in` (no float round trip). A `TradeCapExceeded` / `MarketCapExceeded` / `DailyCapExceeded` from the chain is logged as `TREASURY_CAP_REJECTED` with the budget snapshot, so drift between estimate and chain is visible.
- **Backtests** answer `budget()` and `marketExposure()` from the simulated treasury, so the replay sizes against the same caps.

`GET /portfolio` reports the same budget (see `docs/api.md`).

## Seed policy (#82)

`seed-policy.service.ts` (pure `decideSeed`) sizes the treasury capital a new market is seeded with and the price it opens at. `planMarketCreation` reads the budget (`treasury.get_config`, `daily_usage`, `available_capital`, market-core's default fee) and runs it **before** the market maker pins or writes anything; a read failure fails closed (`SEED_SKIPPED`, `INSUFFICIENT_CAPITAL`).

- **Price:** shrunk toward 0.5 by confidence-interval width (see [api.md](api.md)).
- **Base seed:** `SEED_CATEGORY_BASE_USDC[category] × clamp(√(days to close / 30), 0.5, 1.5)`, at most 2× the LLM's `minimum_liquidity_usdc` (the LLM can lower it, not inflate it), at least the on-chain `MIN_SEED` (100 USDC).
- **Bounds** (the smallest wins, and is recorded as `binding`): treasury `max_trade` and `max_market` (each with a 5% safety margin, since the trader can spend between the read and the write), the market maker's `MM_DAILY_SHARE_BPS` of `max_daily` minus its seeds in the current window, the remaining `max_daily` headroom, `MAX_SEED_FRACTION_BPS` of available capital, `MAX_UNRESOLVED_SEEDED_RAW` minus the seed already locked in unresolved markets, and the LP-loss budget.
- **Expected LP loss** (`LP_LOSS_BUDGET_RAW` per market): an informed trader buys the underpriced side until the price reaches the confidence-interval bound farthest from the opening price; the loss is the seed minus the value of the LP's reserves and creator shares at that price. It is computed with `seedReserves`/`calcBuy`/`priceYesBps` from `src/generated/fpmm.ts` (integer math, the contract's rounding) and a bigint bisection (≤ 40 steps) finds the largest seed within budget. Trading fees accrue outside the pool and are ignored.
- A seed below `MIN_SEED` is a skip whose reason names the binding bound (`BELOW_MIN_SEED`, `DAILY_BUDGET`, `AGGREGATE_CAP`, `LP_LOSS_BUDGET`, `INSUFFICIENT_CAPITAL`). If the treasury rejects the seed anyway (`DailyCapExceeded`, `MarketCapExceeded`, `TradeCapExceeded`), `SEED_CAP_RACE` is logged and the market stays `PENDING` for the reconciler.

## Backtesting (#81)

`scripts/backtest.ts` replays stored market-core history through the trader's real decision code. The decisions live in `src/agents/trader-policy.ts` (`runTraderPolicy(env, params)`), which touches only a `TraderEnv` (`trader-env.ts`: a clock, reads of markets, positions and signals, execution, and a decision sink). `prodTraderEnv()` wraps Prisma and the chain service and `runTraderCycle()` is `runTraderPolicy(prodTraderEnv(), DEFAULT_PARAMS)`; `tests/backtest.test.ts` records every Prisma and chain call a cycle makes and asserts the sequence is unchanged.

```bash
npm run backtest -- --from 2026-10-01 --to 2026-10-15 --out ./bt \
  --forecaster oracle-noise:0.15 --seed 7 --max-trade-raw 5000000000
# offline, from a JSON file {events, signals, forecasts}:
npm run backtest -- --events-file tests/fixtures/backtest/events.json --out /tmp/bt
```

The runner only issues `findMany` (events up to `--to`, because pools are rebuilt from `MarketCreated` and everything after it, plus `signal_cache` and the live agent's stored forecasts) and writes `report.json` and `report.md`. Options: `--from`, `--to` (required against the database; with `--events-file` they default to the file's span), `--bankroll-raw`, `--max-trade-raw`, `--max-market-raw`, `--max-daily-raw` (7-decimal base units; defaults 10 000 / 500 / 1 000 / 2 000 USDC), `--impact reset|propagate|both` (default both), `--forecaster prior|oracle-noise:<σ>|recorded`, `--seed`, `--fee-bps` (inferred from the first historical buy), `--events-file`, `--out`.

**How it works.** A simulated UTC clock steps every 15 minutes. Before each step every event with `ledgerClosedAt ≤ now` is applied in order (pools are seeded by `seedReserves`; external trades move them; `MarketResolved` settles positions with `settleValue`, void at half a share's value), then the policy runs against a `BacktestEnv` built only from that state: it never reads a live row, so it cannot see the future. Agent orders fill against the simulated pool with `calcBuy`/`calcSell`, update its reserves, and spend through a `SimTreasury` that enforces `max_trade`, cumulative `max_market` and a rolling 24-hour `max_daily` whose window starts at the first spend after the previous one expired (selling is uncapped). Trading after `close_time` is refused like market-core's `MarketClosed`. Floats exist only in the policy; `usdcFromNumber` converts at the buy boundary and everything else is base-unit bigint.

**Impact models.** Historical trades were made against the historical pool, not one containing the agent's trades, so replaying their reserves would erase the agent's impact while replaying their collateral changes their share amounts. `reset` snaps to the historical reserves after every external trade: an optimistic upper bound, since impact decays instantly. `propagate` re-executes each external trade's collateral on the simulated pool, so the agent's impact persists (trades the pool cannot fill are counted as skipped). Both are reported by default; the gap between them is how much of the result depends on the agent not moving prices.

**Forecasters.** The LLM estimate is replaced by a deterministic one: `prior` (the market's opening price), `oracle-noise:σ` (the resolved outcome plus seeded Gaussian noise: an upper bound on skill, since it reads the future by design) or `recorded` (the forecast stored in `reasoning_traces.probabilityEstimate` at that time, no forecast if none). Noise is seeded from `(seed, market, time)`.

**Reading the report.** Per impact model: PnL (cash plus liquidation value via `collateralOutForShares` at the end), max drawdown, a Sharpe-like ratio (daily equity returns, annualised), turnover, win rate, stop-loss count, cycles paused by the daily-drawdown rule, cap hits per cap (`TradeCapExceeded`, `MarketCapExceeded`, `DailyCapExceeded`, …), average edge at entry against the forecast and realised edge of resolved positions, impact cost (fill versus mid, fees included) and per-market attribution. `configHash` and `inputsHash` are sha256 over the canonical config and the time-sorted inputs; the same inputs, config and seed give a byte-identical `report.json`. Differences from production: the clock is UTC (production's drawdown check uses local midnight); pool liquidity is the reserve sum; correlations use the category matrix (there are no snapshots in a replay); and hedges execute against the pool (one per pair), whereas production's `autoHedge` only records a PENDING trade.

**Caveats.** The numbers evaluate the policy as written. Two properties of it show up quickly in a replay: the 15% stop-loss compares `|price − entry| / entry`, so it also fires on favourable moves and on the agent's own impact (in a thin pool a 250 USDC entry can stop itself out on the next step), and the NO-side Kelly sizing compares the NO probability with the YES price. Neither was changed here: the harness exists to evaluate the rules, not to change them. Avoid tuning constants on the same window you evaluate them on (see Bailey et al., "The Probability of Backtest Overfitting").

## Health and degraded mode (#111)

`/livez` checks only the process; `/readyz` probes Postgres, Redis, RPC and the indexer lag. `HEALTH_CRITICAL` decides which failures return 503. By default Redis and Postgres are critical (login and every data endpoint need them) and RPC is not: an instance without RPC stays ready and keeps serving database reads, while on-chain state, resolution, trace and payment endpoints return 502. The indexer fails when it is more than `INDEXER_MAX_LAG_LEDGERS` behind or its cursor is older than `INDEXER_MAX_STALENESS_MS`; with no cursor yet it reports `initialising`. On SIGTERM `/readyz` returns 503 `draining` for `SHUTDOWN_DRAIN_MS` before the server stops accepting connections.

## Generated code

`src/generated/` is copied from the pinned `contracts` submodule by `scripts/sync-contracts.mjs`, with a do-not-edit header and `// @ts-nocheck`. CI fails if it's stale.

The sync also writes `src/generated/contracts-manifest.json`: for each binding, a sha256 over its embedded spec entries, a per-entry `{ kind, name, sha256 }` index, and the expected wasm hash when the submodule's `deployments/*.json` records one (see `docs/contract-requests.md`). The manifest is derived from the submodule only — `--check` needs no network — so a binding bump shows up in code review as changed spec hashes.

## Contract compatibility (#34)

The backend assumes the contracts at the `CONTRACTS` addresses run exactly the wasm the bindings were generated from. Deployed contracts can be upgraded, redeployed from another build, or replaced by an env override, and when they drift the failures appear late and far from the cause: a renamed entrypoint fails simulations with `MissingValue`, a changed struct decodes with missing fields, a changed event makes `Spec.parseEvent` return null or throw inside the indexer poll.

Every deployed Soroban contract carries its interface: the wasm's `contractspecv0` custom section holds the same `ScSpecEntry` XDR the bindings embed, and the contract instance records its wasm hash. At boot, `src/services/stellar/spec-compat.ts`:

- fetches each contract's instance and code ledger entries over RPC (`getLedgerEntries`), reads the wasm hash and parses the embedded spec (`contract.Spec.fromWasm`), cached per wasm hash;
- diffs the deployed spec structurally against the synced binding — docs are ignored, types compare canonically (`Option`/`Vec`/`Map`/`BytesN`/UDT-by-name) — and classifies each difference as **breaking** or **compatible** against a usage table of the entrypoints the services actually call and the events the indexer projects (a unit test greps the services and fails when the table is stale);
- checks the wasm hash against the manifest pin when one is recorded and the contract id is not overridden by env;
- only confirms the USDC contract's executable is a Stellar Asset (its interface is a SAC, never checked).

Classification rules: a used function removed or changed is breaking, an unused or new one is compatible; a struct/union/enum reachable from a used function or projected event is breaking when changed, except a union/enum case appended at the end, which is compatible for read-only types and breaking for types the backend encodes (e.g. `Category`); an error enum code reassigned under an existing name is breaking (error naming depends on it), new codes are compatible; a projected event changed in topics or data fields is breaking. A contract that cannot be verified (archived code entry, RPC failure) is breaking — the gate never fails open.

In live mode (default `SPEC_COMPAT_ENFORCE=enforce`) any breaking difference or wasm-hash mismatch refuses startup, listing every breaking item. Dry-run (default `warn`) logs a structured warning and keeps running; `off` skips the check. The indexer keeps **storing** events whose spec changed in a breaking way but stops projecting and publishing them (and a `parseEvent` throw skips that event instead of aborting the poll). Admins can read the last report at `GET /api/v1/admin/chain/spec-compat`.

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

## Structured LLM output (#65)

Output that must fit a shape (market proposals, hedge conditions) is never
parsed out of prose. `src/lib/llm-schema.ts` is the single registry: each shape
is a zod schema from which `defineStructured()` derives the Anthropic tool
`input_schema` (`z.toJSONSchema`, draft-7) and the Gemini `responseSchema`
(`toGeminiSchema`, an OpenAPI-subset dialect: types mapped to `SchemaType`,
`const` becomes a one-value `enum`, `propertyOrdering` added, and
`additionalProperties`, `$schema`, `minLength`, `pattern`, `format` and
exclusive bounds dropped, since Gemini answers 400 on them). Wire schemas avoid
`.catch`, `.default` and transforms; the lenient domain parse
(`marketProposalSchema`) applies defaults separately, and a bad currency is an
error on the wire. Rules JSON Schema cannot express (the confidence interval
must contain the probability, expiry must be in the future) are `postValidate`
functions whose message goes into the repair turn.

`callLLMStructured(spec, { system, user }, { maxTokens, ctx, task })` returns
`{ value, provider, model, attempts }`:

1. **Anthropic**: `tools: [{ name, description, input_schema }]` with a forced
   `tool_choice`; the `tool_use` block is searched for (a text block may come
   first). `stop_reason: "max_tokens"` is never repaired at the same budget: the
   budget is doubled once, then the call fails with a specific reason.
2. **Gemini**: `responseMimeType: "application/json"` plus `responseSchema`;
   the text is `JSON.parse`d with no fence stripping.
3. Each provider gets **one repair round**: the zod issues (or the `postValidate`
   message) go back as an `is_error` `tool_result` (Anthropic) or a correction
   turn (Gemini). Anthropic that still fails falls back to Gemini.
4. Failure is `AppError(422, "LLM_STRUCTURED_OUTPUT_FAILED", { provider, issues })`
   when output never validated, otherwise the last transport/guard error.
   `INVALID_LLM_JSON`, `SCHEMA_VALIDATION_FAILED` and
   `INVALID_CONFIDENCE_INTERVAL` remain on the `validateMarketQuestion()` wrapper.

Every attempt, repairs included, takes a lease on the shared guards below. Prompts
and outputs are not logged at info; counts and provider/model are. `callLLMText`
falls back to a plain-text Gemini call (never a JSON one). Tests replace the
providers through `setAnthropicClient()` / `setGeminiModelFactory()` and replay the
shapes in `tests/fixtures/llm/` (hand-built examples of the API shapes, not
captures from a live account).

## Semantic duplicate detection (#69)

The lexical check (token Jaccard > 0.55 or 3+ shared bigrams) misses
paraphrases and flags unrelated questions that share boilerplate. With
`EMBEDDING_PROVIDER=gemini|openai` the market maker compares embeddings in
pgvector instead; with `none` (the default) nothing changes.

**Storage.** `markets.questionEmbedding vector(768)` and `embeddingModel`, added
by migration `…_market_embeddings` (`CREATE EXTENSION vector`). Prisma cannot read
or write `Unsupported` columns, so every access is `$queryRaw` / `$executeRaw`
with the vector bound as `$n::vector` (a `'[0.1,…]'` string), never interpolated.
The index is `markets_question_embedding_hnsw`, HNSW with `vector_cosine_ops`,
**partial** on `status IN ('PENDING','ACTIVE')`: pgvector filters after the index
scan, so a full index would fill its 40-candidate list with old resolved markets
and hide a near duplicate. The dedup query repeats the predicate, which is what
lets the planner use it; at a few hundred rows the planner correctly prefers an
exact scan and sort, which has perfect recall. The index is not in
`schema.prisma`: `prisma migrate dev` must not be allowed to drop it (check with
`prisma migrate diff` before accepting a generated migration). The dimension is
fixed at 768 (Gemini `text-embedding-004`; OpenAI `text-embedding-3-small` with
`dimensions: 768`); `EMBEDDING_DIM` must equal it, a provider with another size
is rejected, and a mismatch stops the server at boot.

**Embedding.** `normalizeQuestion()` lowercases, collapses dates to `<date>` (the
second stage compares dates itself), writes numbers as plain digits (`$70,000`,
`70k` → `70000`), strips punctuation and caps the text at 512 characters. A new
market is embedded fire-and-forget after `createMarketFromProposal`; the
ingestion cron then sweeps `questionEmbedding IS NULL` rows (one batch of 32 per
tick), and `npm run backfill:embeddings [-- --reembed]` embeds everything else.
Vectors from two models are never compared: the query filters on
`embeddingModel`, so after changing `EMBEDDING_MODEL` run
`backfill:embeddings -- --reembed`.

**Decision** (`checkDuplicate` in `market.service.ts`, returns
`{ duplicate, method, match? }`, logged to AgentLog as `DEDUP_CHECK` /
`DUPLICATE_SKIPPED`):

1. *Candidates*: the 10 nearest PENDING/ACTIVE neighbours by cosine similarity;
   those at or above `DEDUP_SIM_THRESHOLD` continue.
2. *Confirmation* (`confirmDuplicate`, pure), in order: (a) the resolution dates
   are within `DEDUP_DATE_WINDOW_DAYS` (default 3), both the expiries and any
   date written in both questions; (b) the questions do not each state a figure
   the other lacks (`$70,000` vs `$90,000` are two rungs of a ladder); (c) they
   share an entity from the rule-based extractor (`dedup-entities.ts`: a gazetteer
   of central banks, assets, indicators, countries and sources, plus proper
   nouns) and neither adds an entity the other lacks (Lakers vs Celtics).
   Similarity ≥ 0.95 skips (c) only, never the date or figure checks.
3. *Fallback*: markets the vector search cannot see (no embedding yet, or from
   another model) are compared lexically so nothing is skipped silently. With no
   provider, or if embedding or the query throws, the lexical check runs and the
   result says `method: "lexical"`; the cycle is never blocked.

**Calibrating the threshold.** `tests/fixtures/dedup-pairs.json` holds 158 labelled
pairs (44 paraphrases and 16 formatting variants that are duplicates; different
date, different entity, boilerplate collision, different strike and unrelated
pairs that are not). `npm run calibrate:dedup` embeds them, sweeps thresholds
0.50–0.99 and reports precision, recall and F1 for semantic only, semantic +
confirmation, and the lexical rule, and recommends the threshold with the highest
recall at precision ≥ 0.95. `--provider gemini|openai --record` writes the
vectors to `tests/fixtures/dedup-vectors.<model>.json`, and `--vectors <file>`
replays them without a key.

The committed run uses `--provider fake`, a deterministic hashing embedder with
a small synonym map. It validates the harness and the confirmation stage, **not**
a model: on it the lexical rule scores precision 17.9 % / recall 28.3 %
(boilerplate makes it flag unrelated questions), and semantic + confirmation
scores precision 100 % at t = 0.90 with recall 26.7 % because the fake vectors do
not place paraphrases close together. `DEDUP_SIM_THRESHOLD=0.85` is therefore a
provisional default; run the calibration with the real provider and replace it
before enabling `EMBEDDING_PROVIDER` in production.

**Infrastructure.** pgvector is needed by the migration: `docker-compose.yml`, CI
and the integration containers use `pgvector/pgvector:pg16` (Debian, glibc; the
old `postgres:16-alpine` is musl, so recreate an existing dev volume or `REINDEX`
text indexes before switching). Managed Postgres needs `CREATE EXTENSION vector`.

## Calibration (#68)

`src/services/calibration.service.ts` answers whether agent probabilities are
calibrated. Postgres does the heavy lifting in one query
(`reasoning_traces JOIN markets` for `RESOLVED` markets with an outcome and an
`onChainMarketId`, traces strictly before `resolvedAt`); TypeScript weights,
slices and scores the rows with pure functions (`brier`, `logLoss`,
`reliability`, `murphy`, `fitShrinkage`). Metric definitions, the weighting
policy and the exclusions are in `docs/api.md` ("Agent calibration").

- **Snapshots.** `computeAndStoreSnapshots()` stores every
  window (`30d`, `90d`, `all`) × grouping × key in `calibration_snapshots`
  (append-only; the API serves the newest `computedAt`). A cron at 03:10 runs it
  inside a transaction holding `pg_try_advisory_xact_lock`, so only one
  instance computes.
- **Index.** `reasoning_traces (marketId, createdAt)` serves the join. Postgres
  uses it for selective windows (a nested loop of one index range scan per
  market: 7 ms for 334 markets / 3 340 traces in a test database) and prefers a
  sequential scan when most markets match (`all`, 55 ms for 200 000 traces).
- **Trader shrinkage** (`CALIBRATION_SHRINKAGE_ENABLED`, default off). Before
  sizing, the trader moves its estimate to `0.5 + k (p − 0.5)` with `k` from the
  latest `all`-window `(TRADER, category)` snapshot, then `(TRADER)`, then 1,
  only when at least 50 resolved markets back the fit; `k` is bounded to
  `[0.3, 1]`, so it can only shrink. The factor is recorded in the trace as a
  `CALIBRATION` entry in `sourcesUsed`.
- **Limits.** Few resolved markets give noisy numbers: read the Wilson
  intervals and `nEff`. Calibration says nothing about the trader's *edge* while
  its probability still equals the market price (`rawValue: marketProb`), and
  `MARKET_CREATION` has no meaningful market baseline.

## Evaluating market generation (#67)

`npm run eval:markets` measures whether a prompt, model or schema change makes
proposals better or worse. It is offline: the corpus pins the inputs and
recordings pin the model's answers, so a run is deterministic and needs no
keys, database or network.

- **Corpus** (`tests/eval/corpus/<id>.json`, 44 cases): an `asOf` date, the
  signals (titles and short snippets only, as the prompt truncates them), the
  fixed list of existing questions used for dedup, and the human `labels`
  (`category`, `expectDuplicateOf`, `notes`). The committed cases are synthetic,
  including adversarial ones (past-dated signals, ambiguous events, a sports
  story with no fixture date, a paraphrase of an existing market, an injected
  headline). Add real ones from `SignalCache` after stripping keys and PII.
- **Prompts** are built by `buildMarketPrompts(signals, existing, now, { nonceSeed })`,
  a pure function: no Prisma, no clock. The runner passes `now = asOf` and a
  nonce seed derived from the case id, so the prompt is a pure function of the
  case. `isDuplicateOf(question, existing)` is the pure form of the lexical dedup.
- **Transport**: `setLlmTransport()` (`src/lib/llm.ts`). Replay reads
  `tests/eval/recordings/<model>/<id>.json` (and `<id>.judge.json`), each
  keyed by `sha256(system + user)`. A prompt change changes the key, so replay
  fails with `recording missing … re-run with --live --record` instead of
  grading stale output. `--live` uses the real providers; `--record` writes the
  recordings after refusing any key-looking string.
- **Graders** (`scripts/eval/graders.ts`), each `{ pass, score, detail }`:

  | Grader | Rule | Judge |
  |---|---|---|
  | `schemaValid` | `validateMarketQuestion` parses it | – |
  | `binary` | one yes/no question; no "or", "how many", "which", bucket ranges | `binary` |
  | `resolutionSource` | `resolution_oracle` is in `ALLOWED_ORACLES` | `verifiable` |
  | `dateSanity` | `asOf + 1 d ≤ expiry ≤ asOf + 90 d`, and within 2 days of the latest date written in the question | – |
  | `category` | equals the label (unlabelled cases are skipped) | – |
  | `duplicateAccuracy` | `isDuplicateOf` agrees with `expectDuplicateOf` | – |
  | `ciConsistency` | `lower < p < upper`, width ≤ 0.4 | – |

  A parse failure fails every grader for that case, so a bad prompt cannot hide
  behind a smaller denominator. The judge (`scripts/eval/judge-prompt.v1.ts`,
  id, version and hash recorded in each report) can fail a case but never
  rescues a hard rule failure; rule/judge disagreements are listed separately.
- **Thresholds** (`tests/eval/thresholds.json`) are minimum pass rates per
  grader. The report shows counts and Wilson 95 % intervals next to each rate:
  with 44 cases a difference of a few points is noise. Exit codes: 0 ok, 1 a
  threshold regressed, 2 the run failed (for example a missing recording).
- **Reports**: `eval-results/<mode>-<model>.json` and `.md` (prompt and corpus
  hashes, git sha, per-grader and per-category rates, the worst 10 cases).

CI runs `npm run eval:markets -- --replay` after `npm test`.

**Add a case**: write `tests/eval/corpus/<id>.json`, run it live once
(`ANTHROPIC_API_KEY=… npm run eval:markets -- --live --record --model <name> --case <id>`)
and commit the corpus file and the two recordings. **After a prompt change**:
re-record the whole set the same way (without `--case`), review the diff, and
commit; only then adjust `thresholds.json`.

The `synthetic-baseline` recordings shipped with the harness are hand-written
(`scripts/eval/seed-synthetic.ts`), not captures of a live model, and their
thresholds only guard the graders; the first live run should replace them.

## Prompt-injection defences (#70)

Headlines, descriptions, GDELT URLs and earlier market questions are untrusted,
and an accepted proposal makes the treasury seed a market. Layers
(`src/services/llm-guard.service.ts`, all pure):

1. **Sanitise at ingestion** (`sanitizeSignal`, applied by all three fetchers
   before `cacheSignals`, and again on cache reads): NFKC, removal of `\p{Cc}` and
   `\p{Cf}` (zero-width, bidi overrides), whitespace collapse, 200/300 character
   caps, URLs moved to `url` (GDELT stores its link there and `content: ""`).
   Flags: `stripped_control`, `had_url`, `truncated`, `instruction_like`.
2. **Quarantine**: `instruction_like` signals (instruction phrasing such as
   "ignore all previous instructions", "system prompt", "you are now", or our
   JSON keys; not the bare word "ignore") are never sent to the model. FRED rows
   are built from numbers by our code and are never quarantined. If nothing is
   left, the cycle is skipped (`NO_USABLE_SIGNALS`).
3. **Delimit**: `renderUntrustedBlock` emits one JSON line per signal inside
   `<untrusted_signals nonce="…">` (6 random bytes per call, never derived from
   content); look-alikes of the tags inside the data become `‹untrusted_signals`.
   Existing markets use the same treatment (`existing_markets`). Signals have
   citable ids `n1…`, `f1…`, `m1…`.
4. **Hierarchy**: both system prompts say the block is data that may contain
   instructions and must not be followed; proposals must cite `grounding_signal_ids`.
5. **Policy** (`checkProposal`, after schema validation): reasons
   `UNGROUNDED` (unknown ids, or no cited signal shares two meaningful tokens with
   the question), `PROBABILITY_OUT_OF_POLICY` (outside [0.05, 0.95], rejected not
   clamped), `EXPIRY_OUT_OF_RANGE` (outside 1–90 days), `ORACLE_NOT_ALLOWED`
   (`ALLOWED_ORACLES`), `BANNED_TOPIC` (frozen patterns), `URL_IN_QUESTION`
   (URLs, handles, code fences), `INSTRUCTION_ECHO`, `NON_ASCII_CONTROL`. A
   failure throws `PROPOSAL_REJECTED_BY_GUARD` (422).

Rejections write `PROPOSAL_REJECTED` and quarantines `SIGNALS_QUARANTINED` to
`agent_logs` with reason codes, counts and `sha256(canonicalJson(signal))`, never
raw titles. `tests/fixtures/injection/*.json` holds 28 attack and 18 benign cases
with recorded model outputs; `tests/llm-injection.test.ts` replays them through
`generateMarketQuestion` (model replaced by `setLlmJsonCaller`).

## LLM budgets and shared guards (#71)

`src/lib/llm-budget.ts` (state in Redis, atomic Lua in `llm-budget-store.ts`)
replaces the per-process interval guards and circuit breaker. Every provider
attempt is `acquire()` → call → `record()`:

- **Token bucket** per provider (`LLM_ANTHROPIC_RPM`, `LLM_GEMINI_RPM`, capacity =
  RPM). An empty bucket makes `acquire` wait with jitter for up to 30 s.
- **Circuit breaker** per provider: `closed → open → half-open`. A daily quota error
  opens it (Gemini: until at least the next UTC midnight); `LLM_BREAKER_FAILURE_THRESHOLD`
  consecutive errors open it for `LLM_BREAKER_OPEN_MS`. After that exactly one probe
  is admitted (its holder has a TTL, so a hung probe cannot block recovery);
  success closes the breaker, failure reopens it. `LlmCircuitOpen` is `503
  LLM_CIRCUIT_OPEN`; the router then tries the next provider.
- **Daily budgets** per UTC day across providers and instances:
  `LLM_DAILY_TOKEN_BUDGET` and `LLM_DAILY_COST_BUDGET_MICROS`. A call reserves
  `ceil(chars/4) + maxTokens`; `record()` releases the reservation (also on errors
  and responses without usage) and adds the real input/output tokens and an
  estimated cost from `LLM_PRICES` (an estimate; update it when prices change).
  Crashed calls are reclaimed when their lease TTL passes. Cron work stops at
  `budget × (1 − LLM_ADMIN_RESERVE_PCT%)`; admin work runs to the full budget.
  `LlmBudgetExceeded` is `429 LLM_BUDGET_EXCEEDED` and never falls back to another
  provider (the budget is global). The market cycle logs `LLM_BUDGET_EXCEEDED`
  once per day (Redis `SET NX`) and returns `null`.
- **Redis down**: `LLM_REDIS_FAIL_MODE=closed` (recommended) refuses calls with
  `LLM_CIRCUIT_OPEN` / `GUARD_STORE_UNAVAILABLE`; `open` falls back to a per-process
  limiter and warns at most once a minute.

Time comes from Redis `TIME` inside the scripts, so clock skew between instances
does not matter; this is also why budgets reset at UTC midnight, unrelated to
`checkDailyDrawdown`'s local midnight. The Anthropic client uses `maxRetries: 0` so
the limiter sees every HTTP attempt. Callers tag calls with a `CallContext`
(`purpose`: `market_generation`, `trace_hedge`, `admin_generation`; `priority`:
`cron` or `admin`); `POST /markets/generate` runs as `admin`. `getLlmUsage()` (tokens,
cost, reserved, breaker states) is part of `GET /admin/status` and logged after each
cycle.

Tuning: raise `LLM_DAILY_*` for more volume; keep `LLM_ADMIN_RESERVE_PCT` large
enough that an admin can still trigger a market when cron has stopped; set the RPM
values at or below the provider's account limits; look for repeated
`LLM call recorded` lines with `outcome: "error"` before lowering the breaker
threshold.

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
