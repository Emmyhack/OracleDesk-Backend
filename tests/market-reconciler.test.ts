import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const NOW = new Date('2026-10-18T12:00:00Z');
const CLOSE = Math.floor(NOW.getTime() / 1000) - 3600; // closed an hour before the observation

type Status = { tag: 'Open' } | { tag: 'Void' } | { tag: 'Resolved'; values: [{ tag: 'Yes' | 'No' }] };

function chainMarket(over: Record<string, unknown> = {}, status: Status = { tag: 'Open' }): any {
  return {
    close_time: BigInt(CLOSE),
    reserve_yes: 500n,
    reserve_no: 500n, // 50%
    question_hash: Buffer.alloc(32, 1),
    resolution_hash: Buffer.alloc(32, 2),
    meta_uri: 'ipfs://q',
    status: status.tag === 'Resolved' ? { tag: 'Resolved', values: status.values } : status,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}): any {
  return {
    id: 'm1', status: 'ACTIVE', onChainMarketId: 1n, currentYesProb: 0.5,
    expiryTimestamp: new Date(CLOSE * 1000),
    questionHash: Buffer.alloc(32, 1).toString('hex'),
    resolutionHash: Buffer.alloc(32, 2).toString('hex'),
    metaUri: 'ipfs://q',
    ...over,
  };
}

const classes = (findings: any[]) => findings.map((f) => f.driftClass).sort();

test('classifyDrift detects each class from row/chain pairs', async () => {
  const { classifyDrift } = await import('../src/services/market-reconciler.service');
  // Observation 1 hour after close: a still-ACTIVE row is closed-but-active.
  const at = NOW;
  const yes: Status = { tag: 'Resolved', values: [{ tag: 'Yes' }] };

  assert.deepEqual(classes(classifyDrift(row(), chainMarket(), 100, new Date((CLOSE + 30) * 1000))), [], 'inside the grace period nothing is wrong');
  assert.deepEqual(classes(classifyDrift(row(), chainMarket(), 100, at)), ['CLOSED_BUT_ACTIVE']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING' }), chainMarket(), 100, at)), []);
  assert.deepEqual(classes(classifyDrift(row(), chainMarket({}, yes), 100, at)), ['MISSED_RESOLUTION']);
  assert.deepEqual(classes(classifyDrift(row(), chainMarket({}, { tag: 'Void' }), 100, at)), ['MISSED_VOID']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVED' }), chainMarket({}, yes), 100, at)), []);
  assert.deepEqual(classes(classifyDrift(row({ status: 'CANCELLED' }), chainMarket({}, { tag: 'Void' }), 100, at)), []);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVED' }), chainMarket(), 100, at)), ['STATUS_REGRESSION']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'CANCELLED' }), chainMarket({}, yes), 100, at)), ['STATUS_REGRESSION'], 'voided in the DB but resolved on chain');
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', currentYesProb: 0.6 }), chainMarket(), 100, at)), ['PRICE_STALE']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', currentYesProb: 0.504 }), chainMarket(), 100, at)), [], 'within 0.5pp');
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', expiryTimestamp: new Date((CLOSE + 99) * 1000) }), chainMarket(), 100, at)), ['CLOSE_TIME_MISMATCH']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', questionHash: 'aa'.repeat(32) }), chainMarket(), 100, at)), ['HASH_MISMATCH']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', metaUri: 'ipfs://other' }), chainMarket(), 100, at)), ['HASH_MISMATCH']);
  assert.deepEqual(classes(classifyDrift(row({ status: 'RESOLVING', resolutionHash: null, questionHash: null, metaUri: null }), chainMarket(), 100, at)), [], 'unset columns are not drift');
});

// ─── Stubbed database ────────────────────────────────────────────────────────

