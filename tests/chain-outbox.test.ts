import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

type Outbox = typeof import('../src/services/stellar/outbox');
type Row = import('../src/services/stellar/outbox').ChainTransactionRow;
type Store = import('../src/services/stellar/outbox').OutboxStore;

const load = () => import('../src/services/stellar/outbox');

const AGENT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const NOW_SECS = 1_800_000_000;

// ─── Fakes ───────────────────────────────────────────────────────────────────

const blankRow = (): Omit<Row, 'id' | 'kind'> => ({
  refId: null, contract: null, method: null, args: null, simulated: null, source: null,
  sequence: null, hash: null, envelopeXdr: null, status: 'BUILT', submitLedger: null,
  minTime: null, maxTime: null, ledger: null, resultXdr: null, returnValue: null,
  innerFee: null, resourceFee: null, feeBumpHashes: [], feeBumpEnvelopes: null,
  landedHash: null, bumpAttempts: 0, attempts: 0, error: null, handledAt: null,
  updatedAt: new Date(0),
});

/** In-memory OutboxStore with compare-and-set transitions and a status history. */
function memoryStore() {
  const rows = new Map<string, Row>();
  let n = 0;
  const history: string[] = [];
  const terminal = ['SUCCESS', 'FAILED', 'EXPIRED'];
  const store: Store & { rows: Map<string, Row>; history: string[]; seed(data: Partial<Row> & { kind: string }): Row } = {
    rows,
    history,
    seed(data) {
      const row: Row = { ...blankRow(), id: `ob${++n}`, ...data } as Row;
      rows.set(row.id, row);
      return row;
    },
    async create(data) {
      const row = store.seed(data);
      history.push(`${row.id}:${row.status}`);
      return { ...row };
    },
    async transition(id, from, to, patch = {}) {
      const row = rows.get(id);
      if (!row || !from.includes(row.status as never)) return null;
      Object.assign(row, patch, { status: to, updatedAt: new Date() });
      history.push(`${id}:${to}`);
      return { ...row };
    },
    async findInFlight(now, graceMs) {
      const cutoff = now.getTime() - graceMs;
      return [...rows.values()]
        .filter((r) =>
          r.status === 'SUBMITTED' || r.status === 'PENDING'
            ? true
            : (r.status === 'BUILT' || r.status === 'SIGNED') && (r.updatedAt?.getTime() ?? 0) < cutoff,
        )
        .map((r) => ({ ...r }));
    },
    async findUnhandled() {
      return [...rows.values()].filter((r) => terminal.includes(r.status) && !r.handledAt).map((r) => ({ ...r }));
    },
    async findByAnyHash(hashes) {
      const row = [...rows.values()].find(
        (r) => (r.hash && hashes.includes(r.hash)) || (r.landedHash && hashes.includes(r.landedHash)) || r.feeBumpHashes.some((h) => hashes.includes(h)),
      );
      return row ? { ...row } : null;
    },
    async findById(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async markHandled(id) {
      const row = rows.get(id);
      if (row && !row.handledAt) row.handledAt = new Date();
    },
    async recordBump(row, outerHash, envelope) {
      const live = rows.get(row.id);
      if (!live || live.bumpAttempts !== row.bumpAttempts) return false;
      live.bumpAttempts += 1;
      live.feeBumpHashes = [...live.feeBumpHashes, outerHash];
      live.feeBumpEnvelopes = [...((live.feeBumpEnvelopes as unknown[]) ?? []), envelope];
      return true;
    },
    async recordError(id, error) {
      const row = rows.get(id);
      if (row) row.error = error;
    },
  };
  return store;
}

const NOT_FOUND = (over: Record<string, unknown> = {}) => ({
  status: 'NOT_FOUND',
  latestLedgerCloseTime: NOW_SECS,
  oldestLedgerCloseTime: NOW_SECS - 100_000,
  ...over,
});

function fakeServer(byHash: Record<string, unknown>, opts: { onSend?: (tx: unknown) => unknown } = {}) {
  const sent: unknown[] = [];
  return {
    sent,
    async getTransaction(hash: string) {
      return (byHash[hash] ?? NOT_FOUND()) as never;
    },
    async sendTransaction(tx: unknown) {
      sent.push(tx);
      return (opts.onSend ? opts.onSend(tx) : { status: 'PENDING', latestLedger: 100 }) as never;
    },
    async getLatestLedger() {
      return { sequence: 100 } as never;
    },
  };
}

/** A real signed Soroban transaction, so the stored envelope round-trips XDR. */
function signedTx(): { envelopeXdr: string; hash: string } {
  const source = Keypair.random();
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
  const tx = new TransactionBuilder(new Account(source.publicKey(), '100'), { fee: '5200', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: 'noop',
            args: [],
          }),
        ),
        auth: [],
      }),
    )
    .setSorobanData(new SorobanDataBuilder().setResourceFee(5000).build())
    .setTimeout(300)
    .build();
  tx.sign(source);
  return { envelopeXdr: tx.toXDR(), hash: tx.hash().toString('hex') };
}

