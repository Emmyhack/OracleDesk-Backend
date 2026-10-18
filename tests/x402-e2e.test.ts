/**
 * End to end (#64): the contracts repo's x402 trace API serving traces that the
 * backend's real code paths produced and pinned.
 *
 *   generateReasoningTrace → pinAndPublishDocument (dry-run) → in-memory IPFS
 *        → contracts createTraceApi (loadVerifiedTrace re-hashes the bytes)
 *
 * Hermetic: stub facilitator on loopback, in-memory IPFS, no RPC, no LLM keys.
 * Skips locally when the submodule or its deps are missing, fails in CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';
import {
  installNetworkGuard,
  loadTraceApi,
  MemoryIpfs,
  paymentHeader,
  skipOrFail,
  startStubFacilitator,
  startX402,
  type RunningX402,
  type StubFacilitator,
  type TraceApiModule,
  type TraceRecord,
} from './helpers/x402-harness';

setupTestEnv();

const PAY_TO = Keypair.random().publicKey();
const ON_CHAIN_TRACE_ID = '7';

interface Fixture {
  api: TraceApiModule;
  ipfs: MemoryIpfs;
  facilitator: StubFacilitator;
  x402: RunningX402;
  payload: Record<string, unknown>;
  record: TraceRecord;
  canonical: (v: unknown) => string;
  blocked: string[];
  teardown(): Promise<void>;
}

/** Produces a trace through the backend's real code and starts the x402 server. */
async function setup(api: TraceApiModule): Promise<Fixture> {
  const guard = installNetworkGuard();
  const { prisma } = await import('../src/lib/prisma');
  const { generateReasoningTrace } = await import('../src/services/reasoning.service');
  const { pinAndPublishDocument } = await import('../src/services/trace-publish.service');
  const { setIpfsTransport, cidForBytes } = await import('../src/services/ipfs.service');
  const { canonicalJson } = await import('../src/utils/hash.util');
  const { setContentStore } = await import('../src/services/content-store.service');

  const ipfs = new MemoryIpfs();
  const prevTransport = setIpfsTransport(ipfs.transport(cidForBytes));
  // pinJson writes through to the Postgres content store; keep it in memory.
  const prevStore = setContentStore({
    put: async () => undefined,
    get: async () => null,
    touch: async () => undefined,
    evict: async () => ({ removed: 0, freedBytes: 0 }),
  });

  // Same Prisma monkeypatching style as tests/indexer.test.ts. With no LLM
  // keys configured the hedge-condition call fails and the service applies its
  // deterministic defaults (no network is attempted).
  const originalCreate = prisma.reasoningTrace.create;
  (prisma.reasoningTrace.create as any) = async ({ data }: any) => ({ id: 'trace-uuid-1', ...data });

  let payload: Record<string, unknown>;
  try {
    const generated = await generateReasoningTrace({
      marketId: 'market-uuid-1',
      agentType: 'MARKET_MAKER',
      decisionType: 'MARKET_CREATION',
      sourcesUsed: [
        { source: 'NEWSAPI', weight: 0.7, signal: 'Fed holds rates — “unchanged” ✓ naïve café', rawValue: 0.62 },
        { source: 'FRED', weight: 0.9, signal: 'CPI 3.1%', rawValue: 0.58 },
      ],
      probabilityEstimate: 0.62,
      marketProbability: 0.5,
      edge: 0.12,
      confidenceInterval: { lower: 0.5, upper: 0.7 },
    });
    payload = { ...generated.tracePayload, onChainMarketId: null };
  } finally {
    (prisma.reasoningTrace.create as any) = originalCreate;
  }

  const pinned = await pinAndPublishDocument(
    { document: payload, name: 'trace-uuid-1', action: 'create_market', marketId: 0n },
    { dryRun: true },
  );
  const record: TraceRecord = { traceId: ON_CHAIN_TRACE_ID, ipfsCid: pinned.cid, traceHash: pinned.hash };

  const facilitator = await startStubFacilitator();
  const x402 = await startX402({
    api,
    records: [[ON_CHAIN_TRACE_ID, record]],
    ipfs,
    facilitator,
    payTo: PAY_TO,
  });

  return {
    api, ipfs, facilitator, x402, payload, record, canonical: canonicalJson, blocked: guard.blocked,
    teardown: async () => {
      await x402.close();
      await facilitator.close();
      setIpfsTransport(prevTransport);
      setContentStore(prevStore);
      guard.restore();
    },
  };
}

async function withFixture(t: test.TestContext, fn: (f: Fixture) => Promise<void>): Promise<void> {
  const loaded = await loadTraceApi();
  if (!loaded.ok) return skipOrFail(t, loaded.reason);
  const f = await setup(loaded.value);
  try {
    await fn(f);
    assert.deepEqual(f.blocked, [], 'no real network call may be attempted');
  } finally {
    await f.teardown();
  }
}

async function paid(f: Fixture, id: string): Promise<Response> {
  const url = `${f.x402.base}/traces/${id}`;
  const challenge = await fetch(url);
  assert.equal(challenge.status, 402);
  return fetch(url, { headers: { 'payment-signature': await paymentHeader(challenge) } });
}

test('unpaid request returns 402 with exact stellar requirements', async (t) => {
  await withFixture(t, async (f) => {
    const res = await fetch(`${f.x402.base}/traces/${ON_CHAIN_TRACE_ID}`);
    assert.equal(res.status, 402);
    const header = res.headers.get('payment-required');
    const required = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : await res.json();
    assert.equal(required.accepts.length, 1);
    const req = required.accepts[0];
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'stellar:testnet');
    assert.equal(req.payTo, PAY_TO);
    assert.ok(BigInt(req.amount ?? req.maxAmountRequired) > 0n);
    assert.equal(f.facilitator.calls.settle, 0, 'nothing settles without a payment');
  });
});

test('paid request returns backend-pinned trace content verified against traceHash', async (t) => {
  await withFixture(t, async (f) => {
    const res = await paid(f, ON_CHAIN_TRACE_ID);
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.traceId, ON_CHAIN_TRACE_ID);
    assert.equal(body.traceHash, f.record.traceHash);
    // content is JSON.parse(bytes): compare against the canonical form, not
    // the raw payload (which may hold undefined fields).
    assert.deepEqual(body.content, JSON.parse(f.canonical(f.payload)));
    assert.equal(f.facilitator.calls.verify, 1);
    assert.equal(f.facilitator.calls.settle, 1);
  });
});

test('tampered IPFS bytes return 502 hash verification failure', async (t) => {
  await withFixture(t, async (f) => {
    const original = f.ipfs.blobs.get(f.record.ipfsCid)!;
    const tampered = Buffer.from(original.toString('utf8').replace('"edge":0.12', '"edge":0.99'));
    assert.notDeepEqual(tampered, original, 'the fixture must actually change a byte');
    f.ipfs.blobs.set(f.record.ipfsCid, tampered);

    const res = await paid(f, ON_CHAIN_TRACE_ID);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /failed on-chain hash verification/);
  });
});

test('unknown on-chain trace id returns 404 after payment', async (t) => {
  await withFixture(t, async (f) => {
    const res = await paid(f, '999');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'Trace not found');
  });
});

test('facilitator settle failure does not serve content', async (t) => {
  await withFixture(t, async (f) => {
    f.facilitator.settleOk = false;
    const res = await paid(f, ON_CHAIN_TRACE_ID);
    assert.notEqual(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('MARKET_CREATION'), 'trace content must not leak when settlement fails');
    assert.equal(f.facilitator.calls.settle, 1);
  });
});
