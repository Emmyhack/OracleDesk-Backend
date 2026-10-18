import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import type { PublicationRow, TracePublisher } from '../src/jobs/trace-publication.worker';
import type { RegistryReader } from '../src/services/trace-audit.service';

// config validates the environment on import, so load modules after setup.
setupTestEnv();
async function load() {
  const worker = await import('../src/jobs/trace-publication.worker');
  const service = await import('../src/services/trace-publish.service');
  const { ChainError } = await import('../src/services/stellar/errors');
  const { AppError } = await import('../src/middlewares/error.middleware');
  const { TRACE_ACTIONS } = await import('../src/lib/trace-actions');
  return { ...worker, ...service, ChainError, AppError, TRACE_ACTIONS };
}

const AGENT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const HASH = 'ab'.repeat(32);

interface Store {
  pubs: Map<string, any>;
  traces: Map<string, any>;
  markets: Map<string, any>;
}

function makeDb(opts: { onChainMarketId?: bigint | null; marketStatus?: string; trace?: Record<string, unknown>; pub?: Record<string, unknown> } = {}) {
  const store: Store = { pubs: new Map(), traces: new Map(), markets: new Map() };
  store.markets.set('m1', { id: 'm1', onChainMarketId: opts.onChainMarketId ?? null, status: opts.marketStatus ?? 'PENDING' });
  store.traces.set('t1', { id: 't1', marketId: 'm1', traceHash: null, ipfsCid: null, onChainTraceId: null, verified: false, ...opts.trace });
  store.pubs.set('p1', {
    id: 'p1', traceId: 't1', action: 'create_market', payload: { decision: 'x' },
    status: 'AWAITING_PIN', attempts: 0, submittedTraceId: null, lastError: null, nextAttemptAt: new Date(0),
    ...opts.pub,
  });
  const prisma = {
    tracePublication: {
      update: async ({ where, data }: any) => Object.assign(store.pubs.get(where.id), data),
      upsert: async ({ where, create }: any) => {
        const existing = [...store.pubs.values()].find((p) => p.traceId === where.traceId);
        if (existing) return existing;
        const row = { id: `p${store.pubs.size + 1}`, status: 'AWAITING_PIN', attempts: 0, submittedTraceId: null, ...create };
        store.pubs.set(row.id, row);
        return row;
      },
    },
    reasoningTrace: {
      findUnique: async ({ where }: any) => {
        const t = store.traces.get(where.id);
        if (!t) return null;
        const m = store.markets.get(t.marketId);
        return { ...t, market: m ? { onChainMarketId: m.onChainMarketId, status: m.status } : null };
      },
      update: async ({ where, data }: any) => Object.assign(store.traces.get(where.id), data),
    },
  };
  return { store, prisma };
}

function fakePublisher(impl?: (args: any) => Promise<any>): TracePublisher & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    agent: () => AGENT,
    publish: async (args) => {
      calls.push(args);
      return impl ? impl(args) : { mode: 'live', value: 42n, txHash: 'cd'.repeat(32) };
    },
  };
}

function fakeReader(onChain: Array<{ id: bigint; agent: string; trace_hash: string }> = []): RegistryReader {
  return {
    traceCount: async () => BigInt(onChain.length),
    marketTraceCount: async () => BigInt(onChain.length),
    marketTraceAt: async (_m, i) => onChain[Number(i)].id,
    getOnChainTraceOrNull: async (id) => onChain.find((t) => t.id === id) ?? null,
  };
}

const pinOk = async () => ({ cid: 'QmPinned', hash: HASH });

function deps(prisma: any, extra: Record<string, unknown> = {}) {
  return { prisma, publisher: fakePublisher(), reader: fakeReader(), pin: pinOk, dryRun: false, maxAttempts: 5, confirmTimeoutMs: 600_000, ...extra };
}

const row = (store: Store): PublicationRow => ({ ...store.pubs.get('p1') });

test('trace for a pending market waits, then publishes once the market gets an on-chain id', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({ onChainMarketId: null });
  const publisher = fakePublisher();

  await processPublication(row(store), deps(prisma, { publisher }));
  assert.equal(store.pubs.get('p1').status, 'AWAITING_MARKET');
  assert.equal(store.traces.get('t1').traceHash, HASH, 'pinned while waiting');
  assert.ok(store.pubs.get('p1').nextAttemptAt > new Date(), 'parked for later');
  assert.equal(store.pubs.get('p1').attempts, 0, 'waiting is not an attempt');
  assert.equal(publisher.calls.length, 0);

  store.markets.get('m1').onChainMarketId = 7n;
  store.markets.get('m1').status = 'ACTIVE';
  await processPublication(row(store), deps(prisma, { publisher }));
  assert.equal(store.pubs.get('p1').status, 'SUBMITTED');
  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0].market_id, 7n);
  assert.equal(publisher.calls[0].action, 'create_market');
  assert.equal(publisher.calls[0].trace_hash.toString('hex'), HASH);
  assert.equal(store.pubs.get('p1').submittedTraceId, 42n);
  assert.equal(store.traces.get('t1').verified, false, 'a write result alone does not verify');
});