async function setup(markets: any[], opts: { cursor?: number | null; indexerOn?: boolean; priorReports?: any[] } = {}) {
  const { prisma } = await import('../src/lib/prisma');
  const { ChainError } = await import('../src/services/stellar/errors');
  const db = {
    markets: new Map<string, any>(markets.map((m) => [m.id, { chainSyncedLedger: null, lastReconciledAt: null, ...m }])),
    positionsClosed: [] as any[],
    reports: [] as any[],
    runs: new Map<string, any>(),
    logs: [] as any[],
    reads: [] as bigint[],
  };
  const chain = new Map<bigint, { market: any; ledger: number } | 'notfound' | 'rpcerror'>();

  (prisma.market.findMany as any) = async ({ where, take }: any) =>
    [...db.markets.values()]
      .filter((m) => m.onChainMarketId !== null && where.status.in.includes(m.status))
      .sort((a, b) => (a.lastReconciledAt?.getTime() ?? -1) - (b.lastReconciledAt?.getTime() ?? -1))
      .slice(0, take);
  (prisma.market.updateMany as any) = async ({ where, data }: any) => {
    const targets = where.id.in ? where.id.in.map((i: string) => db.markets.get(i)) : [db.markets.get(where.id)];
    let count = 0;
    for (const m of targets) {
      if (!m) continue;
      if (where.status && typeof where.status === 'string' && m.status !== where.status) continue;
      if (where.status?.notIn?.includes(m.status)) continue;
      if (where.OR) {
        const ok = where.OR.some((c: any) =>
          c.chainSyncedLedger === null ? m.chainSyncedLedger === null
            : c.chainSyncedLedger.lt !== undefined ? (m.chainSyncedLedger ?? -1) < c.chainSyncedLedger.lt
            : (m.chainSyncedLedger ?? -1) <= c.chainSyncedLedger.lte);
        if (!ok) continue;
      }
      Object.assign(m, data);
      count++;
    }
    return { count };
  };
  (prisma.position.updateMany as any) = async ({ where, data }: any) => { db.positionsClosed.push({ where, data }); return { count: 1 }; };
  (prisma.$transaction as any) = async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg));
  (prisma.reconcileRun.create as any) = async ({ data }: any) => { db.runs.set(data.id, { ...data }); return data; };
  (prisma.reconcileRun.update as any) = async ({ where, data }: any) => Object.assign(db.runs.get(where.id), data);
  (prisma.marketDriftReport.createMany as any) = async ({ data }: any) => { db.reports.push(...data); return { count: data.length }; };
  (prisma.marketDriftReport.findMany as any) = async ({ where, take }: any) =>
    (opts.priorReports ?? []).filter((r) => r.marketId === where.marketId && r.driftClass === where.driftClass).slice(0, take);
  (prisma.agentLog.create as any) = async ({ data }: any) => { db.logs.push(data); return data; };

  const emitted: any[] = [];
  const deps = {
    fetchMarket: async (id: bigint) => {
      db.reads.push(id);
      const hit = chain.get(id);
      if (hit === 'notfound') throw new ChainError('get_market failed: MarketNotFound', 'MarketNotFound');
      if (hit === 'rpcerror' || !hit) throw new ChainError('get_market read failed', null);
      return hit;
    },
    ledgerCloseTime: async () => NOW,
    indexerCursor: async () => (opts.cursor === undefined ? 1000 : opts.cursor),
    indexerEnabled: () => opts.indexerOn ?? true,
    emit: (e: string, p: unknown) => emitted.push([e, p]),
  };
  const { reconcileMarkets } = await import('../src/services/market-reconciler.service');
  const run = (over: Record<string, unknown> = {}) =>
    reconcileMarkets({ maxMarkets: 50, concurrency: 2, dryRun: false, now: NOW, ...over }, deps);
  return { db, chain, run, emitted };
}

const yes: Status = { tag: 'Resolved', values: [{ tag: 'Yes' }] };
const byClass = (db: any, c: string) => db.reports.filter((r: any) => r.driftClass === c);

test('a missed resolution is repaired through applyMarketFinality and closes positions', async () => {
  const { db, chain, run } = await setup([row()], { cursor: 1000 });
  chain.set(1n, { market: chainMarket({}, yes), ledger: 1005 });
  const summary = await run();
  const m = db.markets.get('m1');
  assert.equal(m.status, 'RESOLVED');
  assert.equal(m.resolvedOutcome, true);
  assert.equal(m.chainSyncedLedger, 1005);
  assert.equal(db.positionsClosed[0].data.closeReason, 'YES_RESOLVED');
  assert.equal(byClass(db, 'MISSED_RESOLUTION')[0].action, 'REPAIRED');
  assert.equal(byClass(db, 'MISSED_RESOLUTION')[0].chainValue.resolvedAtApproximate, true);
  assert.equal(summary.repaired, 1);
  assert.ok(m.lastReconciledAt);
});

