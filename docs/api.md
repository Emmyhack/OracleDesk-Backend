# OracleDesk backend API (Stellar)

This is the contract between `OracleDesk-Frontend` and this backend. The
Soroban contracts in `OracleDesk-SmartContract/oracledesk-stellar` are the
source of truth for anything on-chain; this API never overrides them.

Base URL: `/api/v1` (liveness is `/livez`, readiness is `/readyz`).

## Conventions

### Envelope

Every response, success or error:

```json
{ "ok": true,  "data": { }, "error": null, "meta": { } }
{ "ok": false, "data": null, "error": { "code": "SOME_CODE", "message": "Readable text", "details": { }, "requestId": "req_018f..." } }
```

Every response carries an `X-Request-Id` header (exposed via CORS), and error envelopes repeat it as `error.requestId`; quote it when reporting a problem. A client may send its own `X-Request-Id` (8 to 64 characters of `A-Z a-z 0-9 . _ : -`); any other value is ignored and a new id is generated.

`meta` is optional. List endpoints put pagination there:
`{ "page": 1, "limit": 20, "total": 57, "totalPages": 3 }`.

### Auth

Protected routes take `Authorization: Bearer <jwt>`. The JWT comes from
`POST /auth/verify` and lasts 7 days. Errors: `401 UNAUTHORIZED`,
`401 INVALID_TOKEN`, `401 TOKEN_EXPIRED` (the frontend clears its session on
the last one).

Routes marked **optional auth** work without a token and return more when
one is present.

### Identifiers and amounts

| Kind | JSON type | Example | Notes |
|---|---|---|---|
| Backend ids (`id`, `marketId`, `traceId`) | string (UUID) | `"8c1f…"` | Database ids. |
| `onChainMarketId` | decimal string or `null` | `"0"` | market-core `u64` id, 0-based and sequential (`0 … market_count()-1`). Never a JS number. `null` until the creation tx is confirmed. |
| `onChainTraceId` | decimal string or `null` | `"3"` | reasoning-registry `u64` trace id. |
| On-chain amounts | decimal string, name ends in `Raw` | `"10000000"` | i128 in USDC base units, **7 decimals** (1 USDC = `10000000`). |
| Display amounts | number | `12.5` | Floats for display only. Never build a transaction from them. |
| Probabilities | number 0–1 | `0.62` | Display. On-chain prices are basis points (`yesBps`, 0–10000). |
| Stellar addresses | string | `"GABC…"` / `"CABC…"` | `G…` accounts, `C…` contracts. Case-sensitive (StrKey is uppercase). |
| Hashes | lowercase hex, no `0x` | `"9f86…"` | sha256, 64 chars. Stellar tx hashes are also 64 hex chars. |

### Categories

The backend keeps its finer categories for display and filtering. Markets go
on-chain with the contract `Category`, via `toContractCategory()` in
`src/lib/categories.ts`:

| Backend `category` | Contract `Category` |
|---|---|
| `FED`, `ECB`, `MACRO` | `Macro` |
| `GEOPOLITICAL`, `ELECTION`, `POLITICS` | `Geopolitics` |
| `CRYPTO` | `Crypto` |
| `SPORTS` | `Sports` |
| `ENTERTAINMENT` | `Culture` |

The contract's `Other` has no backend category. The switch is exhaustive, and
a unit test fails if either enum gains a member.

API responses include both: `category` (backend) and `contractCategory`.

### Settlement currency

**Decision: `EURC` is dropped.** market-core takes exactly one collateral
token (the USDC SAC in `deployments/testnet.json`), so a market can't settle
in EURC. Keeping it "display-only" would label markets with a currency they
can't trade in. A migration maps any existing `EURC` rows to `USDC` and
removes the enum value. `settlementCurrency` stays in responses (always
`"USDC"`) so the frontend doesn't break; the `currency` filter on
`GET /markets` accepts only `USDC`.

## Idempotency

