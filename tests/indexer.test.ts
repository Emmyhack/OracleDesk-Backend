import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Contract, StrKey, xdr } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// tests/fixtures/events.json: getEvents responses encoded from the contract
// specs (synthetic; real ones had aged out of RPC retention).
const FIXTURES = JSON.parse(readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'events.json'), 'utf8')).events;

function toEventResponse(raw: any) {
  return {
    ...raw,
    contractId: new Contract(raw.contractId),
    topic: raw.topic.map((t: string) => xdr.ScVal.fromXDR(t, 'base64')),
    value: xdr.ScVal.fromXDR(raw.value, 'base64'),
  };
}

async function setup(events = FIXTURES.map(toEventResponse)) {
  const { prisma } = await import('../src/lib/prisma');
  const { Prisma } = await import('@prisma/client');
  const db = {
    events: new Map<string, any>(),
    cursor: null as number | null,
    markets: new Map<string, any>([
      ['m0', { id: 'm0', onChainMarketId: 0n, question: 'Market zero?', status: 'ACTIVE' }],
    ]),
    traces: [{ id: 't0', marketId: 'm0', market: { onChainMarketId: 0n }, traceHash: 'f4b58d4ac4068163f34bd9486f0563c70873afa5f64e915ab7e85af7dee15e4e', onChainTraceId: null as bigint | null }],
    publicationUpdates: [] as Array<{ where: any; data: any }>,
    copyTrades: [] as any[],
    closedPositions: 0,
  };
  (prisma.chainEvent.create as any) = async ({ data }: any) => {
    if (db.events.has(data.id)) {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    }
    db.events.set(data.id, data);
    return data;
  };
  (prisma.chainEvent.findMany as any) = async ({ where, take }: any) =>
    [...db.events.values()]
      .filter((e) => e.published === where.published)
      .sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : 1))
      .slice(0, take);
  (prisma.chainEvent.update as any) = async ({ where, data }: any) => Object.assign(db.events.get(where.id), data);
  (prisma.indexerCursor.findUnique as any) = async () => (db.cursor === null ? null : { lastLedger: db.cursor });
  // #35: each stored event checks the outbox for a matching in-flight row.
  (prisma as any).chainTransaction = { findFirst: async () => null, findMany: async () => [], updateMany: async () => ({ count: 0 }), findUnique: async () => null };
  (prisma.indexerCursor.upsert as any) = async ({ update }: any) => { db.cursor = update.lastLedger; return {}; };
  const byChainId = (id: bigint) => [...db.markets.values()].find((m) => m.onChainMarketId === id) ?? null;
  (prisma.market.findUnique as any) = async ({ where }: any) => byChainId(where.onChainMarketId);
  (prisma.market.update as any) = async ({ where, data }: any) => Object.assign(db.markets.get(where.id), data);
  // Guarded writes (#83): where.id, status.notIn and the chainSyncedLedger OR-clause.
  (prisma.market.updateMany as any) = async ({ where, data }: any) => {
    const m = db.markets.get(where.id);
    if (!m) return { count: 0 };
    if (where.status?.notIn?.includes(m.status)) return { count: 0 };
    const ok = (where.OR ?? []).some((c: any) =>
      c.chainSyncedLedger === null ? (m.chainSyncedLedger ?? null) === null
        : (m.chainSyncedLedger ?? -1) <= c.chainSyncedLedger.lte);
    if (where.OR && !ok) return { count: 0 };
    Object.assign(m, data);
    return { count: 1 };
  };
  (prisma.position.updateMany as any) = async () => { db.closedPositions++; return { count: 1 }; };
  (prisma.$transaction as any) = async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg));
  (prisma.reasoningTrace.findFirst as any) = async ({ where }: any) => {
    return db.traces.find((t) => {
      if (t.traceHash !== where.traceHash) return false;
      if (where.market?.onChainMarketId !== undefined && t.market?.onChainMarketId !== where.market.onChainMarketId) return false;
      return true;
    }) ?? null;
  };
  (prisma.reasoningTrace.update as any) = async ({ where, data }: any) => Object.assign(db.traces.find((t) => t.id === where.id)!, data);
  (prisma.tracePublication.updateMany as any) = async ({ where, data }: any) => {
    db.publicationUpdates.push({ where, data });
    return { count: 1 };
  };
  (prisma.copyTrade.findFirst as any) = async ({ where }: any) => {
    return db.copyTrades.find((ct) => {
      if (where.txHash && ct.txHash !== where.txHash) return false;
      if (where.followerWallet && ct.followerWallet.toLowerCase() !== where.followerWallet.toLowerCase()) return false;
      if (where.outcome && ct.outcome !== where.outcome) return false;
      if (where.market?.onChainMarketId !== undefined && ct.market?.onChainMarketId !== where.market.onChainMarketId) return false;
      return true;
    }) ?? null;
  };
  (prisma.copyTrade.update as any) = async ({ where, data }: any) => {
    const ct = db.copyTrades.find((c) => c.id === where.id);
    if (ct) Object.assign(ct, data);
    return ct;
  };

  const calls: any[] = [];
  const source = {
    oldest: 4_951_500,
    latest: 4_951_700,
    async getHealth() {
      return { status: 'healthy', oldestLedger: this.oldest, latestLedger: this.latest, ledgerRetentionWindow: 120960 } as any;
    },
    async getEvents(req: any) {
      calls.push(req);
      return { events, cursor: 'end', latestLedger: this.latest, oldestLedger: this.oldest } as any;
    },
  };
  const emitted: Array<[string, any]> = [];
  const emit = (e: string, p: any) => emitted.push([e, p]);
  const { backfillEvents } = await import('../src/services/indexer.service');
  return { db, source, calls, emitted, emit, backfillEvents };
}

