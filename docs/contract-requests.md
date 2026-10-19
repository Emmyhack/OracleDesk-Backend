# Requests for the contracts repo

Things this repo would like changed in
[OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract)
(`oracledesk-stellar/`). The backend works around each one; none of them
block the port. File them there, not here.

## 1. Doc fix: wrong path to the FPMM TypeScript port

`docs/frontend-integration.md` line 73 says the sell-side math lives at
`agents/core/src/fpmm.ts`. The file is `agents/core/fpmm.ts` (there is no
`src/` directory under `agents/core`).

Verified with:

```bash
ls contracts/oracledesk-stellar/agents/core/src   # No such file or directory
ls contracts/oracledesk-stellar/agents/core/fpmm.ts
```

## 2. Publish the FPMM math with the bindings

`agents/core/fpmm.ts` is the only TypeScript implementation of the
contract's pricing math, and every client that wants `priceYesBps` or
"sell N shares" needs it. Today each consumer copies it out of `agents/`
(this repo does so in `scripts/sync-contracts.mjs`). Shipping it as part of a
bindings package, or as a tiny `@oracledesk/fpmm` package, would give it a
version number and remove the copy step.

## 3. A way to get test USDC

`deployments/testnet.json` points at a self-issued test USDC: the classic
asset `USDC:<deployer G-address>` wrapped in a Stellar Asset Contract
(`scripts/deploy-testnet.sh`, `stellar contract asset deploy`). A tester's
account needs a trustline to that asset, and only the deployer key can
`mint`. There is no faucet, so a new tester cannot get collateral without
asking a maintainer to mint by hand. A small, rate-limited
faucet script (or an admin `mint` helper in `scripts/`) would make the manual
test plan in `docs/manual-test.md` self-serve.

## 4. Export `ResolutionSpec` in the resolver bindings

The resolver contract hashes `ResolutionSpec` (an enum wrapping
`PriceConfig` or `SignerConfig`), but because no entrypoint takes it as an
argument it is not in the generated TypeScript. Off-chain code that needs
the commitment hash has to rebuild the XDR by hand. A no-op view function
that takes a `ResolutionSpec`, or a `spec_hash(spec) -> BytesN<32>` view,
would put the type in the spec and let clients ask the contract for the
hash instead of re-implementing it.

## 5. Make `agents/stellar/adapter.ts` usable as a library

The backend would rather depend on the agents package for signing than
duplicate it, but today the adapter:

- returns `{ dryRun: true, args }` in dry-run without building or
  simulating the transaction, so a dry run can't catch a contract error;
- imports bindings by npm package name (`@oracledesk/bindings-*`), which
  only resolve inside the contracts repo;
- has no `agentSell`.

If dry-run simulated (and returned the simulated result), the bindings were
injectable, and `agentSell` existed, `src/services/chain.service.ts` here
could become a thin wrapper around it. Its method names already match.

## 6. Treasury `admin()` and `is_paused()` views

The admin console has to read `DataKey::Admin` and `DataKey::Paused` from the
treasury's contract-instance storage via `getLedgerEntries`. That is a
storage-layout workaround that breaks if the contract's keys change. Expose
`admin() -> Address` and `is_paused() -> bool` (or include them in
`get_config`) so clients do not depend on instance storage internals.

## 7. A dedicated `publish_report` entrypoint

Transparency reports use `market_id = u64::MAX` as a documented sentinel in
`publish_trace`, because reports are not about a single market. A
`publish_report(agent, action, trace_hash, ipfs_cid)` entrypoint (with its own
report counter/index) would remove the sentinel hack and let
`market_trace_count(u64::MAX)` stay a valid market-only index.

## 8. Record wasm hashes in `deployments/*.json`

The backend's startup spec-compat gate (#34) verifies each deployed
contract's wasm against the bindings it was synced with. The spec itself
comes from the chain, but there is no recorded expectation for the wasm
*hash*: two different builds can share a spec, and a hash pin would catch a
redeploy from an unreviewed build. Have `scripts/deploy-testnet.sh` write
the installed wasm hashes into `deployments/testnet.json`, e.g.:

```json
"wasm_hashes": {
  "market_core": "<hex sha256 of the installed wasm>",
  "resolver": "…",
  "treasury": "…",
  "reasoning_registry": "…"
}
```

`scripts/sync-contracts.mjs` here already copies `wasm_hashes.<contract>`
into `src/generated/contracts-manifest.json` when present (it records
`expectedWasmHash: null` otherwise), and the boot gate starts enforcing the
pin as soon as the hashes appear.

## Note: `publish_trace` action strings differ between repos

The backend publishes traces with `create_market`, `buy_yes` and `buy_no`
(`src/lib/trace-actions.ts`). The contracts repo's TypeScript agents use
`create_market` and `buy`. Consumers that group traces by action should treat
`buy` as either direction, or the two sides should agree on one vocabulary.

## Note: traces now carry a `provenance` block (backend #66)

Pinned trace documents gained a top-level `provenance` object
(`oracledesk.trace.provenance/1`, see `docs/api.md` in the backend). The
x402 service serves the pinned bytes untouched, so its consumers receive the
block as part of `content`. They should tolerate unknown keys in the trace
document and treat `provenance` as optional: traces pinned earlier do not have
it. `agents/core/trace.ts` `canonicalize` needs no change; the block holds only
strings, numbers, booleans, `null` and plain objects. The former
`llm: { provider, model }` key is gone.

## 8. A minimal SEP-45 web-auth contract (#47)

The backend's contract-account login (`GET /auth/contract/challenge`,
`POST /auth/contract/verify`) needs a deployed web-auth contract to simulate.
Please provide the smallest contract that satisfies
[SEP-45](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md):

```rust
pub fn web_auth_verify(env: Env, args: Map<Symbol, String>) {
    // No side effects, no state. Both parties must authorize.
    let account: Address = args.get(symbol_short!("account")).unwrap().into();
    let server: Address = args.get(symbol_short!("web_auth_domain_account")).unwrap().into();
    account.require_auth();
    server.require_auth();
}
```

Requests:

- Deploy it to testnet and record its `C…` id in
  `deployments/testnet.json` so `scripts/sync-contracts.mjs` exposes it.
- Keep the argument map keys exactly `account`, `home_domain`, `web_auth_domain`,
  `web_auth_domain_account`, `nonce` (the backend sends them as a sorted
  `ScMap<Symbol, String>` and rejects entries whose args disagree).

Until it exists, `WEB_AUTH_CONTRACT_ID` can point at a community SEP-45
web-auth contract on testnet. Risk to document: a hostile account contract can
make `__check_auth` always succeed, but that only proves control of the contract
being logged in, which is the identity under test.
