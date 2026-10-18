import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Account, Address, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();
// Admin for the POST /markets/generate replay test; read once when config loads.
const ADMIN = Keypair.random().publicKey();
process.env.ADMIN_ADDRESSES = ADMIN;

type Mw = typeof import('../src/middlewares/idempotency.middleware');
type Rec = import('../src/middlewares/idempotency.middleware').IdempotencyRecord;

/** In-memory IdempotencyStore with the same semantics as the Postgres one. */
function memoryStore() {
  const rows = new Map<string, Rec & { k: string }>();
  const k = (s: { scope: string; method: string; route: string; key: string }) => `${s.scope}|${s.method}|${s.route}|${s.key}`;
  const store: import('../src/middlewares/idempotency.middleware').IdempotencyStore = {
    async claim(s, row) {
      if ([...rows.values()].some((r) => r.k === k(s))) return null;
      rows.set(row.id, { k: k(s), id: row.id, fingerprint: row.fingerprint, status: 'IN_PROGRESS', lockedUntil: row.lockedUntil, expiresAt: row.expiresAt, responseCode: null, responseBody: null, responseHeaders: null });
      return row.id;
    },
    async find(s) {
      return [...rows.values()].find((r) => r.k === k(s)) ?? null;
    },
    async takeOver(id, row, now) {
      const r = rows.get(id);
      if (!r) return false;
      const stale = (r.status === 'IN_PROGRESS' && r.lockedUntil < now) || r.expiresAt < now;
      if (!stale) return false;
      Object.assign(r, { fingerprint: row.fingerprint, status: 'IN_PROGRESS', lockedUntil: row.lockedUntil, expiresAt: row.expiresAt, responseCode: null, responseBody: null, responseHeaders: null });
      return true;
    },
    async complete(id, code, body, headers) {
      const r = rows.get(id);
      if (r) Object.assign(r, { status: 'COMPLETED', responseCode: code, responseBody: JSON.parse(JSON.stringify(body)), responseHeaders: headers });
    },
    async release(id) {
      rows.delete(id);
    },
    async purgeExpired(now, batch) {
      let n = 0;
      for (const [id, r] of rows) if (r.expiresAt < now && n < batch) { rows.delete(id); n++; }
      return n;
    },
  };
  return { store, rows };
}

/** Express app with the middleware on a counting handler; `respond` decides the reply. */
async function testApp(mw: Mw, opts: Parameters<Mw['idempotent']>[0], respond: (req: any, res: any, n: number) => void | Promise<void>) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  let calls = 0;
  const fakeAuth = (req: any, _res: any, next: any) => { if (req.get('x-user')) req.user = { userId: req.get('x-user') }; next(); };
  const handler = async (req: any, res: any) => { calls++; await respond(req, res, calls); };
  app.post('/things/:id', fakeAuth, mw.idempotent(opts), handler);
  app.post('/other/:id', fakeAuth, mw.idempotent(opts), handler);
  return { app, calls: () => calls };
}

async function serve(app: any, fn: (base: string) => Promise<void>) {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });

/** `finish` fires after the response is sent; give the async store write a tick. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('first request stores response; replay returns identical body and Idempotent-Replayed', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const { store } = memoryStore();
  const prev = mw.setIdempotencyStore(store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res, n) => res.status(201).json({ ok: true, data: { n } }));
    await serve(app, async (base) => {
      const first = await post(base, '/things/1', { a: 1, b: 2 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(first.status, 201);
      const firstBody = await first.json();
      assert.equal(first.headers.get('idempotent-replayed'), null);
      await settle();
      // Same body with keys reordered: same canonical fingerprint.
      const again = await post(base, '/things/1', { b: 2, a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(again.status, 201);
      assert.deepEqual(await again.json(), firstBody);
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal(calls(), 1);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('same key different body -> 422 IDEMPOTENCY_KEY_MISMATCH', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res) => res.json({ ok: true }));
    await serve(app, async (base) => {
      await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      await settle();
      const res = await post(base, '/things/1', { a: 2 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(res.status, 422);
      assert.equal((await res.json()).error.code, 'IDEMPOTENCY_KEY_MISMATCH');
      assert.equal(calls(), 1);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('concurrent duplicate while in flight -> 409 IDEMPOTENCY_IN_PROGRESS with Retry-After', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  try {
    const { app, calls } = await testApp(mw, {}, async (_req, res) => { await gate; res.json({ ok: true }); });
    await serve(app, async (base) => {
      const first = post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      await settle();
      const dup = await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(dup.status, 409);
      assert.equal(dup.headers.get('retry-after'), '1');
      assert.equal((await dup.json()).error.code, 'IDEMPOTENCY_IN_PROGRESS');
      release();
      assert.equal((await first).status, 200);
      assert.equal(calls(), 1);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('crashed request lock expires and can be taken over', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  const abort = new AbortController();
  try {
    // First call never responds (simulated crash); lock is 50 ms.
    const { app, calls } = await testApp(mw, { lockSeconds: 0.05 }, (_req, res, n) => { if (n > 1) res.json({ ok: true, data: { n } }); });
    await serve(app, async (base) => {
      post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' }, abort.signal).catch(() => undefined);
      await settle();
      const blocked = await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(blocked.status, 409);
      await new Promise((r) => setTimeout(r, 80));
      const takeover = await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(takeover.status, 200);
      assert.equal((await takeover.json()).data.n, 2);
      assert.equal(calls(), 2);
    });
  } finally { abort.abort(); mw.setIdempotencyStore(prev); }
});

test('5xx responses are not stored; retry re-executes', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const { store, rows } = memoryStore();
  const prev = mw.setIdempotencyStore(store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res, n) => (n === 1 ? res.status(503).json({ ok: false }) : res.json({ ok: true })));
    await serve(app, async (base) => {
      assert.equal((await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' })).status, 503);
      await settle();
      assert.equal(rows.size, 0);
      const retry = await post(base, '/things/1', { a: 1 }, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('idempotent-replayed'), null);
      assert.equal(calls(), 2);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('4xx responses are stored and replayed', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res) => res.status(403).json({ ok: false, error: { code: 'TRACE_LOCKED' } }));
    await serve(app, async (base) => {
      await post(base, '/things/1', {}, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      await settle();
      const again = await post(base, '/things/1', {}, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(again.status, 403);
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal(calls(), 1);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('keys are scoped per user and per route', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res) => res.json({ ok: true }));
    await serve(app, async (base) => {
      const h = { 'idempotency-key': 'shared' };
      assert.equal((await post(base, '/things/1', { a: 1 }, { ...h, 'x-user': 'u1' })).headers.get('idempotent-replayed'), null);
      await settle();
      // Different user, same key and body: runs.
      assert.equal((await post(base, '/things/1', { a: 1 }, { ...h, 'x-user': 'u2' })).headers.get('idempotent-replayed'), null);
      await settle();
      // Different route template, same user and key: runs.
      assert.equal((await post(base, '/other/1', { a: 1 }, { ...h, 'x-user': 'u1' })).headers.get('idempotent-replayed'), null);
      await settle();
      // Different :id on the same template is a different request: mismatch, not a replay.
      assert.equal((await post(base, '/things/2', { a: 1 }, { ...h, 'x-user': 'u1' })).status, 422);
      assert.equal(calls(), 3);
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('stored response never contains authorization headers or secrets; oversized bodies are not replayed', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const { store, rows } = memoryStore();
  const prev = mw.setIdempotencyStore(store);
  try {
    const { app } = await testApp(mw, {}, (req, res) => {
      res.setHeader('Set-Cookie', 'sid=abc');
      res.setHeader('Authorization', 'Bearer leak');
      res.setHeader('Location', '/things/1');
      if (req.body.big) res.json({ blob: 'x'.repeat(70 * 1024) });
      else res.json({ ok: true, data: { accessToken: 'jwt', nested: { clientSecret: 's' }, keep: 1 } });
    });
    await serve(app, async (base) => {
      await post(base, '/things/1', {}, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      await settle();
      const [row] = [...rows.values()];
      assert.deepEqual(Object.keys(row.responseHeaders ?? {}).sort(), ['content-type', 'location']);
      const stored = JSON.stringify(row.responseBody);
      assert.ok(!stored.includes('jwt') && !stored.includes('"s"'));
      assert.match(stored, /"keep":1/);
      const replay = await post(base, '/things/1', {}, { 'idempotency-key': 'k1', 'x-user': 'u1' });
      assert.equal(replay.headers.get('set-cookie'), null);
      assert.equal(replay.headers.get('location'), '/things/1');

      await post(base, '/things/1', { big: true }, { 'idempotency-key': 'k2', 'x-user': 'u1' });
      await settle();
      const big = await post(base, '/things/1', { big: true }, { 'idempotency-key': 'k2', 'x-user': 'u1' });
      assert.equal(big.status, 409);
      assert.equal((await big.json()).error.code, 'IDEMPOTENCY_RESPONSE_UNAVAILABLE');
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('missing key is fine when optional; malformed key is rejected', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  try {
    const { app, calls } = await testApp(mw, {}, (_req, res) => res.json({ ok: true }));
    await serve(app, async (base) => {
      assert.equal((await post(base, '/things/1', {})).status, 200);
      assert.equal((await post(base, '/things/1', {})).status, 200);
      assert.equal(calls(), 2);
      const bad = await post(base, '/things/1', {}, { 'idempotency-key': 'x'.repeat(256) });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, 'IDEMPOTENCY_KEY_INVALID');
    });
  } finally { mw.setIdempotencyStore(prev); }
});

test('purgeExpiredIdempotencyKeys deletes only expired keys', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const { store, rows } = memoryStore();
  const prev = mw.setIdempotencyStore(store);
  try {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 3_600_000);
    await store.claim({ scope: 'u', method: 'POST', route: '/a', key: 'old' }, { id: 'old', fingerprint: 'f', lockedUntil: past, expiresAt: past });
    await store.claim({ scope: 'u', method: 'POST', route: '/a', key: 'new' }, { id: 'new', fingerprint: 'f', lockedUntil: future, expiresAt: future });
    assert.equal(await mw.purgeExpiredIdempotencyKeys(5_000), 1);
    assert.deepEqual([...rows.keys()], ['new']);
  } finally { mw.setIdempotencyStore(prev); }
});

async function withAppServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  await serve(app, fn);
}

test('POST /trade/copy without key -> 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withAppServer(async (base) => {
    const token = signToken('u1', Keypair.random().publicKey());
    const res = await post(base, '/api/v1/trade/copy', {}, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });
});

test('POST /markets/generate replay returns same jobId and starts one cycle', async () => {
  const mw = await import('../src/middlewares/idempotency.middleware');
  const agent = await import('../src/agents/market-maker.agent');
  const { prisma } = await import('../src/lib/prisma');
  const { signToken } = await import('../src/middlewares/auth.middleware');
  const prev = mw.setIdempotencyStore(memoryStore().store);
  const controls = await import('../src/services/agent-controls.service');
  const origAssert = controls.assertAgentActive;
  (controls as any).assertAgentActive = async () => 1; // no agent_controls table in this test
  let cycles = 0;
  const origCycle = agent.runMarketMakerCycle;
  const origLog = prisma.agentLog.create;
  (agent as any).runMarketMakerCycle = async () => { cycles++; return {}; };
  (prisma.agentLog.create as any) = async () => ({});
  try {
    await withAppServer(async (base) => {
      const auth = { authorization: `Bearer ${signToken('admin-1', ADMIN)}` };
      const missing = await post(base, '/api/v1/markets/generate', {}, auth);
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const first = await post(base, '/api/v1/markets/generate', {}, { ...auth, 'idempotency-key': 'gen-1' });
      assert.equal(first.status, 202);
      const firstJob = (await first.json()).data.jobId;
      await settle();
      const again = await post(base, '/api/v1/markets/generate', {}, { ...auth, 'idempotency-key': 'gen-1' });
      assert.equal(again.status, 202);
      assert.equal(again.headers.get('idempotent-replayed'), 'true');
      assert.equal((await again.json()).data.jobId, firstJob);
      assert.equal(cycles, 1);
    });
  } finally {
    (agent as any).runMarketMakerCycle = origCycle;
    (controls as any).assertAgentActive = origAssert;
    (prisma.agentLog.create as any) = origLog;
    mw.setIdempotencyStore(prev);
  }
});

test('CORS allows Idempotency-Key and exposes Idempotent-Replayed', async () => {
  await withAppServer(async (base) => {
    const pre = await fetch(`${base}/api/v1/trade/copy`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'idempotency-key,content-type' },
    });
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/i);
    const get = await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } });
    assert.match(get.headers.get('access-control-expose-headers') ?? '', /Idempotent-Replayed/i);
  });
});

test('recordPayment concurrent duplicate returns existing subscription instead of 500', async () => {
  const verification = await import('../src/services/payment-verification.service');
  const { CONTRACTS, PAYMENTS_RECIPIENT } = await import('../src/config/contracts');
  const { config } = await import('../src/config');
  const { prisma } = await import('../src/lib/prisma');
  const { recordPayment } = await import('../src/services/subscription.service');
  const HASH = 'cd'.repeat(32);
  const user = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(user, '1'), { fee: '100', networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({
      contract: CONTRACTS.usdc,
      function: 'transfer',
      args: [new Address(user).toScVal(), new Address(PAYMENTS_RECIPIENT).toScVal(), nativeToScVal(5_000_000n, { type: 'i128' })],
    }))
    .setTimeout(30)
    .build();
  const prevReader = verification.setTransactionReader({
    async getTransaction(hash: string) {
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 42, envelopeXdr: tx.toEnvelope() } as any;
    },
  });
  const winnerSub = { id: 'sub-winner', txHash: HASH, status: 'ACTIVE' };
  let winnerUser = 'u1';
  // Pre-check sees nothing (the race); the transaction then loses on the unique index.
  let lookups = 0;
  (prisma.paymentEvent.findUnique as any) = async () => (lookups++ === 0 ? null : { userId: winnerUser });
  (prisma.subscription.findFirst as any) = async () => winnerSub;
  (prisma.spendingAllowance.findUnique as any) = async () => null;
  (prisma.$transaction as any) = async () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); };
  try {
    const sub = await recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: HASH });
    assert.equal(sub.id, 'sub-winner');

    lookups = 0;
    winnerUser = 'someone-else';
    await assert.rejects(
      recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: HASH }),
      (e: any) => e.statusCode === 409 && e.code === 'PAYMENT_ALREADY_USED',
    );
  } finally {
    verification.setTransactionReader(prevReader);
  }
});