test('a void on chain sets CANCELLED with the VOIDED close reason', async () => {
  const { db, chain, run } = await setup([row()]);
  chain.set(1n, { market: chainMarket({}, { tag: 'Void' }), ledger: 1001 });
  await run();
  assert.equal(db.markets.get('m1').status, 'CANCELLED');
  assert.equal(db.markets.get('m1').resolvedOutcome, null);
  assert.equal(db.positionsClosed[0].data.closeReason, 'VOIDED');
  assert.equal(byClass(db, 'MISSED_VOID')[0].action, 'REPAIRED');
});

test('a closed-but-active market moves to RESOLVING using ledger time with grace', async () => {
  const { db, chain, run } = await setup([row(), row({ id: 'm2', onChainMarketId: 2n })]);
  chain.set(1n, { market: chainMarket(), ledger: 1002 });
  // m2 closed 30 seconds before the observation ledger: inside the 60 s grace.
  chain.set(2n, { market: chainMarket({ close_time: BigInt(Math.floor(NOW.getTime() / 1000) - 30) }), ledger: 1002 });
  db.markets.get('m2').expiryTimestamp = new Date((Math.floor(NOW.getTime() / 1000) - 30) * 1000);
  await run();
  assert.equal(db.markets.get('m1').status, 'RESOLVING');
  assert.equal(db.markets.get('m2').status, 'ACTIVE');
});

test('stale price and close time are repaired in one guarded write', async () => {
  const { db, chain, run } = await setup([row({ status: 'RESOLVING', currentYesProb: 0.9, expiryTimestamp: new Date((CLOSE + 500) * 1000) })]);
  chain.set(1n, { market: chainMarket(), ledger: 1003 });
  await run();
  const m = db.markets.get('m1');
  assert.equal(m.currentYesProb, 0.5);
  assert.equal(m.expiryTimestamp.getTime(), CLOSE * 1000);
  assert.equal(byClass(db, 'PRICE_STALE')[0].action, 'REPAIRED');
  assert.equal(byClass(db, 'CLOSE_TIME_MISMATCH')[0].action, 'REPAIRED');
});

test('hash mismatch is reported, logged at ERROR and never repaired', async () => {
  const { db, chain, run, emitted } = await setup([
    row({ status: 'RESOLVING', questionHash: 'cc'.repeat(32), expiryTimestamp: new Date((CLOSE + 500) * 1000) }),
  ]);
  chain.set(1n, { market: chainMarket(), ledger: 1004 });
  await run();
  const m = db.markets.get('m1');
  assert.equal(m.questionHash, 'cc'.repeat(32), 'hash left alone');
  assert.equal(m.expiryTimestamp.getTime(), (CLOSE + 500) * 1000, 'close time is not repaired next to a hash mismatch');
  assert.equal(byClass(db, 'HASH_MISMATCH')[0].action, 'REPORTED');
  assert.equal(byClass(db, 'CLOSE_TIME_MISMATCH')[0].action, 'REPORTED');
  assert.equal(db.logs.length, 1);
  assert.equal(db.logs[0].level, 'ERROR');
  assert.equal(db.logs[0].action, 'MARKET_INTEGRITY_DRIFT');
  assert.equal(emitted[0][0], 'MARKET_DRIFT');
});

test('status regression and not-found are reported only', async () => {
  const { db, chain, run } = await setup([row({ status: 'RESOLVED' }), row({ id: 'm2', onChainMarketId: 2n })]);
  chain.set(1n, { market: chainMarket(), ledger: 1004 });
  chain.set(2n, 'notfound');
  await run();
  assert.equal(db.markets.get('m1').status, 'RESOLVED');
  assert.equal(byClass(db, 'STATUS_REGRESSION')[0].action, 'REPORTED');
  assert.equal(byClass(db, 'NOT_FOUND_ON_CHAIN')[0].action, 'REPORTED');
  assert.equal(db.logs.length, 2);
});

test('RPC errors other than MarketNotFound are not drift', async () => {
  const { db, chain, run } = await setup([row()]);
  chain.set(1n, 'rpcerror');
  const summary = await run();
  assert.equal(summary.rpcErrors, 1);
  assert.equal(db.reports.length, 0);
  assert.equal(db.markets.get('m1').lastReconciledAt, null, 'unread markets stay first in line');
});