async function withTestHandlers(outbox: Outbox, handlers: Record<string, (row: Row, outcome: { status: string; value?: unknown }) => Promise<void>>, fn: () => Promise<void>) {
  outbox.clearHandlersForTest();
  for (const [kind, h] of Object.entries(handlers)) outbox.registerHandler(kind, h as never);
  try {
    await fn();
  } finally {
    outbox.clearHandlersForTest();
  }
}

// ─── Recovery: crash between every pair of states ────────────────────────────

test('crash after BUILT (never signed): recovery fails the row and runs the handler once', async () => {
  const outbox = await load();
  const store = memoryStore();
  store.seed({ kind: 'test.kind', status: 'BUILT' });
  const outcomes: string[] = [];
  await withTestHandlers(outbox, { 'test.kind': async (_r, o) => void outcomes.push(o.status) }, async () => {
    const server = fakeServer({});
    const stats = await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS, signedGraceMs: 0 });
    assert.equal(stats.resolved, 1);
    const row = [...store.rows.values()][0];
    assert.equal(row.status, 'FAILED');
    assert.equal(row.error, 'abandoned before signing');
    assert.ok(row.handledAt);
    assert.deepEqual(outcomes, ['FAILED']);
    // A second pass is a no-op.
    await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS, signedGraceMs: 0 });
    assert.deepEqual(outcomes, ['FAILED']);
  });
});

test('crash after SIGNED before send: recovery resubmits the stored envelope with the same hash', async () => {
  const outbox = await load();
  const store = memoryStore();
  const { envelopeXdr, hash } = signedTx();
  store.seed({ kind: 'test.kind', status: 'SIGNED', hash, envelopeXdr, maxTime: BigInt(NOW_SECS + 600) });

  const server = fakeServer({});
  await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS, signedGraceMs: 0 });

  assert.equal(server.sent.length, 1);
  const resubmitted = server.sent[0] as { hash(): Buffer };
  assert.equal(resubmitted.hash().toString('hex'), hash, 'resubmission is byte-for-byte: same hash');
  const row = [...store.rows.values()][0];
  assert.equal(row.status, 'SUBMITTED');
  assert.equal(row.submitLedger, 100);
});

test('a DUPLICATE send response is treated as submitted, not as an error', async () => {
  const outbox = await load();
  const store = memoryStore();
  const { envelopeXdr, hash } = signedTx();
  store.seed({ kind: 'test.kind', status: 'SIGNED', hash, envelopeXdr, maxTime: BigInt(NOW_SECS + 600) });

  const server = fakeServer({}, { onSend: () => ({ status: 'DUPLICATE', latestLedger: 101 }) });
  await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS, signedGraceMs: 0 });
  assert.equal([...store.rows.values()][0].status, 'SUBMITTED');
});

