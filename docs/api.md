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
`POST /auth/verify` (or `POST /auth/contract/verify` for a `C…` smart wallet)
and lasts 7 days. A contract session carries `accountType: "contract"` and is
never treated as an admin. Errors: `401 UNAUTHORIZED`, `401 INVALID_TOKEN`,
`401 TOKEN_EXPIRED` (the frontend clears its session on the last one).

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
| `POST /traces/payment-intents/:id/submit` | optional (idempotent by txHash) |
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

`GET /api/v1/admin/chain/spec-compat` (admin JWT) → `{ mode, report }`: the contract spec compatibility report from the boot gate (#34). `report` lists, per contract, the deployed wasm hash against the pinned one and every spec difference with its `breaking`/`compatible` classification; it is `null` when the gate has not run (`SPEC_COMPAT_ENFORCE=off`). See "Contract compatibility" in `docs/architecture.md`.

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
{ "address": "GABC…", "memo": "42" }
```

`address` must be a Stellar G… public key (or an M… muxed address, see below).
`memo` is optional and, when present, must be an unsigned 64-bit decimal
string (id `0` and `18446744073709551615` are valid).

Login identities (#46): a plain `G…` account, a `G…` account with an id
`memo`, or an `M…` muxed address (SEP-23). Muxed logins carry the sub-identity
inside the address and must not send a `memo`. The signature always comes from
the base `G…` key; the server binds the sub-identity into the challenge and
stores it with the challenge.

Response `200`:

```json
{
  "transaction": "<base64 TransactionEnvelope XDR>",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "expiresAt": "2026-10-07T15:05:00.000Z"
}
```

The challenge is stored in Redis under its transaction hash with a 300 s TTL
(`AUTH_CHALLENGE_TTL_SECONDS`). At most `AUTH_MAX_OUTSTANDING_PER_ADDRESS`
unused challenges per address and `AUTH_MAX_OUTSTANDING_PER_IP` per network may
be outstanding at once (#50).

Errors: `400 INVALID_ADDRESS`, `400 INVALID_MEMO` (bad id, or a memo combined
with an `M…` address), `429 RATE_LIMITED`, `429 AUTH_IP_LIMIT`.

#### `GET /auth/challenge/pow`

Returns a single-use proof-of-work salt:

```json
{ "salt": "…", "bits": 18, "expiresAt": "2026-10-07T15:05:00.000Z" }
```

When more than `AUTH_POW_THRESHOLD_PER_MIN` challenges are issued in one minute,
`POST /auth/challenge` answers `429 POW_REQUIRED` and returns a fresh `salt` and
the required `bits`. The client must find a `nonce` such that
`SHA-256(address || ":" || nonce || ":" || salt)` starts with `bits` zero bits,
then retry with `{"pow": {"nonce": "…", "salt": "…"}}`. The salt is consumed on
use. Errors: `429 POW_REQUIRED`, `429 POW_INVALID`.

#### `POST /auth/verify`

Rate-limited. Request:

```json
{ "address": "GABC…", "signed": "<base64 XDR signed by the wallet>", "memo": "42" }
```

The same `address` (and `memo`, if the login was a `G…`-with-memo identity)
that was sent to `/auth/challenge` must be repeated here.

The server checks, in order:

1. The challenge exists in Redis and is deleted atomically (`GETDEL`), so a
   challenge works once. It's consumed even if a later check fails, and the
   record names the key that issued it.
2. That issuing key is still trusted (#48): the current `AUTH_SIGNING_SECRET`
   or a key in `AUTH_PREVIOUS_SIGNING_KEYS` that has not passed its retirement
   time. An unknown or retired key is `401 INVALID_CHALLENGE`.
3. `readChallengeTx` passes with that key: signed by the issuer, time bounds
   still valid, home domain and web-auth domain match.
4. The challenge's client account and memo match the requested identity.
5. `verifyChallengeTxSigners(..., [baseAccount], ...)` returns exactly
   `[baseAccount]`.

Response `200`:

```json
{ "token": "<jwt>", "userId": "<uuid>", "walletAddress": "GABC…" }
```

`walletAddress` is the base `G…` account (never the `M…`/memo identity). The
JWT also carries `account`, and `subId`/`subIdKind` (`MUXED` or `MEMO`) for a
sub-identity.

Errors: `400 INVALID_ADDRESS`, `400 INVALID_MEMO`, `400 INVALID_CHALLENGE`
(malformed XDR), `401 CHALLENGE_EXPIRED`, `401 CHALLENGE_NOT_FOUND` (unknown or
already used), `401 CHALLENGE_SIGNATURE_INVALID` (wrong signer, missing
signature, address or memo mismatch).

Multisig accounts: only a signature from `address`'s own key is accepted.
Threshold-based SEP-10 verification is a backlog item.

#### `POST /auth/refresh` (auth)

Issues a new access token with the same `userId`, `walletAddress` and identity
claims. It **copies** `auth_time` from the presented token, so a refresh never
resets the wallet-proof age used by admin step-up (#49). Response:
`{ token, userId, walletAddress }`. Errors: `401 UNAUTHORIZED`,
`401 TOKEN_EXPIRED`, `401 INVALID_TOKEN`.

### Auth for contract accounts (SEP-45, #47)

A smart-wallet account is a `C…` contract, not a `G…` key, so the SEP-10
challenge does not apply. When `SEP45_ENABLED=true`, contract accounts log in
with SEP-45 authorization entries. The JWT carries `accountType: "contract"` and
such a token is never treated as an admin.

#### `GET /auth/contract/challenge?account=C…&home_domain=…`

`account` must be a `C…` contract address. `home_domain`, when present, must
match `AUTH_HOME_DOMAIN`. Response `200`:

```json
{
  "authorization_entries": "<base64 SorobanAuthorizationEntries XDR>",
  "network_passphrase": "Test SDF Network ; September 2015",
  "expires_at": "2026-10-07T15:05:00.000Z"
}
```

The XDR contains two entries for `web_auth_verify` on `WEB_AUTH_CONTRACT_ID`
with the same argument map (`account`, `home_domain`, `web_auth_domain`,
`web_auth_domain_account`, `nonce`): an unsigned client entry (empty signature)
and the server's own entry, already signed by `AUTH_SIGNING_SECRET`. The nonce
is stored for 300 s and is single-use.

Errors: `503 SEP45_UNAVAILABLE` (feature off), `400 INVALID_ADDRESS`,
`400 INVALID_HOME_DOMAIN`.

#### `POST /auth/contract/verify`

```json
{ "authorization_entries": "<base64 XDR signed by the wallet>" }
```

The server decodes the entries, requires exactly one server and one client
entry with identical arguments, verifies the server's ed25519 signature, spends
the nonce (`GETDEL`), checks the expirations, and simulates the
`web_auth_verify` invocation in `enforce` auth mode. Only a successful
simulation issues a JWT:

```json
{ "token": "<jwt>", "userId": "<uuid>", "walletAddress": "C…" }
```

Errors: `400 INVALID_CHALLENGE` (bad base64/XDR or oversized),
`401 CHALLENGE_NOT_FOUND`, `401 CHALLENGE_EXPIRED`,
`401 CHALLENGE_SIGNATURE_INVALID` (bad server signature, mismatched arguments,
or the contract rejected the authorization), `503 AUTH_UNAVAILABLE` /
`503 SEP45_UNAVAILABLE`.

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
  "seedPolicy": { "seedRaw": "1500000000", "initialYesBps": 6200, "pAdj": 0.62, "expectedLpLossRaw": "180000000", "binding": "LP_LOSS_BUDGET", "inputs": { "…": "…" } },
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

**Seed and opening price (#82).** `seedAmountRaw` is the treasury capital
(7-decimal base units, decimal string) that `treasury.agent_create_market` put
into the pool; the treasury is the market's LP. It is not the LLM's
`minimum_liquidity_usdc` any more: that number is advisory, and the seed policy
(`seed-policy.service.ts`) derives the seed from the category, time to close,
the confidence interval and the treasury's headroom, then records how in
`seedPolicy` (`null` for markets created before the policy or by admin tooling):
`seedRaw`, `initialYesBps`, `pAdj`, the `expectedLpLossRaw` (what an informed
trader who pushes the price to the farthest edge of the confidence interval
would cost the LP), the `binding` bound (`BASE`, `MAX_TRADE`, `MAX_MARKET`,
`MM_DAILY_SHARE`, `DAILY_HEADROOM`, `AVAILABLE_FRACTION`, `AGGREGATE_CAP` or
`LP_LOSS_BUDGET`) and every input and bound.

`initialYesProb` is the price the market **opened at**, not the model's raw
estimate: the estimate is shrunk toward 0.5 in proportion to the width of its
confidence interval, `pAdj = 0.5 + (p − 0.5)(1 − w·0.5)` with
`w = clamp(width / 0.6, 0, 1)`, so uncertain proposals do not open at confident
prices. It equals `initial_yes_bps / 10000` on chain, and it is what the
pinned question document and the creation trace's `marketProbability` carry. The
model's own estimate stays in the creation trace as `probabilityEstimate`.
When the treasury budget does not allow at least the on-chain minimum seed
(100 USDC), no market is created at all: nothing is written to the database or
pinned to IPFS, and the market maker logs `SEED_SKIPPED` with the reason.

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
  "previewSources": [{ "source": "NEWSAPI", "publisher": "Reuters", "signal": "…" }],
  "market": { "question": "…", "category": "CRYPTO", "settlementCurrency": "USDC" },
  "createdAt": "…"
}
```

`previewSources` names the source, publisher and headline only (#73). Traces
created before #73 carry `{ source, weight, signal }` instead. The full trace
(paid) lists `sourcesUsed`; entries written since #73 also carry the evidence's
`signalId`, `url`, `publisher` and `publishedAt`, and `weight` is its relevance
score. Treat all four as optional when reading older traces:

```json
{ "source": "NEWSAPI", "weight": 0.8812, "signal": "Federal Reserve holds rates steady…",
  "signalId": "uuid", "url": "https://reuters.com/markets/…", "publisher": "Reuters",
  "publishedAt": "2026-10-18T09:00:00.000Z" }
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
`{ accessLevel: "FREE_PREVIEW", lockedFields, unlockPriceRaw, unlockPrice, unlockPriceStatus, paymentRequirements, dailyPassPriceRaw, dailyPassPrice }`.
The trace unlock price is discovered live from the authoritative x402 service (#63)
and validated against deployment network and USDC asset rules. If the x402 service
is unavailable or requirements fail validation, `unlockPriceStatus` is `"unknown"`,
`unlockPriceRaw` is `null`, and no fallback price is invented.
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
`409 PAYMENT_ALREADY_USED`. Over-allowance payments are still granted and flagged (#53).

> **Product decision for a human:** `PAYMENTS_RECIPIENT` defaults to the
> treasury contract. The treasury's trading capital *is* its USDC balance,
> so subscription revenue would become agent trading capital. A separate
> revenue account is probably wanted. This is flagged in `docs/STATUS.md`
> and not decided here.

#### `GET /traces/access/allowance`, `PUT /traces/access/allowance` (auth)

`PUT` body `{ dailyLimit: number, perTraceLimit: number, dailyLimitRaw?: "base units", perTraceLimitRaw?: "base units", currency?: "USDC" }`.
The float fields are display mirrors; enforcement uses the raw `NUMERIC(39,0)`
columns (#53). Response: `SpendingAllowance | null`.

#### `POST /traces/access/preauthorize` (auth)

Advisory-only allowance check (#53). Body
`{ type?: "DAILY_PASS" | "PER_TRACE", amountRaw?: "base units" }`; for
`DAILY_PASS` the price defaults to `DAILY_PASS_PRICE_RAW` and for `PER_TRACE`
`amountRaw` is required. It never writes or reserves budget. Response:

```json
{
  "type": "DAILY_PASS",
  "amountRaw": "5000000",
  "active": true,
  "allowed": false,
  "reason": "ALLOWANCE_DAILY_LIMIT",
  "dailyLimitRaw": "5000000",
  "perTraceLimitRaw": "5000000",
  "spentTodayRaw": "4000000",
  "remainingRaw": "1000000",
  "overageRaw": "0",
  "wouldOverflowRaw": "4000000"
}
```

An over-limit payment is still accepted on-chain and flagged
(`allowanceOverage` on the `PaymentEvent`, `overageRaw` on the allowance); it is
never refused and never silently dropped.

#### `POST /traces/payment-intents` (auth)

Issues a server-priced `DAILY_PASS` intent (#52): the server fixes `amountRaw`,
`recipient`, `token`, a unique `memo`, and `expiresAt`. Clients should pay that
exact transfer and then `POST` the hash. Response `201`:
`{ intent, allowance }` where `allowance` is the preauthorization above.
Errors: `429 TOO_MANY_PAYMENT_INTENTS`.

#### `GET /traces/payment-intents/:id` (auth)

The caller's own intent. Errors: `404 PAYMENT_INTENT_NOT_FOUND`.

#### `POST /traces/payment-intents/:id/submit` (auth)

Body `{ txHash: "64-hex" }`. Verifies the transfer's sender, recipient, token,
memo and amount. A transaction not yet visible moves the intent to
`PENDING_PAYMENT` and a background confirmer retries with backoff; a confirmed
payment returns `201` with the intent `CONFIRMED` and its `subscriptionId`.
Response `202` when still pending. Underpayments and payments whose ledger
close time is after `expiresAt` are recorded as `PaymentEvent`s with no
coverage and the intent becomes `REFUND_REQUIRED`. Errors:
`400 VALIDATION_ERROR`, `409 PAYMENT_ALREADY_USED`,
`409 PAYMENT_INTENT_CLOSED`, `409 PAYMENT_INTENT_TX_MISMATCH`,
`409 PAYMENT_CLAIM_IN_PROGRESS`, `402 PAYMENT_MEMO_MISMATCH`.

#### Pass windows and stacking (#54)

New subscriptions store `startsAt`, `endsAt`, `purchaseLedger` and keep
`expiresAt = endsAt`. Coverage is `[startsAt, endsAt)` anchored to the payment
transaction's ledger close time. A second pass stacks: it starts at the later
of the ledger close time and the last active/queued pass's `endsAt`. A payment
whose computed window is already in the past is recorded but grants no
coverage (`EXPIRED`).

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
`{ totalUsdc, deployedCapital, availableCapital, openPositions, totalPnl, dailyPnl, builderFeesEarned, treasury, correlationRisk, availableCapitalRaw, latestReport }`.

Capital comes from the treasury contract, read live on every request (#76):

```json
"treasury": {
  "availableRaw": "8000000000",
  "maxTradeRaw": "5000000000",
  "maxMarketRaw": "10000000000",
  "maxDailyRaw": "20000000000",
  "dailyUsedRaw": "1500000000",
  "dailyRemainingRaw": "18500000000",
  "dailyResetsAt": "2026-10-19T08:14:05.000Z"
}
```

All `*Raw` values are 7-decimal USDC base units as decimal strings.
`availableRaw` is `available_capital()`, the treasury's free USDC (it includes
subscription revenue paid to the treasury and excludes capital locked in
markets). `maxTradeRaw` / `maxMarketRaw` / `maxDailyRaw` are `get_config()`'s
caps; `dailyUsedRaw` and `dailyResetsAt` come from `daily_usage()`, a rolling
24 h window that starts at the first spend after the previous window expired
(not UTC midnight). `dailyRemainingRaw` = `maxDailyRaw − dailyUsedRaw`.

The float fields are derived from it: `availableCapital` = `availableRaw` in
USDC, `totalUsdc` = `availableCapital + deployedCapital`. If the chain read
fails, `treasury`, `availableCapital`, `totalUsdc` and
`correlationRisk.isOverExposed` are `null` and the database fields are still
returned. `availableCapitalRaw` (= `treasury.availableRaw`) is kept for
compatibility.

`correlationRisk` (#80): `{ pairs, totalExposure, isOverExposed, matrix, method, snapshotId }`.
`isOverExposed` compares open exposure with 10% of the treasury's free cash.
Each pair is `{ marketIdA, marketIdB, correlationScore, relationship, method }`
for open positions with `|correlationScore| ≥ 0.60`. `correlationScore` is the
estimate used for sizing: the latest correlation snapshot's value for the pair
(`method: "empirical"`, or `"prior"` when the pair had too little overlap), or
the hand-written category matrix (`method: "matrix"`) when there is no snapshot,
it is older than two hours or it lacks the pair. `relationship` follows the sign
(`POSITIVE`, `NEGATIVE`, or `NONE` when |ρ| < 0.05). `matrix` is
`{ marketIds, values }`, the full correlation matrix of the (up to 50 largest)
open positions projected onto the nearest positive-semidefinite matrix; the pair
scores are the raw pairwise values. `method` is `"snapshot"` when any pair used
the snapshot. The trader's reasoning traces carry the same
`correlation: { pairs, method, snapshotId }` for the size they were cut to.

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

Admin routes require a valid JWT for a `G…` base account that holds an
assignment in the database RBAC tables (#49). `ADMIN_ADDRESSES` only seeds the
first deploy as `super_admin`; after that the database is authoritative and a
revoked address loses access immediately. JWT claims never carry permissions.

Two roles' permissions matter for step-up: sensitive routes require an
`auth_time` no older than `STEP_UP_MAX_AGE_SECONDS` (default 300) and return
`403 STEP_UP_REQUIRED` otherwise. Sensitive routes are admin management
(grant/revoke/list, audit) and all treasury writes.

Admin-management endpoints:

- `GET /admin/admins` (`admin.read`, step-up)
- `GET /admin/roles` (`admin.read`)
- `POST /admin/admins/grant` `{ walletAddress: "G…", roleName }` (`admin.manage`, step-up)
- `POST /admin/admins/revoke` `{ walletAddress: "G…" }` (`admin.manage`, step-up; refuses `409 LAST_SUPER_ADMIN`)
- `GET /admin/audit?page&limit` (`admin.audit.read`, step-up)

All other admin routes map to `treasury.read`/`treasury.operate`,
`agents.manage`, `disputes.manage`, `trace_audit.run`,
`reconciliation.run`, `markets.generate` and `calibration.recompute`.
Unsafe requests that pass a permission check are appended to `admin_audit_logs`;
the table rejects `UPDATE`/`DELETE` at the database level.

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

#### `GET /admin/reconciliation/runs?limit=` (admin)

Latest market-lifecycle reconciliation runs (#83), newest first (`limit` ≤ 100,
default 20): `{ id, startedAt, finishedAt, scanned, repaired, reported, deferred, rpcCalls, error }`.

#### `GET /admin/reconciliation/runs/:id` (admin)

`{ run, findings }`, with `findings` paginated (`page`, `limit`). Each finding is
`{ id, runId, marketId, onChainMarketId, driftClass, dbValue, chainValue, action, observedLedger, createdAt }`.

`driftClass`: `MISSED_RESOLUTION`, `MISSED_VOID`, `CLOSED_BUT_ACTIVE`,
`PRICE_STALE`, `CLOSE_TIME_MISMATCH`, `HASH_MISMATCH`, `NOT_FOUND_ON_CHAIN`,
`STATUS_REGRESSION`. `action`: `REPAIRED`, `REPORTED` (report-only classes and
dry runs), `DEFERRED` (the indexer is behind the observation and may still
process the event itself; a finding deferred in three runs in a row is repaired
anyway, with `chainValue.forced = true`) or `SKIPPED_NEWER` (a newer writer
moved the row first). Repaired resolutions carry `chainValue.resolvedAtApproximate`:
`resolvedAt` is the observation time, not the on-chain one.

#### `POST /admin/reconciliation/run` (admin)

Body `{ "dryRun"?: boolean, "maxMarkets"?: number }`. Starts a run in the
background, under the same advisory lock as the cron (a run that cannot take
the lock records itself as skipped). Response `202 Accepted`:
`{ "runId": "uuid", "message": "Reconciliation run scheduled" }`.

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


### Resolution signers (auth, per-market signer)

A market created with the default `signers` spec (ADR 0001) commits to an
m-of-n set of resolution signers. External signers use this API to find the
markets waiting for them, read the evidence, build the `resolver.attest`
transaction for their own wallet, and watch progress. The API only
coordinates: the resolver contract still enforces membership, the close time
and one attestation per signer and outcome. The backend never holds a
signer's key.

Signers log in with the normal SEP-10 flow (`POST /auth/challenge`,
`POST /auth/verify`). Whether a wallet may act on a market is decided
**per market from the spec committed at creation**, not from
`RESOLUTION_SIGNERS` (which may have changed since). The stored spec is trusted
only if it re-hashes to `Market.resolutionHash` and to the market's on-chain
`resolution_hash`. `:marketId` is the backend market UUID.

Every route needs a Bearer token and is rate limited to 30 requests a minute
per IP.

Flow:

1. `GET /signer/markets`: markets that closed and await you.
2. `GET /signer/markets/:marketId/evidence`: the pinned question and sources.
3. `POST /signer/markets/:marketId/attest/prepare` with `{ "outcome": "YES" }`.
4. Sign the returned `xdr` in your wallet. You are the transaction source, so
   no Soroban authorization entries are needed.
5. `POST /signer/markets/:marketId/attest/submit` with `{ "xdr": "<signed>" }`.
6. `GET /signer/markets/:marketId/progress`.

#### `GET /signer/markets?page&limit`
Markets whose committed signer set contains your wallet, that have closed, are
not finalized on the resolver, and that you have not attested to yet. Oldest
close first.

```json
{ "marketId": "uuid", "onChainMarketId": "5", "question": "…", "closedAt": "…",
  "resolutionSource": "FRED:DGS10", "resolverState": "SignersPending",
  "blockedReason": null, "preparedOutcomes": ["YES"] }
```

`blockedReason` is `"SPEC_NOT_REVEALED"` while the spec has not been
registered on the resolver (`resolverState: "Unconfigured"`): every attestation
would fail until it is, so it is listed rather than hidden.

#### `GET /signer/markets/:marketId/evidence`
The question document pinned at `metaUri`, returned only if its sha256 equals
`Market.questionHash`; otherwise `502 IPFS_RETRIEVAL_FAILED`.

```json
{ "marketId": "uuid", "onChainMarketId": "5",
  "question": { "version": 1, "question": "…", "closeTime": 1767225600, "resolutionSource": "…" },
  "questionHash": "64-hex", "questionUri": "ipfs://…",
  "resolutionSource": "FRED:DGS10", "closeTime": 1767225600,
  "spec": { "kind": "signers", "signers": ["G…"], "threshold": 2, "disputeWindow": 86400 },
  "resolutionHash": "64-hex",
  "evidenceTraces": [{ "id": "uuid", "ipfsCid": "bafy…", "traceHash": "64-hex", "url": "/api/v1/traces/uuid" }] }
```

`evidenceTraces` are existing `RESOLUTION_ATTESTATION` reasoning traces for the
market, if any. This API serves evidence that exists; it does not produce it.

#### `POST /signer/markets/:marketId/attest/prepare?allowConflict=true|false`
Body `{ "outcome": "YES" | "NO" }`. Returns an unsigned, simulated transaction:

```json
{ "xdr": "AAAA…", "networkPassphrase": "Test SDF Network ; September 2015",
  "validUntil": "2026-10-18T12:05:00.000Z", "outcome": "YES" }
```

The transaction has time bounds (about 5 minutes). Preparing the same outcome
again while it is still valid returns the same transaction. If you already have
a **confirmed** attestation for the other outcome the API refuses with
`409 CONFLICTING_ATTESTATION` (the contract would accept it; the API will not
help a signer equivocate) unless you pass `allowConflict=true`.

#### `POST /signer/markets/:marketId/attest/submit`
Body `{ "xdr": "<signed envelope, max 20000 chars>" }`. The envelope must hash
to exactly the prepared transaction, be unexpired and carry your signature.
The API broadcasts it and waits up to 30 seconds for the ledger.

* `200 { "status": "CONFIRMED", "outcome", "txHash", "ledger" }`
* `202 { "status": "SUBMITTED", … }`: broadcast, not yet seen in a ledger. Poll
  `/progress`; preparing again settles it against the network.

#### `GET /signer/markets/:marketId/progress`
```json
{ "threshold": 2, "signers": ["G…"], "counts": { "YES": 1, "NO": 0 },
  "countsSource": "api-observed",
  "attestedBy": [{ "signer": "G…", "outcome": "YES", "txHash": "64-hex", "ledger": 123 }],
  "thresholdReached": false, "split": false, "equivocators": [],
  "proposal": null, "attestationsOutsideApi": false,
  "resolverState": "SignersPending" }
```

`counts` come from attestations confirmed through this API only
(`countsSource: "api-observed"`); the resolver has no per-attestation event or
count view. `proposal` (`{ "outcome", "proposedAt" }`) comes from the indexed
`ResolutionProposed` event. Disagreement is surfaced, not hidden: `split` is
true when both outcomes have votes, `equivocators` lists wallets that attested
both, and `attestationsOutsideApi` is true when a proposal exists that the
observed counts cannot explain.

Error codes:

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad id, outcome, flag or body. |
| 400 | `INVALID_SIGNED_XDR` | Not a transaction envelope for this network (fee-bump envelopes are refused). |
| 400 | `SIGNATURE_INVALID` | The envelope is not signed by your wallet over the prepared hash. |
| 401 | `UNAUTHORIZED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | See Auth. |
| 403 | `NOT_A_SIGNER` | Your wallet is not in the market's committed signer set (also when the resolver itself reports `NotSigner`). |
| 404 | `MARKET_NOT_FOUND` | |
| 409 | `MARKET_NOT_ON_CHAIN`, `SPEC_NOT_COMMITTED`, `NOT_A_SIGNER_MARKET` | The market has no committed signer spec. |
| 409 | `SPEC_MISMATCH` | The stored spec does not match `resolutionHash` or the on-chain hash. Nothing is served. |
| 409 | `SPEC_NOT_REVEALED` | The spec is not registered on the resolver (`MarketNotConfigured`). |
| 409 | `MARKET_NOT_CLOSED`, `ALREADY_FINALIZED`, `ALREADY_ATTESTED` | The resolver's own checks. |
| 409 | `CONFLICTING_ATTESTATION` | See `prepare`. |
| 409 | `ATTESTATION_IN_FLIGHT` | An earlier submission for this outcome has not resolved yet. |
| 409 | `SIGNER_ACCOUNT_NOT_FOUND` | Your account does not exist on this network. |
| 409 | `PREPARED_TX_MISMATCH` | The envelope is not one prepared for this market and wallet. |
| 409 | `PREPARED_TX_FAILED` | That prepared transaction already failed; prepare a new one. |
| 409 | `STALE_SEQUENCE` | Your account sequence changed after `prepare`; prepare again. |
| 410 | `PREPARED_TX_EXPIRED` | Past `validUntil`; prepare again. |
| 422 | `SIMULATION_FAILED` | The resolver rejected the call; `details.contractError` names it. |
| 422 | `EXTRA_SIGNERS_REQUIRED` | The transaction needs authorization from someone other than you. |
| 422 | `BROADCAST_REJECTED`, `ATTESTATION_FAILED` | The network rejected or failed the transaction (`details.resultCode`). |
| 429 | `RATE_LIMITED` | |
| 502 | `IPFS_RETRIEVAL_FAILED`, `PREPARE_FAILED`, `BROADCAST_FAILED` | Upstream problem. |
| 503 | `NETWORK_BUSY` | The network asked to retry later. |

### Dispute monitor (auth, admin)

When signers reach a market's threshold the resolver stores a proposal and the
outcome only becomes final after the dispute window; until then the guardian
(the resolver admin) can cancel it. The dispute monitor reviews every
`ResolutionProposed` event independently and alerts guardians. The runbook is in
[architecture.md](architecture.md#disputes-and-guardian-actions).

`windowRemainingSecs` is measured against the **latest ledger close time**
(from RPC, else the indexer's newest event), not server time; `meta.ledgerTime`
shows both and where the ledger time came from (`rpc`, `indexer`, or `server`
as a last resort).

#### `GET /admin/disputes?status=open|all&page&limit`
Reviews, newest first (`open` is the default: not finalized or cancelled).

```json
{ "id": "uuid", "onChainMarketId": "5", "proposedOutcome": "YES",
  "proposedAt": "1767225600", "windowEndsAt": "1767312000",
  "windowRemainingSecs": 85800, "windowRemainingServerSecs": 85791,
  "verdict": "DISAGREE", "independentOutcome": "NO", "confidence": 0.93,
  "evidence": { "items": [{ "id": "e1", "source": "FRED", "kind": "primary", "cited": true }] },
  "evidenceHash": "64-hex", "acknowledgedBy": null, "resolvedAs": null }
```

`verdict` is `PENDING`, `AGREE`, `DISAGREE`, `INSUFFICIENT` or `ERROR`. A
proposal found only by polling has `proposedAt`/`windowEndsAt` `null` and
`proposedOutcome: "UNKNOWN"`.

#### `POST /admin/disputes/:id/ack`
Marks the review acknowledged by the calling admin. Acknowledged reviews stop
escalating.

#### `POST /admin/disputes/:id/cancel-tx`, `POST /admin/disputes/:id/void-tx`
Returns an unsigned, simulated `cancel_proposal` / `guardian_void_market`
transaction whose source is `RESOLVER_GUARDIAN_ADDRESS`, for the guardian's own
wallet. The backend never signs or sends it.

```json
{ "xdr": "AAAA…", "networkPassphrase": "…", "validUntil": "…",
  "guardian": "G…", "kind": "cancel_proposal", "onChainMarketId": "5" }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad id or `status`. |
| 403 | `FORBIDDEN` | Not an admin. |
| 404 | `DISPUTE_NOT_FOUND` | |
| 409 | `GUARDIAN_MISMATCH` | Simulation was not authorized: `RESOLVER_GUARDIAN_ADDRESS` is not the resolver admin. |
| 409 | `NO_PROPOSAL`, `ALREADY_FINALIZED` | Nothing to cancel. |
| 422 | `SIMULATION_FAILED` | `details.contractError` names the resolver error. |
| 503 | `GUARDIAN_NOT_CONFIGURED` | `RESOLVER_GUARDIAN_ADDRESS` is not set. |

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

Public events are published by the indexer to an internal event bus and
delivered by one elected instance, so every client gets each event once
regardless of which API instance it is connected to. Payloads below are
unchanged. See [architecture.md](architecture.md#event-bus-and-socket-fan-out-93).

### Connecting and authenticating

Anonymous connections work and receive the public events below. To receive
private events, send the same JWT the REST API uses in the handshake `auth`
payload. **Never put it in the query string**: URLs end up in proxy and access
logs, and a handshake with `query.token` is refused.

```js
const socket = io(API_ORIGIN, { auth: { token } });
socket.on('connect_error', (err) => {
  // err.message and err.data.code: INVALID_TOKEN | TOKEN_EXPIRED | TOKEN_IN_QUERY
});
```

The token is verified exactly like `Authorization: Bearer` (HS256 only). An
invalid or expired token fails the handshake, so a reconnect with a stale
token does not silently become anonymous; fetch a new token first.

An authenticated socket joins the room `user:<userId>`. Every tab of one user
receives that user's private events.

**Session lifetime.** A session ends when its token's `exp` passes. The server
emits `SESSION_EXPIRED` (`{ "reason": "TOKEN_EXPIRED" }`) and removes the
socket from its user room. The socket stays connected, so public events
continue. To continue receiving private events without reconnecting, send a
fresh token for the **same user**:

```js
socket.emit('reauth', { token: newToken }, (ack) => {
  // { ok: true, exp } | { ok: false, code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'USER_MISMATCH' }
});
```

`USER_MISMATCH` means the token belongs to a different user than the socket's
session; open a new connection instead.

**Multiple API instances.** Private events are emitted to the room and reach the
user's sockets on every instance through the socket.io Redis Streams adapter
(enabled when `EVENT_BUS_ENABLED=true`, the default). With
`EVENT_BUS_ENABLED=false` there is no adapter and an event reaches only sockets
connected to the instance that emitted it.

### Private events

Sent only to the owner's room, never broadcast, and never contain another
user's data.

#### `PAYMENT_CONFIRMED`
After a daily-pass payment was verified on-chain and committed. Not sent again
when the same transaction hash is re-submitted.

```json
{ "subscriptionId": "uuid", "type": "DAILY_PASS", "txHash": "64-hex",
  "amountRaw": "5000000", "expiresAt": "2026-10-19T12:00:00.000Z" }
```

#### `PASS_EXPIRING`
Once per daily pass, when it has less than an hour left.

```json
{ "subscriptionId": "uuid", "expiresAt": "2026-10-19T12:00:00.000Z" }
```

#### `COPY_TRADE_CONFIRMED`
When a copy trade becomes `EXECUTED`, whether the user confirmed it or the
indexer or sweep matched the on-chain `Trade` event first. `verified` is true
when the buy was matched to that event (every path that sets `EXECUTED` does
this today).

```json
{ "copyTradeId": "uuid", "txHash": "64-hex", "status": "EXECUTED", "verified": true }
```

### Public events

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

### `MARKET_DRIFT`

Admins only (#83): sockets that connect with `auth: { token: <admin JWT> }` join
the `admins` room. Emitted by the reconciler for integrity findings that are
never auto-repaired (`HASH_MISMATCH`, `STATUS_REGRESSION`, `NOT_FOUND_ON_CHAIN`):
`{ runId, marketId, onChainMarketId, driftClass, dbValue, chainValue }`.

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
