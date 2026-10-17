import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

function market(overrides: any = {}) {
  return {
    creator: 'GTREASURY',
    status: { tag: 'Open', values: undefined },
    reserve_yes: 100n,
    reserve_no: 200n,
    fee_bps: 100,
    lp_claimed: false,
    fees_accrued: 0n,
    close_time: 0n,
    meta_uri: '',
    question_hash: Buffer.alloc(0),
    resolution_hash: Buffer.alloc(0),
    sets_minted: 0n,
    category: { tag: 'Macro', values: undefined },
    ...overrides,
  } as any;
}

function snapshot(overrides: any = {}) {
  return { marketId: 0n, market: market(), position: { yes: 10n, no: 5n }, ...overrides } as any;
}

test('mark value uses priceYesBps integer math (#159)', async () => {
  const { markValueRaw } = await import('../src/services/transparency-report.service');
  const { priceYesBps } = await import('../src/generated/fpmm');
  const bps = Number(priceYesBps(100n, 200n));
  assert.equal(bps, 6666);
  assert.equal(markValueRaw(10n, 5n, bps), ((10n * 6666n + 5n * 3334n) / 10_000n).toString());
});

test('liquidation value equals collateralOutForShares for each side (#159)', async () => {
  const { liquidationValueRaw } = await import('../src/services/transparency-report.service');
  const { collateralOutForShares } = await import('../src/generated/fpmm');
  const expected = collateralOutForShares(100n, 200n, 10n, 100n) + collateralOutForShares(200n, 100n, 5n, 100n);
  assert.equal(liquidationValueRaw(100n, 200n, 10n, 5n, 100n), expected.toString());
});

test('void settlement uses settleValue, and final markets expose settlement/lp values (#159)', async () => {
  const { valueMarket } = await import('../src/services/transparency-report.service');
  const { settleValue } = await import('../src/generated/fpmm');
  const voided = valueMarket(snapshot({ market: market({ status: { tag: 'Void', values: undefined } }) }), 'GTREASURY');
  assert.equal(voided.settlementValueRaw, settleValue('void', 10n, 5n).toString());
  assert.equal(voided.lpRemainderRaw, settleValue('void', 100n, 200n).toString());
  const open = valueMarket(snapshot(), 'GTREASURY');
  assert.equal(open.settlementValueRaw, null);
  assert.equal(open.createdByTreasury, true);
});

test('the report document is byte-identical across runs (#159)', async () => {
  const { buildReportDocument, valueMarket, totalsFor } = await import('../src/services/transparency-report.service');
  const markets = [valueMarket(snapshot(), 'GTREASURY')];
  const inputs = {
    date: '2026-10-14',
    network: 'Test SDF Network ; September 2015',
    contracts: { treasury: 'CT', marketCore: 'CM', usdc: 'CU', reasoningRegistry: 'CR' },
    agent: 'GTREASURY',
    anchor: { ledger: 100, closedAt: '2026-10-14T00:00:00.000Z' },
    consistency: 'exact' as const,
    treasury: {
      usdcBalanceRaw: '1000',
      availableCapitalRaw: '1000',
      riskConfig: { maxTradeRaw: '1', maxMarketRaw: '2', maxDailyRaw: '3' },
      dailyUsage: { amountRaw: '0', dayStart: 0 },
    },
    markets,
    periodFlows: {
      coverage: { fromLedger: 100, toLedger: 100, complete: true, gaps: [] as Array<[number, number]> },
      tradesBoughtRaw: '0', tradesSoldRaw: '0', feesPaidRaw: '0', redeemedRaw: '0',
      feesCollectedRaw: '0', seedDeployedRaw: '0', tradeCount: 0,
    },
    traces: { total: 0, byAction: {} },
    previous: null,
    methodDoc: 'doc',
  };
  const a = buildReportDocument(inputs);
  const b = buildReportDocument(inputs);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.totals, totalsFor(markets, '1000'));
});

test('coverage is incomplete when the indexer cursor is behind the period (#159)', async () => {
  const { buildReportForDate } = await import('../src/services/transparency-report.service');
  const report = await buildReportForDate('2026-10-14', {
    latestLedger: async () => 100,
    marketCount: async () => 0n,
    treasuryConfig: async () => ({ agent: 'GTREASURY', max_daily: 1000n, max_market: 100n, max_trade: 10n }),
    dailyUsage: async () => ({ amount: 0n, day_start: 0n }),
    availableCapital: async () => 500n,
    chainEvents: async () => [
      { contractName: 'marketCore', eventName: 'Trade', ledger: 90, ledgerClosedAt: new Date(), params: { trader: 'GTREASURY', collateral: '100', fee: '1', is_buy: true } },
    ],
    indexerCursor: async () => 50,
    traceCount: async () => 0n,
    previousReport: async () => null,
    methodDoc: 'doc',
  });
  assert.equal(report.period_flows.coverage.complete, false);
  assert.deepEqual(report.period_flows.coverage.gaps, [[51, 90]]);
  assert.equal(report.period_flows.tradesBoughtRaw, '100');
  assert.equal(report.period_flows.tradeCount, 1);
});

