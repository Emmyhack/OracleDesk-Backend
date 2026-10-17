# Transparency reports v1

OracleDesk publishes a daily report computed **only from chain data** and
`chain_events`, anchors it to a ledger, pins the canonical JSON to IPFS, and
commits its sha256 through the reasoning registry. The public index serves the
CID, hash, on-chain trace id and anchor; `scripts/verify-report.ts` re-checks
them without database access.

## Document

```ts
interface TransparencyReportV1 {
  kind: 'oracledesk.transparency-report';
  schemaVersion: 1;
  network: string;                 // Stellar passphrase
  contracts: { treasury; marketCore; usdc; reasoningRegistry };
  agent: string;                   // treasury RiskConfig.agent
  period: { from: string; to: string };       // UTC day, ISO
  anchor: { ledger: number; closedAt: string };
  consistency: 'exact' | 'best_effort';
  treasury: {
    usdcBalanceRaw: string;
    availableCapitalRaw: string;
    riskConfig: { maxTradeRaw; maxMarketRaw; maxDailyRaw };
    dailyUsage: { amountRaw: string; dayStart: number };
  };
  markets: Array<{
    marketId: string;
    status: 'Open' | 'Resolved:Yes' | 'Resolved:No' | 'Void';
    createdByTreasury: boolean;
    position: { yesRaw: string; noRaw: string };
    reserves: { yesRaw: string; noRaw: string };
    priceYesBps: number;
    markValueRaw: string;
    liquidationValueRaw: string;
    settlementValueRaw: string | null;
    lpRemainderRaw?: string;       // final, unclaimed treasury-created pools
    archived?: boolean;
  }>;
  totals: { positionsMarkRaw; positionsLiquidationRaw; navRaw };
  period_flows: {
    coverage: { fromLedger; toLedger; complete; gaps: Array<[number, number]> };
    tradesBoughtRaw; tradesSoldRaw; feesPaidRaw; redeemedRaw;
    feesCollectedRaw; seedDeployedRaw; tradeCount;
  };
  traces: { total: number; byAction: Record<string, number> };
  method: { version: '1'; doc: string };
  previous: { onChainTraceId: string; traceHash: string } | null;
}
```

All amounts are integer strings in 7-decimal USDC base units. No Prisma float
model is imported by the report service (CI asserts the import boundary).

## Integers and valuations

`BPS = 10_000`. Let `p = priceYesBps(reserve_yes, reserve_no)` from
`src/generated/fpmm.ts`.

- `markValueRaw = floor((yes × p + no × (BPS − p)) / BPS)`
- `liquidationValueRaw = collateralOutForShares(reserve_yes, reserve_no, yes, fee_bps)
  + collateralOutForShares(reserve_no, reserve_yes, no, fee_bps)`
- `settlementValueRaw = settleValue(kind, yes, no)` for final markets, where
  `kind` is `yes`, `no` or `void`.
- `lpRemainderRaw = settleValue(kind, reserve_yes, reserve_no)` for final,
  unclaimed (`lp_claimed === false`) pools created by the treasury.
- `totals.positionsMarkRaw = Σ markValueRaw`;
  `positionsLiquidationRaw = Σ liquidationValueRaw`;
  `navRaw = usdcBalanceRaw + positionsMarkRaw`.

## Snapshot

Simulations run against the RPC's latest state; Soroban cannot pin a
historical ledger. The builder therefore:

1. reads `getLatestLedger()` → `L0`;
2. enumerates `0..marketCount()` and reads each market + treasury position;
3. reads `getLatestLedger()` → `L1`;
4. if `L1 > L0`, retries up to 3 times; after the third attempt the report is
   still published with `consistency: 'best_effort'` and `anchor.ledger = L1`.

The normal case is `consistency: 'exact'`. Entries that can no longer be read
are reported as `archived: true` rather than treated as zero.

## Period flows

Events are `chain_events` rows whose `ledgerClosedAt` falls in the UTC day:

- market-core `Trade` with `trader = treasury`: buys/sells (`is_buy`),
  `fee`, and `tradeCount`;
- market-core `Redeemed` with `holder = treasury`;
- treasury `FeesCollected`;
- market-core `MarketCreated` with `creator = treasury` (`seed_amount`).

`coverage.complete` is false when the stored indexer cursor is older than the
last ledger in the period; the missing range is listed in `coverage.gaps`.
RPC retention means an indexer that did not run continuously cannot recover
those events.

## Trace counts

The report walks `traceCount()`/`get_trace(i)` and caches immutable trace
metadata in `registry_trace_cache`. Only traces whose `agent` equals the
treasury's `RiskConfig.agent` are counted in `traces.total` and
`traces.byAction`.

## Sentinel market id

`publish_trace` requires a `market_id`. Reports use
`REPORT_MARKET_ID = 18446744073709551615` (`u64::MAX`) and action `"report"`.
`market_trace_count(REPORT_MARKET_ID)` / `market_trace_at` therefore form an
on-chain index of reports. A dedicated `publish_report` entrypoint is requested
in `docs/contract-requests.md`.

## Publishing and idempotency

`REPORTS_ENABLED=true` schedules `REPORT_CRON` (default `10 0 * * *`,
`Etc/UTC`). The job:

1. builds the document for the UTC day;
2. canonicalises and pins it (`pinJson`);
3. publishes `trace_hash`/`ipfs_cid` via `publish_trace` (respecting
   `CHAIN_EXECUTION_MODE`; `REPORT_MODE=dry-run` is also supported);
4. inserts or updates `transparency_reports`.

If a row exists without `onChainTraceId` (crash between pin and publish, or a
dry run being retried), the job re-publishes the **stored bytes** — it never
recomputes. Dry-run rows have `mode = 'dry-run'` and `onChainTraceId = null`.

## Verification

```bash
npm run verify:report -- --date 2026-10-14 [--rpc URL] [--gateway URL]
npm run verify:report -- --trace-id 42
```

The verifier uses only `@stellar/stellar-sdk` and the generated bindings:

1. walks `market_trace_count(u64::MAX)` / `market_trace_at` (or uses
   `--trace-id`) and parses each CID until the report's `period.from` matches
   the date;
2. fetches the CID from the gateway, computes sha256 and compares it with the
   on-chain `trace_hash`;
3. checks the trace agent equals the report agent and the treasury
   `RiskConfig.agent`;
4. recomputes `totals.positionsMarkRaw` and `navRaw`;
5. follows `previous` and checks the previous trace hash/action;
6. reports whether the state moved since the anchor ledger.

It exits non-zero on any failed check.
