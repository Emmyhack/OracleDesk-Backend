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

`resolutionDetails` (nullable) is the resolvability block pinned in question
document v2 (below); `null` for markets created before #74.

#### Question document (pinned to IPFS, `questionHash = sha256(bytes)`)

`metaUri` points at the canonical JSON the market was created with. The hash
covers the exact pinned bytes, so a v1 document stays verifiable forever.

- **v1**: `{ version: 1, question, category, contractCategory, closeTime, resolutionSource, resolutionHash, backendMarketId }`.
- **v2** (#74): the same fields with `version: 2` plus a `resolution` block,
  emitted when the market has `resolutionDetails`:

```json
{
  "version": 2,
  "question": "Will CPI for September 2026 exceed 3%?",
  "closeTime": 1792207199,
  "resolutionSource": "BLS",
  "resolution": {
    "sourceId": "BLS",
    "url": "https://www.bls.gov/news.release/",
    "measurable": "CPI",
    "comparator": ">",
    "threshold": { "value": 3, "unit": "%", "text": "3%" },
    "deadlineUtc": "2026-10-01T03:59:59.000Z",
    "instructions": "Use the first release of the BLS news release … Deadline: 2026-09-30 23:59:59 (America/New_York) = 2026-10-01T03:59:59.000Z. Resolve on the first published value."
  }
}
```

`sourceId` is one of `FRED, BLS, ECB, AP_ELECTIONS, AP_POLITICS, ESPN, BILLBOARD, OPEC, CHAINLINK`.
`comparator` and `threshold` are `null` when the question has none. `deadlineUtc`
is the event deadline (end of day in the source's zone, a data period's end, or a
meeting announcement); `closeTime` is later by the source's publication lag.
**Readers must ignore unknown fields.** `resolutionSource` stays for compatibility.

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
Errors: `403 FORBIDDEN` (not an admin), `423 AGENT_PAUSED` (the market maker or ALL
is paused; no job is started), `429 RATE_LIMITED`.

A cycle drops a proposal whose deadline, close time and source don't fit
(`PROPOSAL_UNRESOLVABLE` agent log with reason codes) and repairs a close time
that is merely off (`PROPOSAL_EXPIRY_REPAIRED`); see `docs/architecture.md`.

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
`market { question, category, settlementCurrency, expiryTimestamp, onChainMarketId }`,
`trade { direction, amount, edgeDetected, kellyFraction, txHash }` and `lastExit`
(the newest `PositionExit`: `status`, `reason`, `mode`, `sharesSoldRaw`,
`collateralOutRaw`, `effectivePrice`, `txHash`, `error`, `createdAt`, or `null`).

Positions are denominated in **shares** (#77/#78). Raw fields are base-unit
decimal strings (7-decimal USDC, `NUMERIC(39,0)`), never floats:

| Field | Meaning |
|---|---|
| `sharesRaw` | Outcome shares still held, from `agent_buy`'s result (`null`: legacy row, see the backfill script). |
| `costBasisRaw` | Collateral paid for the shares still held. Released pro rata by partial exits. |
| `feesPaidRaw` | Fee paid on the buy (`ceil(collateral_in × fee_bps / 10000)`). |
| `realisedCollateralRaw`, `realisedPnlRaw` | Collateral received and PnL realised by confirmed exits. |
| `markPriceBps` | Mid price of the held outcome, in basis points. |
| `markValueRaw` | **Mid value**: `shares × markPriceBps / 10000`. Overstates what a large position can realise. |
| `liquidationValueRaw` | **Liquidation value**: what selling all shares into the pool returns now (`collateralOutForShares`, fee included, rounded down). `0` with `illiquid: true` if the pool can't absorb the sale. **This drives risk.** |
| `unrealisedPnlRaw` | `liquidationValueRaw − costBasisRaw`. Stop-loss (−15% of cost) and hedge detection (−10%) use it. |
| `markedAt`, `valuationSource` | When and from where the mark came: `indexed` (newest indexed `Trade` event), `rpc` (`get_market`) or `estimated` (backfill). |
| `entryPrice` | Effective price paid per share (`collateralIn / sharesOut`), display only. |
| `currentPrice`, `pnl`, `size` | Float display fields derived from the raw values (`pnl` = realised + unrealised). |

Several open positions in one market are valued by their own shares; selling
them together returns less than the sum because each sale moves the pool.

`GET /portfolio` sums exactly in base units: `deployedCapital` = Σ `costBasisRaw`,
`totalPnl` = Σ (realised + liquidation-based unrealised) plus closed positions.

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

### Agent controls (admin auth, #79)

A persistent kill switch and pause shared by every backend instance. Scopes:
`ALL`, `MARKET_MAKER`, `TRADER`. An agent is paused when its own row or `ALL`
is. Both agent cycles check at their start, and every chain write
(`agent_create_market`, `agent_buy`, `agent_sell`, `publish_trace`) checks
before building the transaction and again, under a share lock, right after
simulation and before signing. A pause committed after that lock is released
cannot stop a transaction already handed to RPC. Checks fail closed: if the
control table can't be read the agent does not run (`503 AGENT_CONTROL_UNAVAILABLE`).

Automatic pauses (`source`): `drawdown` (TRADER, 4 h, "today" is the UTC day),
`chain_paused` (ALL; market-core `get_config().paused` or a `Paused` contract
error; cleared by an operator or when the re-check shows market-core unpaused),
`failure_breaker` (the writing agent; `AGENT_FAILURE_THRESHOLD` failures within
`AGENT_FAILURE_WINDOW_MS`; risk-cap rejections don't count; needs an operator
resume). An operator pause (`source: operator`, no `until`) is never shortened
or cleared by a timed pause.

#### `GET /admin/agents/controls` (admin)

`{ scopes: [{ scope, paused, own: { paused, reason, source, pausedUntil, pausedBy, version } }], events }`
with the last 20 audit events.

#### `POST /admin/agents/:agent/pause` (admin)

`:agent` is `ALL | MARKET_MAKER | TRADER`. Body `{ reason: string (5..500), until?: ISO datetime }`.
Without `until` the pause lasts until an operator resumes. Returns the same
body as `GET /admin/agents/controls`. `400 VALIDATION_ERROR` for a bad body,
agent or past `until`.

#### `POST /admin/agents/:agent/resume` (admin)

Body `{ reason?: string }`. Clears only the named row: resuming `TRADER` does not
clear an `ALL` pause. Every pause, resume and automatic expiry writes an
`agent_control_events` row (`before`, `after`, `actor`, `source`).

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

### `AGENT_CONTROL_CHANGED`

Emitted when a pause is set, a pause is lifted or a timed pause expires.

```json
{ "scope": "TRADER", "paused": true, "reason": "Daily drawdown 3.10% reached the 3% limit", "until": "2026-10-18T16:00:00.000Z" }
```

`until` is `null` for indefinite pauses and for resumes.

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