test('crash after SUBMITTED: recovery finds SUCCESS, decodes the value and creates the Position once', async () => {
  const outbox = await load();
  const { handleTradeBuyOutcome } = await import('../src/services/trade.service');
  const { prisma } = await import('../src/lib/prisma');
  const { Prisma } = await import('@prisma/client');

  const db = {
    trade: { id: 't1', marketId: 'm1', direction: 'YES', amount: 4, status: 'PENDING' } as Record<string, unknown>,
    positions: new Map<string, unknown>(),
  };
  (prisma.trade.findUnique as unknown) = async () => ({ ...db.trade });
  (prisma.trade.updateMany as unknown) = async ({ where, data }: { where: { status: { in: string[] } }; data: object }) => {
    if (!where.status.in.includes(db.trade.status as string)) return { count: 0 };
    Object.assign(db.trade, data);
    return { count: 1 };
  };
  (prisma.position.create as unknown) = async ({ data }: { data: { tradeId: string } }) => {
    if (db.positions.has(data.tradeId)) {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    }
    db.positions.set(data.tradeId, data);
    return data;
  };

  const store = memoryStore();
  const row = store.seed({
    kind: 'trade.buy',
    refId: 't1',
    contract: 'treasury',
    method: 'agent_buy',
    args: { collateral_in: '40000000', feeRaw: '400000' },
    status: 'SUBMITTED',
    hash: 'ab'.repeat(32),
    envelopeXdr: 'unused',
    maxTime: BigInt(NOW_SECS + 600),
  });

  const server = fakeServer({
    [row.hash!]: { status: 'SUCCESS', returnValue: nativeToScVal(777n, { type: 'i128' }), ledger: 101 },
  });

  await withTestHandlers(outbox, { 'trade.buy': handleTradeBuyOutcome as never }, async () => {
    await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS });
    const after = store.rows.get(row.id)!;
    assert.equal(after.status, 'SUCCESS');
    assert.equal(after.landedHash, row.hash);
    assert.equal(after.ledger, 101);
    assert.ok(after.handledAt);
    assert.equal(db.trade.status, 'EXECUTED');
    assert.equal(db.positions.size, 1);
    const position = db.positions.get('t1') as { sharesRaw: string; costBasisRaw: string; feesPaidRaw: string };
    assert.equal(position.sharesRaw, '777');
    assert.equal(position.costBasisRaw, '40000000');
    assert.equal(position.feesPaidRaw, '400000');

    // Crash after SUCCESS before the handler: simulate by clearing handledAt.
    store.rows.get(row.id)!.handledAt = null;
    db.trade.status = 'EXECUTED'; // already executed: the re-run must be a no-op
    await outbox.recoverInFlight({ server: server as never, store, now: () => NOW_SECS });
    assert.ok(store.rows.get(row.id)!.handledAt, 'the unhandled sweep re-ran the handler');
    assert.equal(db.positions.size, 1, 'the Position was not created twice');
  });
});

test('NOT_FOUND past maxTime marks EXPIRED and fails the Trade', async () => {
  const outbox = await load();
  const { handleTradeBuyOutcome } = await import('../src/services/trade.service');
  const { prisma } = await import('../src/lib/prisma');
  const trade: Record<string, unknown> = { id: 't2', status: 'PENDING' };
  (prisma.trade.updateMany as unknown) = async ({ where, data }: { where: { status: string }; data: object }) => {
    if (trade.status !== where.status) return { count: 0 };
    Object.assign(trade, data);
    return { count: 1 };
  };

  const store = memoryStore();
  const row = store.seed({
    kind: 'trade.buy',
    refId: 't2',
    status: 'SUBMITTED',
    hash: 'cd'.repeat(32),
    envelopeXdr: 'unused',
    maxTime: BigInt(NOW_SECS - 600), // already past
  });

  await withTestHandlers(outbox, { 'trade.buy': handleTradeBuyOutcome as never }, async () => {
    const stats = await outbox.recoverInFlight({ server: fakeServer({}) as never, store, now: () => NOW_SECS });
    assert.equal(stats.expired, 1);
    assert.equal(store.rows.get(row.id)!.status, 'EXPIRED');
    assert.equal(trade.status, 'FAILED');
    assert.equal(trade.errorMessage, 'expired unsubmitted');
  });
});