State-changing endpoints accept an `Idempotency-Key` header
([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
the same model as Stripe). Generate one key per **logical operation** and send
the same key on every retry of it.

| Route | Header |
|---|---|
| `POST /markets/generate` | **required** |
| `POST /trade/copy` | **required** |
| `PATCH /trade/copy/:id/confirm` | optional |
| `PUT /traces/access/allowance` | optional |
| `POST /traces/verify` | optional |
| `POST /traces/:id/unlock` | optional |
| `POST /auth/challenge`, `POST /auth/verify` | not supported (the handshake is single-use, and `/auth/verify` returns a JWT that is never stored) |

- **Format:** 1–255 printable ASCII characters. A UUID (`crypto.randomUUID()`) is recommended.
- **Scope:** `(user, method, route template, key)`. The same key from another user or on another route never collides.
- **TTL:** 24 h. Expired keys are purged hourly.
- **Fingerprint:** sha256 of the canonical `{ method, route, params, query, body }` (keys sorted, so JSON key order and query-parameter order don't matter).

**Responses**

| Situation | Result |
|---|---|
| First request | Runs normally. Its 2xx/4xx response is stored. |
| Exact retry after it finished | The stored status and body are replayed with `Idempotent-Replayed: true`. The handler does **not** run again (e.g. `POST /markets/generate` returns the original `jobId` and starts no new cycle). |
| Retry while the first is still running | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1` |
| Same key, different request | `422 IDEMPOTENCY_KEY_MISMATCH` |
| Missing key on a required route | `400 IDEMPOTENCY_KEY_REQUIRED` |
| Malformed key | `400 IDEMPOTENCY_KEY_INVALID` |
| Original response was > 64 KB | `409 IDEMPOTENCY_RESPONSE_UNAVAILABLE` (use a new key) |

- **5xx responses are not stored.** The key is released so a retry runs again. If a handler commits a side effect and *then* fails with a 5xx, a retry re-executes it, so such handlers must make the effect itself idempotent (as `recordPayment` does for a duplicate `txHash`).
- A stored **4xx is replayed as-is**, even if state has changed since (e.g. a `403 TRACE_LOCKED` replays after the user buys a pass). After changing state, use a **new** key.
- A request that crashed mid-flight holds its key for 60 s, after which a retry takes it over.
- Only `Content-Type`, `Location` and `API-Version` are replayed. `Set-Cookie`/`Authorization` are never stored, and body fields named like `token`/`secret`/`authorization` are redacted before storage.

**Frontend:** create the key when the user starts the action, and reuse it across React Query retries:

```ts
const key = crypto.randomUUID();             // once per logical action, e.g. per click
useMutation({
  mutationKey: ['copy-trade', key],
  mutationFn: (vars) =>
    api.post('/trade/copy', vars, { headers: { 'Idempotency-Key': key } }),
  retry: 3,                                  // retries reuse the same key
});
```

## Endpoints

### Health

`GET /livez` → `{ status: "alive" }`. Process health only (event-loop delay, fatal flag); never touches a dependency, so an outage cannot restart every instance. `503 NOT_ALIVE` when the loop is stalled.

`GET /readyz` → `200 { status: "ready", checks }` when every critical dependency is up, `503 NOT_READY` with `status: "not_ready"` otherwise, or `status: "draining"` once shutdown has begun. Each check is `{ name, ok, critical, latencyMs, error? }` for `database`, `redis`, `rpc` and `indexer`; `error` is one of `timeout`, `connection_refused`, `rpc_unhealthy`, `lagging`, `unavailable`. Probes time out after `HEALTH_PROBE_TIMEOUT_MS`, results are cached for `HEALTH_CACHE_TTL_MS` (failures for 500 ms) and concurrent calls share one run. `HEALTH_CRITICAL` (default `database,redis`) picks which dependencies fail readiness. Both endpoints bypass the rate limiter.

`GET /health` → `{ status: "healthy", uptime: number }`. Deprecated: it sends `Deprecation: true` and `Link: </readyz>; rel="successor-version"`.

`GET /api/v1/admin/status` (admin JWT) → probe details with latencies, indexer cursor vs RPC latest ledger and lag, last success/failure per cron job (in memory, reset on restart), chain execution mode, agent public key, LLM provider configuration and Gemini breaker state, and process info.

### Auth (signed challenge, SEP-10 style)

The old `POST /auth/connect` issued a JWT for any address it was handed, so
anyone could log in as anyone. **It is removed.**

**Why a challenge transaction rather than a signed message:** every Stellar
wallet can `signTransaction`. `signMessage` (SEP-53) isn't universal: in
`@creit.tech/stellar-wallets-kit` 2.5.0 the Ledger, Trezor, Albedo, Bitget,
Klever and OneKey modules throw or report it unsupported. The challenge is
built and verified with `WebAuth.buildChallengeTx` /
`readChallengeTx` / `verifyChallengeTxSigners` from `@stellar/stellar-sdk`
16.3. It is a transaction with sequence number 0 that can never be submitted
to the network; signing it proves control of the key and spends nothing.

#### `POST /auth/challenge`

Rate-limited. Request:

```json
{ "address": "GABC…" }
```

`address` must pass `StrKey.isValidEd25519PublicKey`.

Response `200`:

```json
{
  "transaction": "<base64 TransactionEnvelope XDR>",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "expiresAt": "2026-10-07T15:05:00.000Z"
}
```

The challenge is stored in Redis under its transaction hash with a 300 s TTL.

Errors: `400 INVALID_ADDRESS`, `429 RATE_LIMITED`.

#### `POST /auth/verify`

Rate-limited. Request:

```json
{ "address": "GABC…", "signed": "<base64 XDR signed by the wallet>" }
```

The server checks, in order:

1. `readChallengeTx` passes: signed by the server key, time bounds still
   valid, home domain and web-auth domain match.
2. The challenge's client account equals `address`.
3. The challenge exists in Redis and is deleted atomically (`GETDEL`), so a
   challenge works once. It's consumed even if a later check fails.
4. `verifyChallengeTxSigners(..., [address], ...)` returns exactly
   `[address]`.

Response `200`:

```json
{ "token": "<jwt>", "userId": "<uuid>", "walletAddress": "GABC…" }
```

Errors: `400 INVALID_ADDRESS`, `400 INVALID_CHALLENGE` (malformed XDR),
`401 CHALLENGE_EXPIRED`, `401 CHALLENGE_NOT_FOUND` (unknown or already
used), `401 CHALLENGE_SIGNATURE_INVALID` (wrong signer, missing signature,
address mismatch).

Multisig accounts: only a signature from `address`'s own key is accepted.
Threshold-based SEP-10 verification is a backlog item.

### Markets

#### Market object

```json
{
  "id": "uuid",
  "question": "Will …?",
  "category": "CRYPTO",
  "contractCategory": "Crypto",
  "status": "ACTIVE",
  "settlementCurrency": "USDC",
  "initialYesProb": 0.62,
  "currentYesProb": 0.64,
  "confidenceInterval": { "lower": 0.55, "upper": 0.7 },
  "totalLiquidity": 150,
  "seedAmountRaw": "1500000000",
  "expiryTimestamp": "2026-11-01T00:00:00.000Z",
  "onChainMarketId": "0",
  "creationTxHash": "a1b2…",
  "questionHash": "64-hex",
  "metaUri": "ipfs://bafy…",
  "resolutionHash": "64-hex",
  "resolutionSpec": { "kind": "signers", "threshold": 1, "disputeWindow": 3600, "signers": ["G…"] },
  "createdAt": "…",
  "marketUrl": null,
  "_count": { "trades": 0, "reasoningTraces": 1, "positions": 0 }
}
```

`onChainAddress` (Arc) is removed. Prices, reserves and on-chain status come
from market-core; the frontend reads them directly with
`get_market(onChainMarketId)`. `currentYesProb` and `totalLiquidity` are the
backend's cached display values and can lag the chain.

`resolutionSpec` is the revealed preimage of `resolutionHash` (ADR 0001).
Publishing it doesn't weaken the commitment: the hash was fixed on-chain
before trading, so the spec can't change, and anyone may reveal it to the
resolver.

#### `GET /markets`

Query: `status` (`PENDING|ACTIVE|RESOLVING|RESOLVED|CANCELLED`), `category`
(backend category), `currency` (`USDC`), `onChain` (`true` → only markets
with an `onChainMarketId`), `page`, `limit` (≤ 100).
Response: `Market[]`, pagination in `meta`.

#### `GET /markets/:id`

`:id` is the backend UUID. Response: `Market` plus up to 5 `reasoningTraces`
previews `{ id, agentType, edge, probabilityEstimate, verified, onChainTraceId, createdAt }`.
`404 MARKET_NOT_FOUND`.

#### `GET /markets/on-chain/:onChainMarketId`

Looks up the backend record for a market-core id. Same response as
`GET /markets/:id`. `400 INVALID_MARKET_ID` unless it's a decimal `u64`
string; `404 MARKET_NOT_FOUND`.

#### `GET /markets/on-chain/:onChainMarketId/state`

`market_core.get_market` read live from the network (no database), plus
`yesBps` from the contract's FPMM math:

```json
{
  "onChainMarketId": "0",
  "category": "Macro",
  "close_time": "1789998457",
  "creator": "C…",
  "fee_bps": 100,
  "fees_accrued": "1000000",
  "lp_claimed": false,
  "meta_uri": "ipfs://…",
  "question_hash": "64-hex",
  "reserve_no": "1599000000",
  "reserve_yes": "1407129456",
  "resolution_hash": "64-hex",
  "sets_minted": "1599000000",
  "status": { "tag": "Resolved", "outcome": "Yes" },
  "yesBps": 5319,
  "source": "chain"
}
```

`502 CHAIN_ERROR` with `details.contractError: "MarketNotFound"` for an
unknown id.

#### `POST /markets/generate` (auth, admin, rate-limited)

Starts one market-maker cycle in the background. Admin means the JWT's
`walletAddress` is in the server's `ADMIN_ADDRESSES` allowlist; the frontend
check is only a UI gate.

Request (all optional; the current agent ignores them and picks a topic from
live signals, which is recorded as a backlog item):

```json
{ "question": "…", "category": "CRYPTO", "expiry": "2026-11-01" }
```

Response `202`: `{ jobId, message, statusUrl, hint }`.
Errors: `403 FORBIDDEN` (not an admin), `429 RATE_LIMITED`.

#### `GET /markets/generation-status/:jobId` (auth)

Response: `{ jobId, status: "RUNNING"|"COMPLETED"|"FAILED"|"UNKNOWN", startedAt, completedAt, elapsedMs, marketId?, onChainMarketId?, question?, category?, marketUrl?, error? }`.

In `dry-run` mode a completed job has `onChainMarketId: null`: the creation
was simulated, not submitted.

### Reasoning traces

#### Trace object

```json
{
  "id": "uuid",
  "marketId": "uuid",
  "onChainMarketId": "0",
  "agentType": "MARKET_MAKER",
  "decisionType": "MARKET_CREATION",
  "edge": 0.12,
  "probabilityEstimate": 0.62,
  "marketProbability": 0.5,
  "confidenceInterval": { "lower": 0.55, "upper": 0.7 },
  "verified": true,
  "audit": { "status": "VERIFIED", "checkedAt": "…" },
  "ipfsCid": "bafy…",
  "traceHash": "64-hex",
  "onChainTraceId": "3",
  "publishTxHash": "…",
  "previewSources": [{ "source": "FRED", "weight": 0.9, "signal": "…" }],
  "market": { "question": "…", "category": "CRYPTO", "settlementCurrency": "USDC" },
  "createdAt": "…"
}
```

`traceHash` is the sha256 of the exact bytes pinned to IPFS (renamed from
`sha256Hash`, which hashed a re-serialised object). `verified` is the
backend's last check against reasoning-registry. The frontend must still run
its own check before rendering content (see `docs/frontend-integration.md` in
the contracts repo).

#### Provenance (`oracledesk.trace.provenance/1`)

Every trace pinned after #66 carries a `provenance` block, both in the pinned
document (so it is part of the bytes `traceHash` commits to) and in the
`ReasoningTrace.provenance` column. `Market.generationProvenance` holds the
entry for the call that proposed the market.

```json
{
  "schema": "oracledesk.trace.provenance/1",
  "llm": [
    {
      "source": "llm",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "promptId": "market-proposal",
      "promptVersion": 1,
      "promptHash": "64-hex",
      "params": { "temperature": 0.2, "maxTokens": 4096 },
      "usage": { "inputTokens": 1412, "outputTokens": 231 },
      "latencyMs": 2310,
      "attempts": 1,
      "outputSha256": "64-hex"
    },
    { "source": "default", "promptId": "hedge-conditions", "promptVersion": 1, "reason": "LLM_FAILED" }
  ],
  "generator": { "service": "oracledesk-backend", "version": "1.0.0", "commit": "abc1234" }
}
```

| Field | Meaning |
|---|---|
| `schema` | Version string of this block. Check it before reading the rest. |
| `llm[]` | One entry per generation step, in order: the market proposal (creation traces only), then the hedge conditions. |
| `source` | `llm`: a model produced the output. `default`: a hard-coded safe default was used (`reason` is `LLM_FAILED` or `LLM_BUDGET_EXCEEDED`); such an entry has no model fields. |
| `provider`, `model` | Who answered. When Gemini served the call, `fallbackFrom` names the provider that failed first. |
| `promptId`, `promptVersion`, `promptHash` | The registered prompt (`src/lib/prompts`). `promptHash = sha256(canonicalJson({ id, version, system, user }))` over the *template*, not the rendered text. `adhoc`/`0` marks a call that did not use the registry. |
| `params` | Sampling temperature and the `max_tokens` the serving provider was finally given. |
| `usage` | Tokens summed over the serving provider's requests; `null` when the SDK reported none. |
| `latencyMs` | Wall time of the whole call, fallback and repair rounds included. Differs on every run. |
| `attempts` | Provider requests made, repair rounds and Gemini 429 retries included. |
| `fallbackFrom` | `{ provider, model, errorClass }`; `errorClass` is one of `validation`, `rate_limited`, `timeout`, `auth`, `circuit_open`, `budget`, `unavailable`, `server_error`, `error`. Provider messages are never recorded. |
| `outputSha256` | sha256 of the raw model output (canonical JSON of the tool input for Anthropic, the response text for Gemini). Raw prompts and outputs are never stored. |
| `generator` | The service and its `package.json` version; `commit` appears when `GIT_SHA` is set. |

The block is optional: traces created before #66 have none, and consumers must
treat it as absent. Readers must also ignore unknown keys.

`GET /traces/:id` returns the full block with access. Without access, and in
`GET /traces`, `provenance` is reduced to
`{ "summary": { "providers": ["anthropic"], "promptVersions": ["hedge-conditions@1", "market-proposal@1"], "source": "llm" | "default" | "mixed" } }`
(`summary` is `null` for traces without provenance).

The payload's former `llm: { provider, model }` field is replaced by this block.

#### `GET /traces`

Query: `agentType`, `marketId`, `page`, `limit`. Response: preview traces,
pagination in `meta`.

#### `GET /traces/:id` (optional auth)

Without access: the preview (first two sources) plus
`{ accessLevel: "FREE_PREVIEW", lockedFields, unlockPriceRaw, dailyPassPriceRaw }`.
With a daily pass: the full trace and `accessLevel: "DAILY_PASS"`.
(Previously the route never read the token, so subscribers always got the
preview. Fixed.)

#### `POST /traces/verify` (auth)

Request `{ "traceId": "uuid" }`. The server reads
`reasoning_registry.get_trace(onChainTraceId)`, fetches `ipfs_cid` through the
gateway, hashes the exact bytes and compares them with the on-chain
`trace_hash` (same check as `x402/trace-verification.ts`).

Response:

```json
{
  "traceId": "uuid",
  "onChainTraceId": "3",
  "ipfsCid": "bafy…",
  "onChainHash": "64-hex",
  "computedHash": "64-hex",
  "storedHash": "64-hex",
  "verified": true,
  "verifiedAt": "…"
}
```

Errors: `404 TRACE_NOT_FOUND`, `409 TRACE_NOT_PUBLISHED` (no on-chain trace
id yet), `502 IPFS_RETRIEVAL_FAILED`, `502 CHAIN_READ_FAILED`.

#### `POST /traces/:id/unlock` (auth)

Daily pass only. Per-trace unlocks go through x402 (below).

Request:

```json
{ "txHash": "64-hex", "amountRaw": "5000000", "type": "DAILY_PASS" }
```

`amount` (a float) is still accepted for one release and converted with
7-decimal string maths; `amountRaw` wins when both are present. The amount is
informational: the server uses what the transaction actually moved.

The server calls Stellar RPC `getTransaction(txHash)` and grants access only
if **all** of these hold:

1. `status === "SUCCESS"`.
2. The transaction's single operation is `invokeHostFunction` →
   `invokeContract` on `USDC_CONTRACT_ID` with function `transfer`.
3. Arg 0 (`from`) equals the JWT's `walletAddress`.
4. Arg 1 (`to`) equals `PAYMENTS_RECIPIENT`.
5. Arg 2 (`amount`, i128) ≥ the tier price in base units
   (`DAILY_PASS_PRICE_RAW`, default `5000000` = 0.50 USDC).
6. The hash hasn't been used before (unique `txHash` on `PaymentEvent`).

There is no development bypass: an unverifiable payment never grants
access. Tests inject a fake RPC client.

Response `201`: `{ subscription, trace }`.
Errors: `400 VALIDATION_ERROR`, `402 PAYMENT_NOT_FOUND`,
`402 PAYMENT_FAILED`, `402 PAYMENT_WRONG_TOKEN`, `402 PAYMENT_WRONG_SENDER`,
`402 PAYMENT_WRONG_RECIPIENT`, `402 PAYMENT_INSUFFICIENT`,
`409 PAYMENT_ALREADY_USED`, `402 ALLOWANCE_DAILY_LIMIT`.

> **Product decision for a human:** `PAYMENTS_RECIPIENT` defaults to the
> treasury contract. The treasury's trading capital *is* its USDC balance,
> so subscription revenue would become agent trading capital. A separate
> revenue account is probably wanted. This is flagged in `docs/STATUS.md`
> and not decided here.

#### `GET /traces/access/allowance`, `PUT /traces/access/allowance` (auth)

Unchanged. `PUT` body `{ dailyLimit: number, perTraceLimit: number, currency?: "USDC" }`
(display USDC). Response: `SpendingAllowance | null`.

#### `GET /traces/payments` (auth)

The user's last 100 `PaymentEvent`s, newest first.

### Agent calibration (#68)

Are the agents' probabilities calibrated? When an agent says 70 %, does YES
happen about 70 % of the time? A daily job joins resolved markets with the
traces written before resolution and stores metrics per slice.

#### `GET /agents/calibration` (public)

Query (all optional): `window` (`30d`, `90d`, `all`; default `90d`),
`groupBy` (`agentType`, `category`, `decisionType`, `promptVersion`, `model`,
`agentType_category`; default `agentType`), `agentType` (`MARKET_MAKER` or
`TRADER`) and `category`. The two filters only apply to the groupings that
contain them (`agentType`, `category`, `agentType_category`); otherwise `400
VALIDATION_ERROR`. The response carries `Cache-Control: public, max-age=300`.

```json
{
  "window": "90d",
  "groupBy": "agentType",
  "computedAt": "2026-10-18T03:10:00.000Z",
  "minCalibrationMarkets": 20,
  "weighting": "time",
  "slices": [
    {
      "groupKey": "TRADER",
      "insufficientData": false,
      "nMarkets": 61, "nTraces": 140, "nEff": 48.3,
      "brier": 0.21, "logLoss": 0.61, "clipped": 0,
      "buckets": [{ "lower": 0.6, "upper": 0.7, "count": 7.4, "nEff": 6.1, "meanPredicted": 0.64, "observed": 0.57, "wilson95": { "lower": 0.28, "upper": 0.82 } }],
      "quantileBuckets": ["…"],
      "murphy": { "reliability": 0.012, "resolution": 0.018, "uncertainty": 0.249 },
      "baseline": { "brier": 0.23, "agentBrier": 0.21, "nTraces": 140, "meaningful": true, "note": "…" },
      "shrinkageK": 0.84
    },
    { "groupKey": "MARKET_MAKER", "insufficientData": true, "nMarkets": 4, "nTraces": 4, "nEff": 4 }
  ]
}
```

`computedAt` is `null` and `slices` empty until the first snapshot exists.

| Metric | Definition |
|---|---|
| `brier` | Weighted mean of `(p − o)²`, `o` = 1 for YES. Lower is better; 0.25 is "always say 50 %". |
| `logLoss` | Weighted mean of `−ln(p_outcome)` with `p` clipped to `[1e-4, 1 − 1e-4]`; `clipped` counts the samples that were clipped. |
| `buckets` | Ten equal-width bins by predicted probability: `count` (weight), `meanPredicted`, `observed` frequency and a Wilson 95 % interval computed at the bucket's effective sample size. `quantileBuckets` are ten equal-weight bins. Empty bins have `null` fields. |
| `murphy` | Murphy (1973) decomposition: Brier ≈ `reliability − resolution + uncertainty`. Small reliability = calibrated; large resolution = the forecasts separate outcomes; uncertainty is the base-rate variance. |
| `baseline` | The market's own Brier (`marketProbability` at trace time) on the same traces, next to the agent's Brier on them, so skill versus the market is visible. `MARKET_CREATION` traces are left out: their `marketProbability: 0.5` is a placeholder, not a price. `null` when no trace has a market price. |
| `nMarkets`, `nTraces`, `nEff` | Resolved markets and traces in the slice; `nEff = (Σw)² / Σw²` after weighting. |
| `shrinkageK` | Least-squares factor `k` in `p′ = 0.5 + k (p − 0.5)`, bounded to `[0.3, 1]`. |

**Weighting.** Each market has total weight 1 in a slice, so a market with
fifty trader traces cannot outvote one with a single trace. `time` (default,
`CALIBRATION_WEIGHTING`) weights a trace by how long its estimate was current,
until the next trace in the slice or `resolvedAt`; `last` keeps only the final
trace and `first` only the first.

**Exclusions.** Voided markets (`CANCELLED`, `resolvedOutcome` null) are
dropped entirely, because counting them as NO would bias every figure. Traces
created at or after `resolvedAt` are dropped, since they could know the
outcome. Only markets with an `onChainMarketId` are counted, i.e. resolved
through the indexer; legacy rows resolved by other means are ignored.

**Minimum sample.** A slice with fewer than `MIN_CALIBRATION_MARKETS` (default
20) resolved markets returns `insufficientData: true` and its counts, with no
metrics. The trader additionally requires 50 markets before it uses a fitted
`k` other than 1.

**Slices by prompt and model** read the first entry of the trace's
`provenance.llm` (see the provenance block above); traces without provenance
fall under `unknown`.

#### `POST /agents/calibration/recompute` (auth, admin)

Runs the daily job now and returns `{ computedAt, rows, windows, slices,
insufficient }`. `409 CALIBRATION_IN_PROGRESS` if another instance holds the
advisory lock.

### Per-trace unlock via x402 (not this backend)

**Decision: the frontend calls the contracts repo's `x402/` service
directly** at `NEXT_PUBLIC_X402_URL`. The backend keeps daily-pass
subscriptions only and doesn't proxy x402.

Checked against `x402/trace-api.ts`: the service exposes
`GET /traces/:traceId`, where `:traceId` is the **on-chain** reasoning-registry
id (`onChainTraceId`), behind `@x402/express` `paymentMiddleware` with the
`exact` Stellar scheme. On payment it fetches the IPFS content, checks the
hash against the on-chain record, and returns
`{ traceId, traceHash, content }`. x402 is built so the client pays the
resource server, and a proxy would have to re-sign or forward payment
headers for no benefit.

Not verified: the contracts repo has no known x402-on-Stellar facilitator URL
(its `docs/STATUS.md`), so a full paid round-trip has never run.

### Portfolio

#### `GET /portfolio`

The agent's (treasury's) portfolio. Response:
`{ totalUsdc, deployedCapital, availableCapital, openPositions, totalPnl, dailyPnl, builderFeesEarned, correlationRisk, availableCapitalRaw }`.
`availableCapitalRaw` is `treasury.available_capital()` read live (`null` if
the RPC read fails). The float fields are the DB's view.

#### `GET /portfolio/positions`

Query `status`, `page`, `limit`. Response: `Position[]` with
`market { question, category, settlementCurrency, expiryTimestamp, onChainMarketId }`
and `trade { direction, amount, edgeDetected, kellyFraction, txHash }`.

#### `GET /portfolio/stats`

Platform counts from the database only:
`{ subscriberCount, totalCopyVolume, totalCopyVolumeRaw, builderFees, marketCount, onChainMarketCount, traceCount }`.
`totalCopyVolumeRaw` is the exact base-unit sum of `collateralRaw` for verified `EXECUTED` copy trades as a decimal string.
The version in the unpushed commit `207464d` padded these with constants
(`+1284` subscribers, `+142000` volume); this one doesn't.

### Copy trade

The user signs `market_core.buy` in their own wallet. The backend records
intent and the resulting hash; it never trades for the user.

#### `POST /trade/copy` (auth)

Request `{ traceId: uuid, marketId: uuid, amountRaw: "10000000" }`.
Response:

```json
{
  "copyTradeId": "uuid",
  "expiresAt": "2026-10-17T03:30:00.000Z",
  "transactionPayload": {
    "contractId": "C… (market-core)",
    "onChainMarketId": "0",
    "outcome": "Yes",
    "collateralInRaw": "10000000",
    "userWallet": "G…",
    "traceReference": "bafy…"
  },
  "instructions": "Quote, then sign market_core.buy with min_shares_out from the quote. Then call PATCH /trade/copy/:id/confirm with the transaction hash."
}
```

The direction comes from the trace's edge. The server refuses when there's
no trace, the edge is zero, the market has no `onChainMarketId`
(`409 MARKET_NOT_ON_CHAIN`, `422 NO_EDGE`), or the user has reached the open copy trade
limit (`429 COPY_TRADE_LIMIT_REACHED` when ≥ `COPY_TRADE_MAX_PENDING` open trades exist).
Unconfirmed trades expire after `COPY_TRADE_TTL_MINUTES` (default 30).
`min_shares_out` isn't in the payload because it must come from a quote taken right before signing.

#### `PATCH /trade/copy/:id/confirm` (auth)

Request `{ "txHash": "64-hex" }`.

The backend verifies the transaction on-chain via Stellar RPC:
- Checks that the transaction succeeded.
- Decodes contract events emitted by `CONTRACTS.marketCore`.
- Asserts that a `Trade` event exists for the user's wallet (`trader`), the copy trade's `onChainMarketId`, the requested outcome, and `is_buy: true`.
- Asserts that executed `collateral` does not exceed `amountRaw`.
- Checks the transaction envelope (direct `marketCore.buy` call or smart wallet routing).
- Re-use of a `txHash` across multiple copy trades is forbidden and returns `409 COPY_TRADE_TX_ALREADY_USED`.

If the transaction has not yet been indexed or seen by Stellar RPC, the endpoint returns:
`202 Accepted` with `{ "status": "CONFIRMING", "retryAfterSeconds": 5 }`.
Pending / confirming copy trades are automatically reconciled when the indexer receives the `Trade` event, or during the 5-minute background sweep.

Once confirmed, the copy trade is stored with `status: "EXECUTED"`, and records `collateralRaw`, `sharesRaw`, `feeRaw`, `ledger`, `chainEventId`, and `confirmedAt` directly from the on-chain event.

### Admin (admin auth)

Admin routes require a valid JWT whose `walletAddress` is present in `ADMIN_ADDRESSES`.

#### `GET /admin/trace-audit` (admin)

Returns summary metrics across all trace audits, details of the latest audit run, and paginated non-verified findings.
Query parameters: `page`, `limit`, `status`.

#### `POST /admin/trace-audit/run` (admin)

Schedules a trace audit run asynchronously in the background.
Response `202 Accepted`: `{ "runId": "uuid", "message": "Trace audit run scheduled" }`.

### Oracle / resolution

Outcomes are decided on-chain by the `resolver` contract (Reflector price
specs or signer attestations, then `finalize_*`). **The backend never
decides an outcome.**

- `POST /oracle/resolve` is **removed**. It let any logged-in user resolve
  any market.

#### `GET /oracle/markets/:marketId/resolution`

`:marketId` is the backend UUID. Reads `resolver.state(onChainMarketId)` and
`market_core.get_market(onChainMarketId).status` live:

```json
{
  "marketId": "uuid",
  "onChainMarketId": "0",
  "resolverState": "Unconfigured" ,
  "marketStatus": { "tag": "Resolved", "outcome": "Yes" },
  "resolutionHash": "64-hex",
  "resolutionSpec": { },
  "dbStatus": "RESOLVED"
}
```

`resolverState` is `Unconfigured | SignersPending | Finalized`.
`marketStatus.tag` is `Open | Resolved | Void`. `404 MARKET_NOT_FOUND`,
`409 MARKET_NOT_ON_CHAIN`, `502 CHAIN_READ_FAILED`.


### Treasury admin console (auth, admin)

The backend never holds the treasury admin key. It prepares unsigned,
simulated transactions for the on-chain admin/multisig, verifies the signed
XDR body against the prepared hash, and submits only when the collected
signature weight reaches the account's high threshold. Every state change
writes an `AgentLog` row (`ADMIN_OP_<STATE>`).

#### `GET /admin/treasury`
Returns treasury `RiskConfig`, available capital, USDC balance, daily usage
with headroom/reset time, treasury/market-core paused flags and admins, and
the agent's XLM fee balance. The on-chain admin is read from treasury instance
storage until the contract exposes `admin()`/`is_paused()`.

#### `GET /admin/treasury/operations?page&limit`
Paginated prepared/signed/submitted operations.

#### `POST /admin/treasury/operations`
Body: `{ "operation": { ... }, "force"?: boolean }`, where `operation` is one of:

- `{ "kind": "treasury.set_paused", "paused": true }`
- `{ "kind": "treasury.withdraw", "to": "G…|C…", "amountRaw": "12500000000" }`
- `{ "kind": "treasury.deposit", "from": "G…", "amountRaw": "100000000" }`
- `{ "kind": "treasury.collect_market_fees", "onChainMarketId": "7" }`
- `{ "kind": "market_core.set_paused", "paused": false }`

Returns `{ id, xdr, networkPassphrase, hash, expiresAt, requiredSigners,
thresholds, checks, humanSummary, status }`. Pre-flight failures return
`422 PREFLIGHT_FAILED` with `details.checks`. A `C…` admin returns
`501 UNSUPPORTED_ADMIN_KIND` (auth-entry signing is out of scope).

#### `POST /admin/treasury/operations/:id/signatures`
Body `{ "signedXdr": "…" }`. The envelope hash must equal the stored `txHash`;
new signatures are verified against the admin account's signers, duplicates are
ignored, and `weightCollected` is recomputed. `READY` means the high threshold
(and optional `TREASURY_WITHDRAW_MIN_SIGNERS`) is met.

#### `POST /admin/treasury/operations/:id/submit`
Allowed only in `READY` and before `expiresAt`, testnet only. Sends the
envelope, polls `getTransaction`, and records `SUCCESS`/`FAILED`, ledger and
result XDR. No server key is used.

#### `POST /admin/treasury/operations/:id/record`
Body `{ "txHash": "<64 hex>" }` for clients that submitted themselves.

#### `POST /admin/treasury/operations/:id/cancel`
Cancels a prepared/partially-signed operation.

### Transparency reports

Public, computed only from chain state and `chain_events`; see
`docs/transparency-reports.md`.

#### `GET /reports?page&limit`
Paginated index: `date`, `anchorLedger`, `cid`, `ipfsUri`, `hash`,
`onChainTraceId`, `mode` (`live`/`dry-run`), `consistency`
(`exact`/`best_effort`), the report document, and a verification recipe.

#### `GET /reports/latest`
Most recent report (404 if none yet).

#### `GET /reports/:date`
One report by `YYYY-MM-DD` (400 for a malformed date, 404 if absent).

`GET /portfolio` also includes `latestReport` with the same metadata.

### `POST /traces/verify` content source

The response now includes `contentSource: "cache" | "gateway"`: `cache` means
the bytes came from the local verified content store and both gateways could
be down. The on-chain `trace_hash` remains the authority.

## Realtime (socket.io)

Same origin as the API without `/api/v1`. The frontend listens to these
events; event names are unchanged.

**Finding:** before this port the backend never emitted either event (there
is no `io.emit` anywhere in `src/`), so these listeners received nothing. The
indexer now emits them.

### `TRADE_EXECUTED`

Emitted when the indexer stores a market-core `trade` event.

```json
{
  "onChainMarketId": "0",
  "marketId": "uuid or null",
  "marketQuestion": "… or null",
  "trader": "G…",
  "direction": "YES",
  "isBuy": true,
  "collateralRaw": "10000000",
  "sharesRaw": "15873015",
  "feeRaw": "200000",
  "priceYesBps": 6421,
  "txHash": "64-hex",
  "ledger": 123456,
  "eventId": "0000…-0000000001"
}
```

The old payload had `amount` (float USDC), `price` (0–1) and `probChange`
(string). Frontends derive display values from `collateralRaw` and
`priceYesBps`.

> A trace's `verified` flag means its `trace_hash` was confirmed on-chain: set
> by the indexer when it sees the matching `TracePublished` event (or by
> `POST /traces/verify`), never from a write result alone and never in dry-run.

### `REASONING_PUBLISHED`

Emitted when the indexer stores a reasoning-registry publish event.
`action` is one of the backend's `create_market`, `buy_yes`, `buy_no`
(`src/lib/trace-actions.ts`); traces published by other agents may use other
strings, such as `buy` from the contracts repo's TypeScript agents.

```json
{
  "onChainTraceId": "3",
  "onChainMarketId": "0",
  "traceId": "uuid or null",
  "agent": "G…",
  "action": "buy_yes",
  "ipfsCid": "bafy…",
  "traceHash": "64-hex",
  "txHash": "64-hex",
  "ledger": 123456
}
```

## Frontend call map

Every call in the frontend's `lib/api/*.ts` and where it lands:

| Frontend function | Endpoint |
|---|---|
| `requestChallenge` / `verifyChallenge` (`auth.ts`) | `POST /auth/challenge`, `POST /auth/verify` |
| ~~`connectWalletToBackend`~~ | ~~`POST /auth/connect`~~ (removed) |
| `listMarkets` | `GET /markets` |
| `getMarket` | `GET /markets/:id` |
| `getMarketByOnChainId` | `GET /markets/on-chain/:onChainMarketId` |
| `triggerMarketGeneration` | `POST /markets/generate` |
| `getMarketGenerationStatus` | `GET /markets/generation-status/:jobId` |
| `getPortfolio` | `GET /portfolio` |
| `getPositions` | `GET /portfolio/positions` |
| `getPlatformStats` | `GET /portfolio/stats` |
| `initiateCopyTrade` | `POST /trade/copy` |
| `confirmCopyTrade` | `PATCH /trade/copy/:id/confirm` |
| `listTraces` | `GET /traces` |
| `getTrace` | `GET /traces/:id` |
| `verifyTrace` | `POST /traces/verify` |
| `unlockTrace` | `POST /traces/:id/unlock` (daily pass) |
| `getSpendingAllowance` / `setSpendingAllowance` | `GET` / `PUT /traces/access/allowance` |
| `getPaymentEvents` | `GET /traces/payments` |
| `getResolution` | `GET /oracle/markets/:marketId/resolution` |
| per-trace unlock | x402 `GET {X402_URL}/traces/:onChainTraceId` |