test('transient publish failure backs off and retries; AgentNotRegistered fails permanently', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const ready = { onChainMarketId: 7n, marketStatus: 'ACTIVE', trace: { traceHash: HASH, ipfsCid: 'QmPinned' }, pub: { status: 'READY' } };
  const { store, prisma } = makeDb(ready);

  const flaky = fakePublisher(async () => { throw new ChainError('publish_trace submission failed', null); });
  await processPublication(row(store), deps(prisma, { publisher: flaky }));
  assert.equal(store.pubs.get('p1').status, 'READY');
  assert.equal(store.pubs.get('p1').attempts, 1);
  assert.ok(store.pubs.get('p1').nextAttemptAt > new Date());

  const denied = fakePublisher(async () => { throw new ChainError('publish_trace simulation failed', 'AgentNotRegistered'); });
  await processPublication(row(store), deps(prisma, { publisher: denied }));
  assert.equal(store.pubs.get('p1').status, 'FAILED');
  assert.equal(store.pubs.get('p1').lastError, 'AgentNotRegistered');
});

test('pin failure keeps the payload and pins on the next pass', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({ onChainMarketId: null });
  const failingPin = async () => { throw new AppError(502, 'IPFS_UPLOAD_FAILED', 'Failed to pin document to IPFS'); };

  await processPublication(row(store), deps(prisma, { pin: failingPin }));
  assert.equal(store.pubs.get('p1').status, 'AWAITING_PIN');
  assert.equal(store.pubs.get('p1').attempts, 1);
  assert.deepEqual(store.pubs.get('p1').payload, { decision: 'x' }, 'payload is kept for the retry');

  await processPublication(row(store), deps(prisma));
  assert.equal(store.pubs.get('p1').status, 'AWAITING_MARKET');
  assert.equal(store.traces.get('t1').ipfsCid, 'QmPinned');
});

test('missing Pinata config parks the row without counting an attempt', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb();
  const notConfigured = async () => { throw new AppError(503, 'IPFS_NOT_CONFIGURED', 'not set'); };
  await processPublication(row(store), deps(prisma, { pin: notConfigured }));
  assert.equal(store.pubs.get('p1').status, 'AWAITING_PIN');
  assert.equal(store.pubs.get('p1').attempts, 0);
  assert.equal(store.pubs.get('p1').lastError, 'IPFS_NOT_CONFIGURED');
});

test('already-linked trace (indexer saw it first) is confirmed without publishing', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({
    onChainMarketId: 7n, marketStatus: 'ACTIVE',
    trace: { traceHash: HASH, ipfsCid: 'QmPinned', onChainTraceId: 5n },
    pub: { status: 'READY' },
  });
  const publisher = fakePublisher();
  await processPublication(row(store), deps(prisma, { publisher }));
  assert.equal(store.pubs.get('p1').status, 'CONFIRMED');
  assert.equal(publisher.calls.length, 0);
});

test('on-chain duplicate found via market_trace_at is confirmed without publishing', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({
    onChainMarketId: 7n, marketStatus: 'ACTIVE',
    trace: { traceHash: HASH, ipfsCid: 'QmPinned' },
    pub: { status: 'READY' },
  });
  const publisher = fakePublisher();
  const reader = fakeReader([
    { id: 10n, agent: AGENT, trace_hash: HASH },
    { id: 11n, agent: 'GOTHERAGENT', trace_hash: 'ef'.repeat(32) },
  ]);
  await processPublication(row(store), deps(prisma, { publisher, reader }));
  assert.equal(store.pubs.get('p1').status, 'CONFIRMED');
  assert.equal(store.traces.get('t1').onChainTraceId, 10n);
  assert.equal(store.traces.get('t1').verified, true);
  assert.equal(publisher.calls.length, 0, 'the same hash is never published twice');
});

test('a submission the indexer never confirmed is re-checked on-chain before retrying', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const submitted = {
    onChainMarketId: 7n, marketStatus: 'ACTIVE',
    trace: { traceHash: HASH, ipfsCid: 'QmPinned' },
    pub: { status: 'SUBMITTED', submittedTraceId: 42n },
  };
  // Landed: confirm from chain state.
  let { store, prisma } = makeDb(submitted);
  const publisher = fakePublisher();
  await processPublication(row(store), deps(prisma, { publisher, reader: fakeReader([{ id: 42n, agent: AGENT, trace_hash: HASH }]) }));
  assert.equal(store.pubs.get('p1').status, 'CONFIRMED');
  assert.equal(store.traces.get('t1').onChainTraceId, 42n);
  assert.equal(publisher.calls.length, 0);

  // Not landed: back to READY with backoff, still without publishing in this pass.
  ({ store, prisma } = makeDb(submitted));
  await processPublication(row(store), deps(prisma, { publisher }));
  assert.equal(store.pubs.get('p1').status, 'READY');
  assert.equal(store.pubs.get('p1').attempts, 1);
  assert.equal(publisher.calls.length, 0);
});