test('concurrent recoverers cannot double-apply: the transition is compare-and-set', async () => {
  const outbox = await load();
  const store = memoryStore();
  const row = store.seed({
    kind: 'test.kind',
    status: 'SUBMITTED',
    hash: 'ef'.repeat(32),
    envelopeXdr: 'unused',
    maxTime: BigInt(NOW_SECS + 600),
  });
  let runs = 0;
  await withTestHandlers(outbox, { 'test.kind': async () => void runs++ }, async () => {
    const server = fakeServer({ [row.hash!]: { status: 'SUCCESS', ledger: 7 } });
    const fresh = (await store.findById(row.id))!;
    await Promise.all([
      outbox.recoverRow({ ...fresh }, { server: server as never, store, now: () => NOW_SECS }),
      outbox.recoverRow({ ...fresh }, { server: server as never, store, now: () => NOW_SECS }),
    ]);
    assert.equal(store.rows.get(row.id)!.status, 'SUCCESS');
    assert.equal(store.history.filter((h) => h === `${row.id}:SUCCESS`).length, 1, 'only one SUCCESS transition applied');
    assert.equal(runs, 1, 'the handler ran once');
  });
});

test('an indexed event with a matching txHash triggers recovery (recoverByTxHash)', async () => {
  const outbox = await load();
  const store = memoryStore();
  const row = store.seed({
    kind: 'test.kind',
    status: 'SUBMITTED',
    hash: '12'.repeat(32),
    envelopeXdr: 'unused',
    maxTime: BigInt(NOW_SECS + 600),
  });
  await withTestHandlers(outbox, {}, async () => {
    const server = fakeServer({ [row.hash!]: { status: 'SUCCESS', ledger: 9 } });
    await outbox.recoverByTxHash(row.hash!, { server: server as never, store, now: () => NOW_SECS });
    assert.equal(store.rows.get(row.id)!.status, 'SUCCESS');
    // A terminal row is left alone.
    await outbox.recoverByTxHash(row.hash!, { server: fakeServer({}) as never, store, now: () => NOW_SECS });
    assert.equal(store.rows.get(row.id)!.status, 'SUCCESS');
  });
});

test('market.create handler links once and never overwrites a different onChainMarketId', async () => {
  const outbox = await load();
  const { handleMarketCreateOutcome } = await import('../src/services/market-chain.service');
  const { prisma } = await import('../src/lib/prisma');
  const idempotency = await import('../src/services/market-idempotency.service');

  const market: Record<string, unknown> = { id: 'm1', onChainMarketId: null };
  (prisma.market.findUnique as unknown) = async () => ({ onChainMarketId: market.onChainMarketId });
  const links: Array<{ id: bigint; txHash: string | null }> = [];
  (idempotency as { linkLandedMarket: unknown }).linkLandedMarket = async (_marketId: string, onChainId: bigint, txHash?: string | null) => {
    links.push({ id: onChainId, txHash: txHash ?? null });
    market.onChainMarketId = onChainId;
    return true;
  };

  const row = { ...blankRow(), id: 'ob-m', kind: 'market.create', refId: 'm1', hash: 'aa'.repeat(32) } as Row;
  await handleMarketCreateOutcome(row, { status: 'SUCCESS', value: 5n, txHash: 'aa'.repeat(32) });
  assert.deepEqual(links, [{ id: 5n, txHash: 'aa'.repeat(32) }]);

  // Re-run with the same id: no second link. With a different id: refused.
  await handleMarketCreateOutcome(row, { status: 'SUCCESS', value: 5n, txHash: 'aa'.repeat(32) });
  await handleMarketCreateOutcome(row, { status: 'SUCCESS', value: 6n, txHash: 'bb'.repeat(32) });
  assert.equal(links.length, 1);
  assert.equal(market.onChainMarketId, 5n);
  void outbox;
});

// ─── The live write path drives the state machine ────────────────────────────

interface WriteHarness {
  rows: Map<string, Record<string, unknown>>;
  history: string[];
  sent: unknown[];
  chain: typeof import('../src/services/chain.service');
  config: Record<string, unknown>;
}