test('indexes trades, resolutions and traces from recorded events', async () => {
  const { db, source, calls, emitted, emit, backfillEvents } = await setup();
  const { priceYesBps } = await import('../src/generated/fpmm');

  const result = await backfillEvents(undefined, { source, emit });
  assert.equal(calls[0].startLedger, source.oldest, 'no cursor: start at the oldest retained ledger');
  assert.equal(result.stored, 4);
  assert.equal(db.cursor, source.latest);

  const trade = emitted.find(([e]) => e === 'TRADE_EXECUTED')![1];
  assert.equal(trade.onChainMarketId, '0');
  assert.equal(trade.marketId, 'm0');
  assert.equal(trade.direction, 'YES');
  assert.equal(trade.collateralRaw, '100000000');
  assert.equal(trade.priceYesBps, Number(priceYesBps(1_407_129_456n, 1_599_000_000n)));

  const m0 = db.markets.get('m0');
  assert.equal(m0.status, 'RESOLVED');
  assert.equal(m0.resolvedOutcome, true);
  assert.equal(db.closedPositions, 1, 'only the known market closes positions');
  // #83: both side effects record the ledger they reflect.
  assert.ok(m0.chainSyncedLedger > 0, 'MarketResolved sets chainSyncedLedger');

  const published = emitted.find(([e]) => e === 'REASONING_PUBLISHED')![1];
  assert.equal(published.onChainTraceId, '0');
  assert.equal(published.traceId, 't0');
  assert.equal(db.traces[0].onChainTraceId, 0n);
  // #131: indexer confirmation verifies the trace and confirms its queue row.
  assert.equal((db.traces[0] as any).verified, true);
  assert.equal(db.publicationUpdates.length, 1);
  assert.equal(db.publicationUpdates[0].where.traceId, 't0');
  assert.equal(db.publicationUpdates[0].data.status, 'CONFIRMED');
});

test('re-reading the same ledgers is idempotent', async () => {
  const { db, source, emitted, emit, backfillEvents } = await setup();
  await backfillEvents(undefined, { source, emit });
  const before = emitted.length;
  const again = await backfillEvents(source.oldest, { source, emit });
  assert.equal(again.seen, 4);
  assert.equal(again.stored, 0);
  assert.equal(emitted.length, before, 'no duplicate socket events');
  assert.equal(db.events.size, 4);
});

test('resumes from the stored cursor, and from the oldest ledger when the cursor aged out', async () => {
  const { db, source, calls, emit, backfillEvents } = await setup([]);
  db.cursor = 4_951_600;
  await backfillEvents(undefined, { source, emit });
  assert.equal(calls[calls.length - 1].startLedger, 4_951_601);

  db.cursor = 10;
  const r = await backfillEvents(undefined, { source, emit });
  assert.equal(r.startLedger, source.oldest);
  assert.equal(calls[calls.length - 1].startLedger, source.oldest);
});

test('events from other contracts are ignored', async () => {
  const foreign = { ...FIXTURES[0], id: 'x-1', contractId: StrKey.encodeContract(Buffer.alloc(32, 9)) };
  const { source, emit, backfillEvents } = await setup([toEventResponse(foreign)]);
  const r = await backfillEvents(undefined, { source, emit });
  assert.equal(r.seen, 1);
  assert.equal(r.stored, 0);
});

test('TracePublished does not link a trace whose market differs', async () => {
  const { db, source, emit, backfillEvents } = await setup();
  // Trace belongs to market with onChainMarketId 999, but event is for market 0
  db.traces[0].market = { onChainMarketId: 999n };
  db.traces[0].onChainTraceId = null;

  await backfillEvents(undefined, { source, emit });
  assert.equal(db.traces[0].onChainTraceId, null, 'trace must not be linked when on-chain market differs');
});

test('Trade event confirms a CONFIRMING copy trade with matching txHash', async () => {
  const { db, source, emit, backfillEvents } = await setup();
  const tradeEvent = FIXTURES[0]; // Trade event for market 0
  const traderTopic = xdr.ScVal.fromXDR(tradeEvent.topic[2], 'base64');
  const actualTrader = Address.fromScVal(traderTopic).toString();

  db.copyTrades.push({
    id: 'ct-1',
    txHash: tradeEvent.txHash,
    status: 'CONFIRMING',
    followerWallet: actualTrader,
    outcome: 'YES',
    amountRaw: '1000000000',
    market: { onChainMarketId: 0n },
  });

  await backfillEvents(undefined, { source, emit });
  assert.equal(db.copyTrades[0].status, 'EXECUTED');
  assert.equal(db.copyTrades[0].collateralRaw, '100000000');
});

test('an older Trade event does not overwrite a newer observation, and a resolved market stays resolved (#83)', async () => {
  const { db, source, emit, backfillEvents } = await setup();
  const m0 = db.markets.get('m0');
  m0.chainSyncedLedger = 9_999_999; // the reconciler already observed a much newer ledger
  m0.currentYesProb = 0.123;
  await backfillEvents(undefined, { source, emit });
  assert.equal(m0.currentYesProb, 0.123, 'stale trade price is skipped');
  assert.equal(m0.status, 'ACTIVE', 'the resolution is also older than the observation and is a no-op');
  assert.equal(db.closedPositions, 0);
});
