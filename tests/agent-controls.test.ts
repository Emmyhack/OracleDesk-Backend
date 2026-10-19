import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// The authed admin requests open the shared Redis connection; without closing
// it this file never exits.
after(async () => {
  await (await import('../src/lib/redis')).closeRedis().catch(() => undefined);
});
const ADMIN = Keypair.random().publicKey();
process.env.ADMIN_ADDRESSES = ADMIN; // read once when config loads

type Row = {
  scope: string; paused: boolean; reason: string | null; source: string | null;
  pausedUntil: Date | null; pausedBy: string | null; version: number;
};

/** In-memory agent_controls / agent_control_events; transactions are serialised by a mutex, which models FOR UPDATE / FOR SHARE ordering. */
async function installStore() {
  const { prisma } = await import('../src/lib/prisma');
  const rows = new Map<string, Row>(
    ['ALL', 'MARKET_MAKER', 'TRADER'].map((s) => [s, { scope: s, paused: false, reason: null, source: null, pausedUntil: null, pausedBy: null, version: 0 }]),
  );
  const events: any[] = [];
  const last = () => events[events.length - 1];
  const state = { failReads: false, beforeShareRead: null as null | (() => Promise<void>) };
  let tail: Promise<unknown> = Promise.resolve();
  const tx = {
    $queryRawUnsafe: async (sql: string, scope: string) => {
      if (sql.includes('FOR SHARE')) {
        await state.beforeShareRead?.();
        return ['ALL', scope].map((s) => ({ ...rows.get(s)! }));
      }
      assert.ok(sql.includes('FOR UPDATE'));
      return [{ ...rows.get(scope)! }];
    },
    agentControl: {
      update: async ({ where, data }: any) => {
        const row = rows.get(where.scope)!;
        const { version, ...rest } = data;
        Object.assign(row, rest);
        if (version?.increment) row.version += version.increment;
        return row;
      },
    },
    agentControlEvent: { create: async ({ data }: any) => { events.push({ ...data, createdAt: new Date() }); return data; } },
  };
  (prisma as any).$transaction = (fn: any) => {
    const run = tail.then(() => fn(tx));
    tail = run.catch(() => undefined);
    return run;
  };
  (prisma.agentControl as any).findMany = async ({ where }: any) => {
    if (state.failReads) throw new Error('db down');
    return where.scope.in.map((s: string) => ({ ...rows.get(s)! }));
  };
  (prisma.agentControlEvent as any).findMany = async () => [...events].reverse().slice(0, 20);
  return { rows, events, state };
}

async function freshControls() {
  // A "restart": a new module instance reading the same database.
  const path = require.resolve('../src/services/agent-controls.service');
  delete require.cache[path];
  return import('../src/services/agent-controls.service');
}