test('indexer behind the observation defers resolution findings; forced after 3 runs', async () => {
  // Observation at ledger 5000, indexer at 1000 (lag limit 20).
  const first = await setup([row()], { cursor: 1000 });
  first.chain.set(1n, { market: chainMarket({}, yes), ledger: 5000 });
  await first.run();
  assert.equal(first.db.markets.get('m1').status, 'ACTIVE', 'left for the indexer');
  assert.equal(byClass(first.db, 'MISSED_RESOLUTION')[0].action, 'DEFERRED');

  // Two earlier runs already deferred it: this one repairs and flags it.
  const prior = [1, 2].map(() => ({ marketId: 'm1', driftClass: 'MISSED_RESOLUTION', action: 'DEFERRED' }));
  const third = await setup([row()], { cursor: 1000, priorReports: prior });
  third.chain.set(1n, { market: chainMarket({}, yes), ledger: 5000 });
  await third.run();
  assert.equal(third.db.markets.get('m1').status, 'RESOLVED');
  const forced = byClass(third.db, 'MISSED_RESOLUTION')[0];
  assert.equal(forced.action, 'REPAIRED');
  assert.equal(forced.chainValue.forced, true);

  // With the indexer disabled nothing is deferred.
  const off = await setup([row()], { cursor: 1000, indexerOn: false });
  off.chain.set(1n, { market: chainMarket({}, yes), ledger: 5000 });
  await off.run();
  assert.equal(off.db.markets.get('m1').status, 'RESOLVED');
});

test('a conditional update loses to a newer chainSyncedLedger (SKIPPED_NEWER)', async () => {
  const { db, chain, run } = await setup([row({ status: 'RESOLVING', currentYesProb: 0.9, chainSyncedLedger: 2000 })]);
  chain.set(1n, { market: chainMarket(), ledger: 1500 }); // observation older than what the row has seen
  const summary = await run();
  assert.equal(db.markets.get('m1').currentYesProb, 0.9, 'older observation never overwrites');
  assert.equal(byClass(db, 'PRICE_STALE')[0].action, 'SKIPPED_NEWER');
  assert.equal(summary.skippedNewer, 1);

  // A resolution that lost the race is also skipped and closes nothing.
  const race = await setup([row({ chainSyncedLedger: 2000 })], { cursor: 1500 });
  race.chain.set(1n, { market: chainMarket({}, yes), ledger: 1500 });
  await race.run();
  assert.equal(race.db.markets.get('m1').status, 'ACTIVE');
  assert.equal(race.db.positionsClosed.length, 0);
  assert.equal(byClass(race.db, 'MISSED_RESOLUTION')[0].action, 'SKIPPED_NEWER');
});

test('dry run records everything as REPORTED and writes nothing to markets', async () => {
  const { db, chain, run } = await setup([row()]);
  chain.set(1n, { market: chainMarket({}, yes), ledger: 1005 });
  await run({ dryRun: true });
  assert.equal(db.markets.get('m1').status, 'ACTIVE');
  assert.equal(byClass(db, 'MISSED_RESOLUTION')[0].action, 'REPORTED');
  assert.equal(db.markets.get('m1').lastReconciledAt, null);
});

test('the RPC budget stops the run and the rest are picked first next time', async () => {
  const rows = [1, 2, 3].map((i) => row({ id: `m${i}`, onChainMarketId: BigInt(i), status: 'RESOLVING' }));
  const { db, chain, run } = await setup(rows);
  for (const i of [1n, 2n, 3n]) chain.set(i, { market: chainMarket(), ledger: 1001 });
  const first = await run({ maxRpcCalls: 2, concurrency: 1 });
  assert.equal(first.rpcCalls, 2);
  assert.equal(first.scanned, 2);
  const untouched = [...db.markets.values()].filter((m) => m.lastReconciledAt === null);
  assert.equal(untouched.length, 1);

  db.reads.length = 0;
  await run({ maxRpcCalls: 1, concurrency: 1 });
  assert.deepEqual(db.reads, [BigInt(untouched[0].id.slice(1))], 'the never-reconciled market goes first');
});