test('dry-run never confirms or sets verified', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({
    onChainMarketId: 7n, marketStatus: 'ACTIVE',
    trace: { traceHash: HASH, ipfsCid: 'QmPinned', onChainTraceId: 5n },
    pub: { status: 'READY' },
  });
  const publisher = fakePublisher(async () => ({ mode: 'dry-run', value: 99n, txHash: null }));
  const reader = fakeReader([{ id: 10n, agent: AGENT, trace_hash: HASH }]);
  await processPublication(row(store), deps(prisma, { publisher, reader, dryRun: true }));
  assert.equal(store.pubs.get('p1').status, 'READY');
  assert.equal(store.traces.get('t1').verified, false);
  assert.ok(store.pubs.get('p1').nextAttemptAt > new Date());
});

test('voided market moves AWAITING_MARKET to FAILED', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({ marketStatus: 'CANCELLED', trace: { traceHash: HASH, ipfsCid: 'QmPinned' }, pub: { status: 'AWAITING_MARKET' } });
  const publisher = fakePublisher();
  await processPublication(row(store), deps(prisma, { publisher }));
  assert.equal(store.pubs.get('p1').status, 'FAILED');
  assert.equal(store.pubs.get('p1').lastError, 'MARKET_CANCELLED');
  assert.equal(publisher.calls.length, 0);
});

test('retries stop after TRACE_PUBLISH_MAX_ATTEMPTS', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({
    onChainMarketId: 7n, marketStatus: 'ACTIVE',
    trace: { traceHash: HASH, ipfsCid: 'QmPinned' }, pub: { status: 'READY', attempts: 4 },
  });
  const flaky = fakePublisher(async () => { throw new Error('rpc timeout'); });
  await processPublication(row(store), deps(prisma, { publisher: flaky, maxAttempts: 5 }));
  assert.equal(store.pubs.get('p1').status, 'FAILED');
  assert.equal(store.pubs.get('p1').lastError, 'rpc timeout');
});

test('backoff is exponential and capped at one hour', async () => {
  const { backoffMs } = await load();
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(20), 60 * 60_000);
});

test('processTracePublications works through claimed rows', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb({ onChainMarketId: 7n, marketStatus: 'ACTIVE' });
  const publisher = fakePublisher();
  const res = await processTracePublications({ ...deps(prisma, { publisher }), claim: async () => [row(store)] });
  assert.equal(res.processed, 1);
  assert.equal(res.byStatus.SUBMITTED, 1);
  assert.equal(publisher.calls.length, 1);
});

test('enqueueTracePublication stores the payload and action once per trace', async () => {
  const { processPublication, processTracePublications, backoffMs, enqueueTracePublication, ChainError, AppError, TRACE_ACTIONS } = await load();
  const { store, prisma } = makeDb();
  store.pubs.clear();
  const payload = { decision: 'buy', traceId: 't1' };
  const first = await enqueueTracePublication({ traceId: 't1', payload, action: TRACE_ACTIONS.buyYes }, { prisma, processNow: false });
  const again = await enqueueTracePublication({ traceId: 't1', payload, action: TRACE_ACTIONS.buyYes }, { prisma, processNow: false });
  assert.equal(first.id, again.id, 'enqueue is idempotent per trace');
  assert.equal(store.pubs.size, 1);
  const stored = store.pubs.get(first.id);
  assert.equal(stored.action, 'buy_yes');
  assert.deepEqual(stored.payload, payload);
});

test('a paused agent defers its trace without burning an attempt (#79)', async () => {
  const { processPublication } = await load();
  const { AgentPausedError } = await import('../src/services/agent-controls.service');
  const ready = { onChainMarketId: 7n, marketStatus: 'ACTIVE', trace: { traceHash: HASH, ipfsCid: 'QmPinned' }, pub: { status: 'READY' } };
  const { store, prisma } = makeDb(ready);
  const paused = fakePublisher(async () => { throw new AgentPausedError('MARKET_MAKER', { reason: 'halt' }); });
  const before = Date.now();
  for (let i = 0; i < 8; i++) await processPublication(row(store), deps(prisma, { publisher: paused, maxAttempts: 3 }));
  const pub = store.pubs.get('p1');
  assert.equal(pub.status, 'READY', 'never marked FAILED by a pause');
  assert.equal(pub.attempts, 0);
  assert.ok(pub.nextAttemptAt.getTime() > before, 'retried later');
});