test('snapshot retries when the ledger moves and flags best_effort after 3 attempts (#159)', async () => {
  const { buildReportForDate } = await import('../src/services/transparency-report.service');
  const sequence = [100, 101, 101, 102, 102, 103];
  let index = 0;
  const report = await buildReportForDate('2026-10-14', {
    latestLedger: async () => sequence[Math.min(index++, sequence.length - 1)],
    marketCount: async () => 0n,
    treasuryConfig: async () => ({ agent: 'GTREASURY', max_daily: 1000n, max_market: 100n, max_trade: 10n }),
    dailyUsage: async () => ({ amount: 0n, day_start: 0n }),
    availableCapital: async () => 0n,
    chainEvents: async () => [],
    indexerCursor: async () => 0,
    traceCount: async () => 0n,
    previousReport: async () => null,
    methodDoc: 'doc',
  });
  assert.equal(report.consistency, 'best_effort');
  assert.equal(report.anchor.ledger, 103);
});

test('publish uses REPORT_MARKET_ID and action report; dry-run rows are uncommitted (#159)', async () => {
  const tracePublish = await import('../src/services/trace-publish.service');
  const { REPORT_MARKET_ID, runReportJob } = await import('../src/services/transparency-report.service');
  const { prisma } = await import('../src/lib/prisma');
  let published: any = null;
  (tracePublish as any).pinAndPublishDocument = async (params: any) => {
    published = params;
    return { cid: 'bafy-report', hash: 'a'.repeat(64), onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  };
  let created: any = null;
  (prisma.transparencyReport.findUnique as any) = async () => null;
  (prisma.transparencyReport.create as any) = async ({ data }: any) => {
    created = data;
    return { id: 'report-1', ...data };
  };

  await runReportJob('2026-10-14', {
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    latestLedger: async () => 100,
    marketCount: async () => 0n,
    treasuryConfig: async () => ({ agent: 'GTREASURY', max_daily: 1000n, max_market: 100n, max_trade: 10n }),
    dailyUsage: async () => ({ amount: 0n, day_start: 0n }),
    availableCapital: async () => 0n,
    chainEvents: async () => [],
    indexerCursor: async () => 100,
    traceCount: async () => 0n,
    previousReport: async () => null,
    methodDoc: 'doc',
  });
  assert.equal(REPORT_MARKET_ID, 18446744073709551615n);
  assert.equal(published.action, 'report');
  assert.equal(published.marketId, REPORT_MARKET_ID);
  assert.equal(created.mode, 'dry-run');
  assert.equal(created.onChainTraceId, null);
});

test('a crash after pin re-publishes the stored bytes, never recomputing (#159)', async () => {
  const tracePublish = await import('../src/services/trace-publish.service');
  const { runReportJob } = await import('../src/services/transparency-report.service');
  const { prisma } = await import('../src/lib/prisma');
  let republished: any = null;
  (tracePublish as any).publishPinnedDocument = async (params: any) => {
    republished = params;
    return { onChainTraceId: 7n, publishTxHash: 'tx', mode: 'live' };
  };
  (prisma.transparencyReport.findUnique as any) = async () => ({
    id: 'report-1', date: '2026-10-14', cid: 'bafy-old', hash: 'b'.repeat(64), onChainTraceId: null, mode: 'dry-run',
  });
  (prisma.transparencyReport.update as any) = async ({ data }: any) => ({ id: 'report-1', ...data });

  await runReportJob('2026-10-14');
  assert.equal(republished.cid, 'bafy-old');
  assert.equal(republished.hash, 'b'.repeat(64));
  assert.equal(republished.marketId, 18446744073709551615n);
});

function fakeTx(value: any) {
  return { result: value };
}

function fakeRegistry(trace: any, previous?: any) {
  return {
    async get_trace({ trace_id }: any) {
      if (trace_id === 1n) return fakeTx(trace);
      if (previous && trace_id === 0n) return fakeTx(previous);
      throw new Error('unknown trace');
    },
    async market_trace_count() { return fakeTx(1n); },
    async market_trace_at() { return fakeTx(1n); },
  };
}

async function verifyFixture(report: any, trace: any, previous?: any) {
  const { verify } = await import('../scripts/verify-report');
  const bytes = Buffer.from(JSON.stringify(report));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const registry = fakeRegistry({ ...trace, trace_hash: Buffer.from(hash, 'hex') }, previous);
  const treasury = { async get_config() { return fakeTx({ agent: 'GAGENT' }); } };
  return verify({
    traceId: '1',
    gatewayUrl: 'https://gw',
    deps: {
      registry,
      treasury,
      fetch: (async () => ({ ok: true, arrayBuffer: async () => bytes })) as any,
      latestLedger: async () => ({ sequence: 200 }),
    },
  });
}

const validReport = {
  kind: 'oracledesk.transparency-report',
  schemaVersion: 1,
  agent: 'GAGENT',
  markets: [{ markValueRaw: '10' }],
  treasury: { usdcBalanceRaw: '100' },
  totals: { markValueRaw: '10', positionsMarkRaw: '10', positionsLiquidityRaw: '0', navRaw: '110' },
  anchor: { ledger: 100 },
  previous: null,
};

test('verifier accepts a valid report and recomputes totals (#159)', async () => {
  const result = await verifyFixture(validReport, { agent: 'GAGENT', action: 'report', ipfs_cid: 'bafy', market_id: 18446744073709551615n });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
});

test('verifier detects tampered content, wrong agent and a broken previous chain (#159)', async () => {
  const { verify } = await import('../scripts/verify-report');
  const bytes = Buffer.from(JSON.stringify(validReport));
  const tampered = Buffer.from(JSON.stringify({ ...validReport, totals: { ...validReport.totals, navRaw: '999' } }));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const registry = fakeRegistry({ agent: 'GAGENT', action: 'report', ipfs_cid: 'bafy', trace_hash: Buffer.from(hash, 'hex'), market_id: 18446744073709551615n });
  const treasury = { async get_config() { return fakeTx({ agent: 'GAGENT' }); } };
  const tamperedResult = await verify({
    traceId: '1',
    deps: { registry, treasury, fetch: (async () => ({ ok: true, arrayBuffer: async () => tampered })) as any, latestLedger: async () => ({ sequence: 200 }) },
  });
  assert.equal(tamperedResult.ok, false);
  assert.ok(tamperedResult.checks.some((c) => c.name === 'content_hash' && !c.ok));

  const wrongAgent = await verifyFixture({ ...validReport, agent: 'GOTHER' }, { agent: 'GOTHER', action: 'report', ipfs_cid: 'bafy', market_id: 18446744073709551615n });
  assert.equal(wrongAgent.ok, false);
  assert.ok(wrongAgent.checks.some((c) => c.name === 'agent_matches_treasury' && !c.ok));

  const broken = await verifyFixture(
    { ...validReport, previous: { onChainTraceId: '0', traceHash: 'f'.repeat(64) } },
    { agent: 'GAGENT', action: 'report', ipfs_cid: 'bafy', market_id: 18446744073709551615n },
    { agent: 'GAGENT', action: 'report', ipfs_cid: 'bafy-prev', trace_hash: Buffer.from('e'.repeat(64), 'hex') },
  );
  assert.equal(broken.ok, false);
  assert.ok(broken.checks.some((c) => c.name === 'previous_hash_chain' && !c.ok));
});

test('u64::MAX sentinel serialises correctly in ScVal XDR (#159)', async () => {
  const { xdr } = await import('@stellar/stellar-sdk');
  const value = xdr.Uint64.fromString('18446744073709551615');
  assert.equal(value.toString(), '18446744073709551615');
  const encoded = xdr.ScVal.scvU64(value).toXDR('base64');
  const decoded = xdr.ScVal.fromXDR(encoded, 'base64').u64();
  assert.equal(decoded.toString(), '18446744073709551615');
});

test('the report service never imports portfolio floats or unrelated Prisma models (#159)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'services', 'transparency-report.service.ts'), 'utf8');
  assert.equal(source.includes('portfolio.service'), false, 'no portfolio.service import');
  assert.equal(/from ['"]@prisma\/client['"]/.test(source), false, 'no Prisma model types');
  const models = [...source.matchAll(/prisma\.([a-zA-Z]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(models)].sort(), ['chainEvent', 'indexerCursor', 'registryTraceCache', 'transparencyReport']);
});

test('lastModifiedLedgerSeq drift forces best_effort even with a stable latest ledger (#159)', async () => {
  const { buildReportForDate } = await import('../src/services/transparency-report.service');
  const report = await buildReportForDate('2026-10-14', {
    latestLedger: async () => 100,
    ledgerEntries: async () => [{ lastModifiedLedgerSeq: 150 }],
    marketCount: async () => 0n,
    treasuryConfig: async () => ({ agent: 'GTREASURY', max_daily: 1000n, max_market: 100n, max_trade: 10n }),
    dailyUsage: async () => ({ amount: 0n, day_start: 0n }),
    availableCapital: async () => 0n,
    chainEvents: async () => [],
    indexerCursor: async () => 100,
    traceCount: async () => 0n,
    previousReport: async () => null,
    methodDoc: 'doc',
  });
  assert.equal(report.consistency, 'best_effort');
});