async function writeHarness(opts: {
  sendStatus?: string;
  sendErrorResult?: unknown;
  getTransaction?: (hash: string) => unknown;
}): Promise<WriteHarness> {
  const { prisma } = await import('../src/lib/prisma');
  const chain = await import('../src/services/chain.service');
  const { config } = await import('../src/config');
  const clients = await import('../src/services/stellar/clients');
  const sequence = await import('../src/services/stellar/sequence');
  const channels = await import('../src/services/stellar/channels');
  const controls = await import('../src/services/agent-controls.service');
  const txInspect = await import('../src/services/stellar/tx-inspect');

  (config as Record<string, unknown>).CHAIN_EXECUTION_MODE = 'live';
  (config as Record<string, unknown>).CHAIN_RETRY_MAX_ATTEMPTS = 1;

  // In-memory prisma.chainTransaction backing prismaOutboxStore().
  const rows = new Map<string, Record<string, unknown>>();
  const history: string[] = [];
  let n = 0;
  const matches = (row: Record<string, unknown>, where: Record<string, any>) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status?.in !== undefined && !where.status.in.includes(row.status)) return false;
    if (where.handledAt === null && row.handledAt != null) return false;
    return true;
  };
  (prisma as Record<string, any>).chainTransaction = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { ...blankRow(), id: `ob${++n}`, ...data };
      rows.set(row.id as string, row);
      history.push(String(row.status));
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        Object.assign(row, data, { updatedAt: new Date() });
        if (data.status) history.push(String(data.status));
        count++;
      }
      return { count };
    },
    findUnique: async ({ where }: { where: { id?: string; hash?: string } }) => {
      const row = where.id
        ? rows.get(where.id)
        : [...rows.values()].find((r) => r.hash === where.hash);
      return row ? { ...row } : null;
    },
    findFirst: async () => null,
    findMany: async () => [],
    upsert: async () => ({}),
  };
  (prisma as Record<string, any>).chainSubmission = { upsert: async () => ({}) };
  (prisma as Record<string, any>).chainFee = { upsert: async () => ({}) };

  // Agent controls and sequencing are out of scope here.
  (controls as Record<string, unknown>).assertAgentActive = async () => 1;
  (controls as Record<string, unknown>).assertAgentActiveLocked = async () => 1;
  (controls as Record<string, unknown>).recordChainWriteOutcome = async () => undefined;
  (sequence as Record<string, unknown>).withSourceAccount = async (_account: string, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ account: { accountId: () => AGENT }, assertHeld: () => undefined, advanceSequence: async () => undefined, resync: async () => undefined });
  (sequence as Record<string, unknown>).rebuildWithSequence = (built: unknown) => built;
  (channels as Record<string, unknown>).getChannelPool = () => ({ size: 0 });
  (clients as Record<string, unknown>).agentSigner = () => ({ publicKey: AGENT });

  const { envelopeXdr, hash } = signedTx();
  const maxTime = NOW_SECS + 300;
  const fakeTx = {
    simulation: { minResourceFee: '100', latestLedger: 50, latestLedgerCloseTime: NOW_SECS },
    result: 777n,
    built: {
      fee: '0',
      timeBounds: { minTime: '0', maxTime: String(maxTime) },
      sequence: '42',
      hash: () => Buffer.from(hash, 'hex'),
      toXDR: () => envelopeXdr,
    },
    sign: async () => undefined,
  };
  (clients as Record<string, any>).agentClients.treasury = () => ({ agent_buy: async () => fakeTx });

  const sent: unknown[] = [];
  txInspect.setTransactionSender({
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return {
        status: opts.sendStatus ?? 'PENDING',
        hash,
        latestLedger: 51,
        latestLedgerCloseTime: NOW_SECS,
        ...(opts.sendErrorResult ? { errorResult: opts.sendErrorResult } : {}),
      } as never;
    },
  } as never);
  txInspect.setTransactionReader({
    getTransaction: async (h: string) =>
      (opts.getTransaction ? opts.getTransaction(h) : { status: 'SUCCESS', returnValue: nativeToScVal(777n, { type: 'i128' }), ledger: 60 }) as never,
  } as never);

  return { rows, history, sent, chain, config: config as Record<string, unknown> };
}

