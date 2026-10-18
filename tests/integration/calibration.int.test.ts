/**
 * Calibration against a real Postgres (#68): the extraction SQL with seeded
 * markets and traces, the snapshot job and its advisory lock, and the index.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let truncateAll: typeof import('../helpers/db').truncateAll;
let makeMarket: typeof import('../helpers/factories').makeMarket;
let svc: typeof import('../../src/services/calibration.service');

before(async () => {
  process.env.MIN_CALIBRATION_MARKETS = '2';
  db = await integrationEnv('calibration');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  truncateAll = (await import('../helpers/db')).truncateAll;
  makeMarket = (await import('../helpers/factories')).makeMarket;
  svc = await import('../../src/services/calibration.service');
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => { if (db) { await prisma.$disconnect(); await db.drop(); } });

const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);

async function resolved(opts: { outcome: boolean | null; status?: 'RESOLVED' | 'CANCELLED'; onChain?: bigint | null; resolvedAtMin?: number; category?: string }) {
  const m = await makeMarket(prisma, opts.onChain === null ? {} : { onChainMarketId: opts.onChain ?? BigInt(Math.floor(Math.random() * 1e9)) });
  return prisma.market.update({
    where: { id: m.id },
    data: {
      status: opts.status ?? 'RESOLVED',
      resolvedOutcome: opts.outcome,
      resolvedAt: at(opts.resolvedAtMin ?? 100),
      ...(opts.category ? { category: opts.category as never } : {}),
    },
  });
}

async function trace(marketId: string, minute: number, p: number, extra: Partial<{ agentType: 'TRADER' | 'MARKET_MAKER'; decisionType: string; provenance: unknown }> = {}) {
  return prisma.reasoningTrace.create({
    data: {
      marketId,
      agentType: extra.agentType ?? 'TRADER',
      decisionType: extra.decisionType ?? 'OPEN_POSITION',
      sourcesUsed: [],
      probabilityEstimate: p,
      marketProbability: 0.5,
      edge: p - 0.5,
      confidenceInterval: { lower: 0.1, upper: 0.9 },
      createdAt: at(minute),
      ...(extra.provenance ? { provenance: extra.provenance as never } : {}),
    },
  });
}

test('extraction keeps resolved on-chain markets and drops voids, legacy rows and post-resolution traces', { skip: skipReason() }, async () => {
  const yes = await resolved({ outcome: true });
  const no = await resolved({ outcome: false });
  const voided = await resolved({ outcome: null, status: 'CANCELLED' });
  const legacy = await resolved({ outcome: true, onChain: null });
  const open = await makeMarket(prisma, { onChainMarketId: 77n });

  await trace(yes.id, 10, 0.7);
  await trace(yes.id, 100, 0.99); // created exactly at resolvedAt: leaks the outcome
  await trace(yes.id, 120, 0.99); // after resolution
  await trace(no.id, 10, 0.2);
  await trace(voided.id, 10, 0.5);
  await trace(legacy.id, 10, 0.5);
  await trace(open.id, 10, 0.5);

  const rows = await svc.extractRows(prisma, null);
  assert.deepEqual(rows.map((r) => [r.marketId, r.p, r.o]).sort(), [[no.id, 0.2, 0], [yes.id, 0.7, 1]].sort());
  assert.ok(rows.every((r) => r.createdAt < r.resolvedAt));
  assert.ok(rows.every((r) => r.promptVersion === null && r.model === null), 'older traces have no provenance');

  // the window start filters on resolvedAt
  assert.equal((await svc.extractRows(prisma, at(101))).length, 0);
  assert.equal((await svc.extractRows(prisma, at(100))).length, 2);
});

test('prompt version and model come from the first provenance entry', { skip: skipReason() }, async () => {
  const m = await resolved({ outcome: true });
  await trace(m.id, 10, 0.7, {
    provenance: { schema: 'oracledesk.trace.provenance/1', llm: [
      { source: 'llm', provider: 'anthropic', model: 'claude-sonnet-4-6', promptId: 'market-proposal', promptVersion: 1 },
      { source: 'default', promptId: 'hedge-conditions', promptVersion: 1, reason: 'LLM_FAILED' },
    ] },
  });
  await trace(m.id, 20, 0.6, {
    provenance: { schema: 'oracledesk.trace.provenance/1', llm: [{ source: 'default', promptId: 'hedge-conditions', promptVersion: 1, reason: 'LLM_FAILED' }] },
  });
  const rows = await svc.extractRows(prisma, null);
  assert.deepEqual(rows.map((r) => [r.promptVersion, r.model]), [['market-proposal@1', 'claude-sonnet-4-6'], ['hedge-conditions@1', null]]);
});

test('snapshots are computed per slice, flag small slices, and are served as the latest run', { skip: skipReason() }, async () => {
  for (let i = 0; i < 4; i++) {
    const m = await resolved({ outcome: i % 2 === 0, category: 'FED' });
    await trace(m.id, 10, i % 2 === 0 ? 0.8 : 0.3);
  }
  const lone = await resolved({ outcome: true, category: 'CRYPTO' });
  await trace(lone.id, 10, 0.6, { agentType: 'MARKET_MAKER', decisionType: 'MARKET_CREATION' });

  const run = await svc.computeAndStoreSnapshots({ now: at(200) });
  assert.ok(run && run.slices > 0);
  const latest = await svc.latestSnapshots({ window: 'all', groupBy: 'agentType' });
  const bySlice = Object.fromEntries(latest.slices.map((s) => [s.groupKey, s.metrics as any]));
  assert.equal(bySlice.TRADER.insufficientData, false);
  assert.equal(bySlice.TRADER.nMarkets, 4);
  assert.ok(bySlice.TRADER.brier < 0.1);
  assert.equal(bySlice.MARKET_MAKER.insufficientData, true, 'one market is below MIN_CALIBRATION_MARKETS');
  assert.equal(bySlice.MARKET_MAKER.brier, undefined);

  // a second run is a new row set; the API serves the most recent
  await svc.computeAndStoreSnapshots({ now: at(300) });
  const again = await svc.latestSnapshots({ window: 'all', groupBy: 'agentType' });
  assert.equal(again.computedAt!.getTime(), at(300).getTime());
  assert.equal((await svc.latestSnapshots({ window: 'all', groupBy: 'agentType_category', groupKey: 'TRADER:FED' })).slices.length, 1);
});

test('only one instance computes at a time (advisory lock)', { skip: skipReason() }, async () => {
  const held = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'oracledesk:calibration_snapshots'})::bigint)`;
    return svc.computeAndStoreSnapshots();
  });
  assert.equal(held, null, 'a second runner skips while the lock is held');
  assert.equal(await prisma.calibrationSnapshot.count(), 0);
  assert.ok(await svc.computeAndStoreSnapshots(), 'and runs once the lock is free');
});

test('the extraction join is backed by reasoning_traces (marketId, createdAt)', { skip: skipReason() }, async () => {
  const idx = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'reasoning_traces' AND indexname = 'reasoning_traces_marketId_createdAt_idx'`;
  assert.equal(idx.length, 1);
  assert.equal((await prisma.$queryRaw<unknown[]>`SELECT 1 FROM pg_indexes WHERE tablename = 'calibration_snapshots'`).length > 0, true);

  // enough rows for the planner to care, then ask it
  await prisma.$executeRawUnsafe(`
    INSERT INTO markets (id, question, category, status, "settlementCurrency", "initialYesProb", "confidenceInterval", "expiryTimestamp", "onChainMarketId", "resolvedOutcome", "resolvedAt", "updatedAt")
    SELECT 'm' || g, 'q' || g, 'FED', 'RESOLVED', 'USDC', 0.5, '{"lower":0.4,"upper":0.6}', now(), g, g % 2 = 0, now(), now()
    FROM generate_series(1, 2000) g`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO reasoning_traces (id, "marketId", "agentType", "decisionType", "sourcesUsed", "probabilityEstimate", "marketProbability", edge, "confidenceInterval", "createdAt", "updatedAt")
    SELECT 't' || g, 'm' || (1 + g % 2000), 'TRADER', 'OPEN_POSITION', '[]', 0.6, 0.5, 0.1, '{"lower":0.4,"upper":0.6}', now() - interval '1 day', now()
    FROM generate_series(1, 20000) g`);
  await prisma.$executeRawUnsafe('ANALYZE markets, reasoning_traces');
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`
      EXPLAIN SELECT t."marketId", t."probabilityEstimate", m."resolvedOutcome"
      FROM reasoning_traces t JOIN markets m ON m.id = t."marketId"
      WHERE m.status = 'RESOLVED' AND m."resolvedOutcome" IS NOT NULL AND t."createdAt" < m."resolvedAt"`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
  assert.match(plan, /reasoning_traces_marketId_createdAt_idx|reasoning_traces_marketId_idx/, plan);
});