test('a pause persists across cycles and process restarts', async () => {
  const store = await installStore();
  const a = await freshControls();
  await a.assertAgentActive('TRADER');
  await a.pauseAgent('TRADER', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  await assert.rejects(a.assertAgentActive('TRADER'), (e: any) => e.code === 'AGENT_PAUSED' && e.statusCode === 423);
  const restarted = await freshControls();
  await assert.rejects(restarted.assertAgentActive('TRADER'), /paused/);
  await restarted.assertAgentActive('MARKET_MAKER'); // other agent unaffected
  assert.equal(store.events[store.events.length - 1].action, 'PAUSE');
  assert.equal(store.events[store.events.length - 1].actor, 'GADMIN');
});

test('a drawdown breach pauses TRADER until pauseUntil, then auto-expires with an audit event', async () => {
  const store = await installStore();
  const { prisma } = await import('../src/lib/prisma');
  const { checkDailyDrawdown } = await import('../src/services/hedging.service');
  const controls = await freshControls();
  (prisma.position.findMany as any) = async () => [{ pnl: -400 }];
  (prisma.agentLog.create as any) = async () => ({});
  const result = await checkDailyDrawdown(10_000);
  assert.equal(result.isPaused, true);
  const row = store.rows.get('TRADER')!;
  assert.equal(row.source, 'drawdown');
  assert.ok(row.pausedUntil!.getTime() > Date.now() + 3 * 3_600_000);
  await assert.rejects(controls.assertAgentActive('TRADER'), /paused/);

  row.pausedUntil = new Date(Date.now() - 1000);
  await controls.assertAgentActive('TRADER');
  assert.equal(row.paused, false);
  assert.ok(store.events.some((e) => e.action === 'AUTO_EXPIRED' && e.scope === 'TRADER'));
});

test('an operator pause is not cleared by a timed pause or expiry, and is never shortened', async () => {
  const store = await installStore();
  const c = await freshControls();
  await c.pauseAgent('TRADER', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  await c.pauseAgent('TRADER', { reason: 'drawdown', source: 'drawdown', actor: 'system', until: new Date(Date.now() + 3_600_000) });
  const row = store.rows.get('TRADER')!;
  assert.equal(row.source, 'operator');
  assert.equal(row.pausedUntil, null);
  assert.equal(row.version, 1);
  await assert.rejects(c.assertAgentActive('TRADER'), /paused/);
  // A longer timed pause replaces a shorter one; an indefinite one replaces a timed one.
  await c.resumeAgent('TRADER', { actor: 'GADMIN' });
  await c.pauseAgent('TRADER', { reason: 'short', source: 'drawdown', actor: 'system', until: new Date(Date.now() + 3_600_000) });
  await c.pauseAgent('TRADER', { reason: 'shorter', source: 'drawdown', actor: 'system', until: new Date(Date.now() + 60_000) });
  assert.equal(row.reason, 'short');
  await c.pauseAgent('TRADER', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  assert.equal(row.source, 'operator');
});

test('an ALL pause blocks both agents and resuming one agent does not unblock it', async () => {
  const store = await installStore();
  const c = await freshControls();
  await c.pauseAgent('ALL', { reason: 'kill switch', source: 'operator', actor: 'GADMIN' });
  await assert.rejects(c.assertAgentActive('TRADER'), /paused/);
  await assert.rejects(c.assertAgentActive('MARKET_MAKER'), /paused/);
  await c.resumeAgent('TRADER', { actor: 'GADMIN' });
  await assert.rejects(c.assertAgentActive('TRADER'), /paused/);
  assert.equal(store.rows.get('ALL')!.paused, true);
  await c.resumeAgent('ALL', { actor: 'GADMIN' });
  await c.assertAgentActive('TRADER');
  await c.assertAgentActive('MARKET_MAKER');
});

test('a chain write re-checks after simulation and aborts if paused in between', async () => {
  const store = await installStore();
  const clients = await import('../src/services/stellar/clients');
  const chain = await import('../src/services/chain.service');
  const { config } = await import('../src/config');
  const { Account, Keypair: Kp, Operation, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const { setSequenceDepsForTest } = await import('../src/services/stellar/sequence');
  const { FakeRedis, fakeRpc } = await import('./helpers/fake-redis');
  // The instance chain.service.ts imported; keep its breaker off Redis.
  const c = await import('../src/services/agent-controls.service');
  c.setFailureCounterForTest({ increment: async () => 1, reset: async () => undefined });
  // #36: the live path takes a per-account lock and rewrites the built
  // transaction with the allocated sequence, so provide a test double and key.
  const agent = Kp.random();
  (config as any).CHAIN_EXECUTION_MODE = 'live';
  (config as any).AGENT_SECRET_KEY = agent.secret();
  const net = fakeRpc(100n);
  setSequenceDepsForTest({ redis: new FakeRedis() as any, rpc: net.rpc });
  // #35: a live write persists an outbox row around build/sign/send.
  const { prisma } = await import('../src/lib/prisma');
  const outboxRows = new Map<string, any>();
  let outboxN = 0;
  (prisma as any).chainTransaction = {
    create: async ({ data }: any) => { const row = { id: `ob${++outboxN}`, status: 'BUILT', handledAt: null, feeBumpHashes: [], ...data }; outboxRows.set(row.id, row); return { ...row }; },
    updateMany: async ({ where, data }: any) => {
      const row = outboxRows.get(where.id);
      if (!row || (where.status?.in && !where.status.in.includes(row.status))) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    findUnique: async ({ where }: any) => (outboxRows.has(where.id) ? { ...outboxRows.get(where.id) } : null),
    findFirst: async () => null,
    findMany: async () => [],
    upsert: async () => ({}),
  };
  (prisma as any).chainSubmission = { upsert: async () => ({}) };
  (prisma as any).chainFee = { upsert: async () => ({}) };
  let signed = 0;
  const built = new TransactionBuilder(new Account(agent.publicKey(), '100'), {
    fee: '100',
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.manageData({ name: 'x', value: 'y' }))
    .setTimeout(30)
    .build();
  const fakeTx = {
    simulation: {},
    result: { isOk: () => true, unwrap: () => 5n },
    built,
    sign: async () => { signed++; },
  };
  // The live path sends through the shared sender and polls the reader (#37/#42).
  const { setTransactionSender, setTransactionReader } = await import('../src/services/stellar/tx-inspect');
  const builtHash = built.hash().toString('hex');
  const prevSender = setTransactionSender({
    sendTransaction: async () => ({ status: 'PENDING', hash: builtHash, latestLedger: 100 }) as any,
  });
  const prevReader = setTransactionReader({
    getTransaction: async () => ({ status: 'SUCCESS', ledger: 101 }) as any,
  });
  let pauseDuringBuild = false;
  (clients.agentClients as any).treasury = () => ({
    agent_buy: async () => {
      if (pauseDuringBuild) await c.pauseAgent('TRADER', { reason: 'mid-write', source: 'operator', actor: 'GADMIN' });
      return fakeTx;
    },
  });
  const args = { market_id: 1n, outcome: chain.Outcomes.Yes, collateral_in: 10n, min_shares_out: 1n };

  try {
    const ok = await chain.agentBuy(args);
    assert.equal(ok.mode, 'live');
    assert.equal(signed, 1);

    pauseDuringBuild = true;
    await assert.rejects(chain.agentBuy(args), (e: any) => e.code === 'AGENT_PAUSED');
    assert.equal(signed, 1, 'a paused write must never be signed');
  } finally {
    setSequenceDepsForTest(null);
    setTransactionSender(prevSender);
    setTransactionReader(prevReader);
  }
  (config as any).CHAIN_EXECUTION_MODE = 'dry-run';
  assert.equal(store.rows.get('TRADER')!.paused, true);
});

test('5 failures in the window trigger failure_breaker; cap errors do not count', async () => {
  const store = await installStore();
  const c = await freshControls();
  let count = 0;
  c.setFailureCounterForTest({ increment: async () => ++count, reset: async () => { count = 0; } });
  for (let i = 0; i < 10; i++) await c.recordChainWriteOutcome('TRADER', false, 'TradeCapExceeded');
  await c.recordChainWriteOutcome('TRADER', false, 'DailyCapExceeded');
  await c.recordChainWriteOutcome('TRADER', false, 'MarketCapExceeded');
  assert.equal(store.rows.get('TRADER')!.paused, false);

  for (let i = 0; i < 4; i++) await c.recordChainWriteOutcome('TRADER', false, 'SlippageExceeded');
  assert.equal(store.rows.get('TRADER')!.paused, false);
  await c.recordChainWriteOutcome('TRADER', true, null); // success resets the streak
  for (let i = 0; i < 4; i++) await c.recordChainWriteOutcome('TRADER', false, null);
  assert.equal(store.rows.get('TRADER')!.paused, false);
  await c.recordChainWriteOutcome('TRADER', false, null);
  const row = store.rows.get('TRADER')!;
  assert.equal(row.paused, true);
  assert.equal(row.source, 'failure_breaker');
  assert.equal(store.rows.get('MARKET_MAKER')!.paused, false);
  c.setFailureCounterForTest(null);
});

test('a Paused contract error pauses ALL immediately as chain_paused', async () => {
  const store = await installStore();
  const c = await freshControls();
  await c.recordChainWriteOutcome('MARKET_MAKER', false, 'Paused');
  assert.equal(store.rows.get('ALL')!.source, 'chain_paused');
  await assert.rejects(c.assertAgentActive('TRADER'), /paused/);
});

test('market-core paused config pauses ALL and auto-resumes on unpause (operator pauses stay)', async () => {
  const store = await installStore();
  const chain = await import('../src/services/chain.service');
  const c = await freshControls();
  let paused = true;
  (chain as any).marketCoreConfig = async () => ({ paused });
  await assert.rejects(c.gateCycle('TRADER'), /paused/);
  assert.equal(store.rows.get('ALL')!.source, 'chain_paused');
  paused = false;
  await c.gateCycle('TRADER');
  assert.equal(store.rows.get('ALL')!.paused, false);
  assert.equal(store.events[store.events.length - 1].action, 'AUTO_RESUMED');

  await c.pauseAgent('ALL', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  await assert.rejects(c.gateCycle('TRADER'), /paused/);
  assert.equal(store.rows.get('ALL')!.source, 'operator');
});

test('a database error in assertAgentActive fails closed', async () => {
  const store = await installStore();
  const c = await freshControls();
  store.state.failReads = true;
  await assert.rejects(c.assertAgentActive('TRADER'), (e: any) => e.code === 'AGENT_CONTROL_UNAVAILABLE' && e.statusCode === 503);
});

test('the pre-submit check serialises with a concurrent pause', async () => {
  const store = await installStore();
  const c = await freshControls();
  const v = await c.assertAgentActive('TRADER');
  // A pause committed before the share lock is taken refuses the write.
  store.state.beforeShareRead = async () => undefined;
  await c.pauseAgent('TRADER', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  await assert.rejects(c.assertAgentActiveLocked('TRADER', v), /paused/);
});

async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('POST /admin/agents/TRADER/pause requires an admin, validates, and writes an audit event', async () => {
  const store = await installStore();
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const url = `${base}/api/v1/admin/agents/TRADER/pause`;
    const post = (token: string | null, body: unknown, u = url) =>
      fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

    assert.equal((await post(null, { reason: 'stop trading now' })).status, 401);
    const nonAdmin = signToken('u1', Keypair.random().publicKey());
    assert.equal((await post(nonAdmin, { reason: 'stop trading now' })).status, 403);

    const admin = signToken('admin', ADMIN);
    assert.equal((await post(admin, { reason: 'no' })).status, 400);
    assert.equal((await post(admin, { reason: 'stop trading now' }, `${base}/api/v1/admin/agents/NOPE/pause`)).status, 400);
    assert.equal((await post(admin, { reason: 'stop trading now', until: '2020-01-01T00:00:00Z' })).status, 400);

    const res = await post(admin, { reason: 'stop trading now' });
    assert.equal(res.status, 200);
    assert.equal(store.rows.get('TRADER')!.paused, true);
    assert.equal(store.rows.get('TRADER')!.pausedBy, ADMIN);
    assert.deepEqual([store.events[store.events.length - 1].action, store.events[store.events.length - 1].actor, store.events[store.events.length - 1].source], ['PAUSE', ADMIN, 'operator']);

    const listed = await fetch(`${base}/api/v1/admin/agents/controls`, { headers: { authorization: `Bearer ${admin}` } });
    const body = await listed.json();
    assert.equal(body.data.scopes.find((s: any) => s.scope === 'TRADER').paused, true);
    assert.equal(body.data.events.length, 1);

    const resume = await fetch(`${base}/api/v1/admin/agents/TRADER/resume`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{}' });
    assert.equal(resume.status, 200);
    assert.equal(store.rows.get('TRADER')!.paused, false);
  });
});

test('POST /markets/generate answers 423 AGENT_PAUSED and starts no job when the market maker is paused', async () => {
  const store = await installStore();
  const c = await freshControls();
  const controller = await import('../src/controllers/market.controller');
  const agent = await import('../src/agents/market-maker.agent');
  let cycles = 0;
  (agent as any).runMarketMakerCycle = async () => { cycles++; return null; };
  await c.pauseAgent('MARKET_MAKER', { reason: 'operator stop', source: 'operator', actor: 'GADMIN' });
  assert.ok(store.rows.get('MARKET_MAKER')!.paused);
  const res: any = { status: () => res, json: () => res };
  await assert.rejects(
    controller.triggerMarketGeneration({ body: {}, signal: undefined } as any, res),
    (e: any) => e.code === 'AGENT_PAUSED' && e.statusCode === 423,
  );
  assert.equal(cycles, 0);
});