test('a successful write persists BUILT → SIGNED → SUBMITTED → SUCCESS and runs the handler once', async () => {
  const outbox = await load();
  const h = await writeHarness({});
  let handled = 0;
  await withTestHandlers(outbox, { 'test.buy': async () => void handled++ }, async () => {
    const result = await h.chain.agentBuy(
      { market_id: 1n, outcome: h.chain.Outcomes.Yes, collateral_in: 40_000_000n, min_shares_out: 1n },
      undefined,
      {},
      { kind: 'test.buy', refId: 't1' },
    );
    assert.equal(result.mode, 'live');
    assert.equal(result.value, 777n);
    assert.ok(result.outboxId);
    assert.deepEqual(h.history, ['BUILT', 'SIGNED', 'SUBMITTED', 'SUCCESS']);
    const row = [...h.rows.values()][0];
    assert.equal(row.status, 'SUCCESS');
    assert.ok(row.envelopeXdr, 'the signed envelope was persisted before send');
    assert.ok(row.hash);
    assert.equal(String(row.returnValue), '777');
    assert.ok(row.handledAt);
    assert.equal(handled, 1);
    assert.equal(h.sent.length, 1);
  });
});

test('the inline wait timeout returns ChainPending and leaves the row PENDING for the worker', async () => {
  const outbox = await load();
  const h = await writeHarness({ getTransaction: () => NOT_FOUND({ latestLedgerCloseTime: NOW_SECS }) });
  (h.config as Record<string, unknown>).OUTBOX_INLINE_WAIT_MS = 1000;
  let handled = 0;
  await withTestHandlers(outbox, { 'test.buy': async () => void handled++ }, async () => {
    await assert.rejects(
      h.chain.agentBuy(
        { market_id: 1n, outcome: h.chain.Outcomes.Yes, collateral_in: 40_000_000n, min_shares_out: 1n },
        undefined,
        {},
        { kind: 'test.buy', refId: 't1' },
      ),
      (err: unknown) => err instanceof h.chain.ChainPendingError && typeof err.outboxId === 'string' && err.txHash !== null,
    );
    const row = [...h.rows.values()][0];
    assert.equal(row.status, 'PENDING');
    assert.equal(row.handledAt, null, 'resolution belongs to the recovery worker');
    assert.equal(handled, 0, 'no completion handler ran yet');
  });
  (h.config as Record<string, unknown>).OUTBOX_INLINE_WAIT_MS = 30_000;
});

test('a send ERROR with tx_bad_seq marks the row FAILED without any resubmission', async () => {
  const outbox = await load();
  const badSeq = new xdr.TransactionResult({
    feeCharged: new xdr.Int64(0),
    result: xdr.TransactionResultResult.txBadSeq(),
    ext: new xdr.TransactionResultExt(0),
  });
  const h = await writeHarness({ sendStatus: 'ERROR', sendErrorResult: badSeq });
  await withTestHandlers(outbox, {}, async () => {
    await assert.rejects(
      h.chain.agentBuy(
        { market_id: 1n, outcome: h.chain.Outcomes.Yes, collateral_in: 40_000_000n, min_shares_out: 1n },
        undefined,
        {},
        { kind: 'test.buy', refId: 't1' },
      ),
    );
    const row = [...h.rows.values()][0];
    assert.equal(row.status, 'FAILED');
    assert.equal(row.error, 'txBadSeq');
    assert.ok(row.handledAt, 'the live caller owns the failure; recovery never touches it');
    assert.equal(h.sent.length, 1, 'never retried with the same envelope');
  });
});

test('dry-run writes create no outbox row', async () => {
  const h = await writeHarness({});
  (h.config as Record<string, unknown>).CHAIN_EXECUTION_MODE = 'dry-run';
  const result = await h.chain.agentBuy(
    { market_id: 1n, outcome: h.chain.Outcomes.Yes, collateral_in: 40_000_000n, min_shares_out: 1n },
    undefined,
    {},
    { kind: 'test.buy', refId: 't1' },
  );
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.value, 777n);
  assert.equal(h.rows.size, 0);
});

// ─── Return-value decoding ───────────────────────────────────────────────────

test('parseReturnValue decodes with the binding spec and unwraps contract Results', async () => {
  const { parseReturnValue } = await load();
  const value = parseReturnValue(
    { contract: 'treasury', method: 'agent_buy' },
    nativeToScVal(123_456n, { type: 'i128' }),
  );
  assert.equal(value, 123_456n);
  assert.equal(parseReturnValue({ contract: null, method: null }, null), null);
  assert.equal(parseReturnValue({ contract: 'nope', method: 'x' }, nativeToScVal(1n, { type: 'i128' })), null);
});
