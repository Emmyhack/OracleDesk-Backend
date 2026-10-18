import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

const REDIS_URL = process.env.REDIS_URL as string;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function redisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const eventsOf = (ids: string[], type = 'TRADE_EXECUTED') =>
  ids.map((id, i) => ({ id, type, ledger: 100 + i, marketKey: '7', payload: { eventId: id } }));

/** Waits until `check` holds, or fails with `what`. */
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out: ${what}`);
    await sleep(25);
  }
}

test('memory bus delivers events in publish order and resumes from an id', async () => {
  const { memoryEventBus } = await import('../src/lib/event-bus');
  const bus = memoryEventBus();
  const seen: string[] = [];
  const stop = bus.subscribe((e) => { seen.push(e.id); });
  const ids: string[] = [];
  for (const e of eventsOf(['a', 'b', 'c', 'd'])) ids.push(await bus.publish(e));
  await stop();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);

  const replay: string[] = [];
  const stopReplay = bus.subscribe((e) => { replay.push(e.id); }, { fromId: ids[1] });
  await stopReplay();
  assert.deepEqual(replay, ['c', 'd']);
  assert.equal(await bus.tailId(), ids[3]);
});

test('bigint payload values cross the bus as strings', async () => {
  const { memoryEventBus } = await import('../src/lib/event-bus');
  const bus = memoryEventBus();
  let got: any;
  const stop = bus.subscribe((e) => { got = e.payload; });
  await bus.publish({ id: 'x', type: 'TRADE_EXECUTED', ledger: 1, marketKey: null, payload: { sharesRaw: 18446744073709551615n } });
  await stop();
  assert.deepEqual(got, { sharesRaw: '18446744073709551615' });
});

test('the fan-out source never reaches the shared Redis connection with a blocking read', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const text = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'event-bus.ts'), 'utf8');
  assert.match(text, /getBlockingRedis/);
  assert.ok(!/shared\(\)\.xread/.test(text), 'XREAD BLOCK uses the dedicated connection only');
});

test('Redis-backed bus and fan-out', async (t) => {
  if (!(await redisReachable())) {
    t.skip(`Redis is not reachable at ${REDIS_URL}; set REDIS_URL (CI provides Redis 7)`);
    return;
  }
  const { redisEventBus } = await import('../src/lib/event-bus');
  const { startFanout } = await import('../src/lib/fanout');

  const opened: Redis[] = [];
  const open = () => {
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    client.on('error', () => undefined);
    opened.push(client);
    return client;
  };
  const admin = open();

  async function fixture() {
    const prefix = `test:fanout:${randomBytes(4).toString('hex')}`;
    const bus = (redis: Redis, maxLen = 1000) =>
      redisEventBus({ key: `${prefix}:events`, maxLen, redis, blocking: () => redis.duplicate(), release: (c) => c.disconnect() });
    const cleanup = async () => {
      let cursor = '0';
      do {
        const [next, keys] = await admin.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        if (keys.length) await admin.unlink(...keys);
        cursor = next;
      } while (cursor !== '0');
    };
    return { prefix, bus, cleanup };
  }

  async function instance(prefix: string, redis: Redis) {
    const server = http.createServer();
    const io = new Server(server);
    io.adapter(createAdapter(redis, { streamName: `${prefix}:sio`, channelPrefix: `${prefix}:ch`, blockTimeInMs: 200 }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const received: string[] = [];
    const probes = { n: 0 };
    const client: ClientSocket = connect(url, { forceNew: true, reconnection: false, transports: ['websocket'] });
    client.on('TRADE_EXECUTED', (payload: { eventId: string }) => received.push(payload.eventId));
    client.on('PROBE', () => { probes.n += 1; });
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    return {
      io,
      received,
      probes,
      async close() {
        client.close();
        await new Promise<void>((resolve) => io.close(() => resolve()));
      },
    };
  }

  /**
   * The streams adapter starts reading each stream asynchronously, from the
   * tail. Broadcast probes until every instance has heard from the others, so
   * the events a test asserts on cannot fall before an adapter is listening.
   */
  async function warm(...servers: Array<{ io: Server; probes: { n: number } }>) {
    const start = Date.now();
    while (servers.some((s) => s.probes.n < servers.length * 2)) {
      if (Date.now() - start > 5000) throw new Error('timed out: adapters did not connect');
      for (const s of servers) s.io.emit('PROBE');
      await sleep(50);
    }
  }

  const fan = (prefix: string, redis: Redis, io: Server, extra: Record<string, unknown> = {}) =>
    startFanout(
      // each fan-out reads through its own bus handle so they behave like separate processes
      (globalThis as any).__bus(redis),
      io,
      { redis, prefix: `${prefix}:fanout`, leaseMs: 600, renewMs: 100, fenceMs: 0, ...extra },
    );

  await t.test('a bus consumer resumes from the stored stream id with no gap and no repeat', async () => {
    const f = await fixture();
    try {
      const bus = f.bus(admin);
      const first: Array<[string, string]> = [];
      let stop = bus.subscribe((e, streamId) => { first.push([e.id, streamId]); });
      await sleep(100);
      for (const e of eventsOf(['e1', 'e2', 'e3'])) await bus.publish(e);
      await until(() => first.length === 3, 'first consumer reads three events');
      await stop();
      const cursor = first[first.length - 1][1];

      for (const e of eventsOf(['e4', 'e5'])) await bus.publish(e);
      const second: string[] = [];
      stop = bus.subscribe((e) => { second.push(e.id); }, { fromId: cursor });
      await until(() => second.length === 2, 'restarted consumer catches up');
      await stop();
      assert.deepEqual(second, ['e4', 'e5']);
    } finally {
      await f.cleanup();
    }
  });

  await t.test('an event published on one server reaches clients on both servers exactly once', async () => {
    const f = await fixture();
    (globalThis as any).__bus = (redis: Redis) => f.bus(redis);
    const ra = open();
    const rb = open();
    const a = await instance(f.prefix, ra);
    const b = await instance(f.prefix, rb);
    const stopA = fan(f.prefix, ra, a.io);
    const stopB = fan(f.prefix, rb, b.io);
    try {
      await warm(a, b);
      const leader = await admin.get(`${f.prefix}:fanout:leader`);
      assert.ok(leader, 'exactly one leader holds the lock');

      const publisher = f.bus(admin);
      for (const e of eventsOf(['e1', 'e2', 'e3', 'e4'])) await publisher.publish(e);
      await until(() => a.received.length >= 4 && b.received.length >= 4, 'both clients receive four events');
      await sleep(300); // any duplicate would arrive by now
      assert.deepEqual(a.received, ['e1', 'e2', 'e3', 'e4']);
      assert.deepEqual(b.received, ['e1', 'e2', 'e3', 'e4']);

      // The same chain event published twice (crash between XADD and the flag) is delivered once.
      await publisher.publish(eventsOf(['e4'])[0]);
      await publisher.publish(eventsOf(['e5'])[0]);
      await until(() => a.received.includes('e5') && b.received.includes('e5'), 'e5 delivered');
      assert.deepEqual(a.received, ['e1', 'e2', 'e3', 'e4', 'e5']);
      assert.deepEqual(b.received, ['e1', 'e2', 'e3', 'e4', 'e5']);
    } finally {
      await stopA();
      await stopB();
      await a.close();
      await b.close();
      await f.cleanup();
    }
  });

  await t.test('leader failover delivers no gaps and no duplicates for events published during the switch', async () => {
    const f = await fixture();
    (globalThis as any).__bus = (redis: Redis) => f.bus(redis);
    const ra = open();
    const rb = open();
    const a = await instance(f.prefix, ra);
    const b = await instance(f.prefix, rb);
    const stopA = fan(f.prefix, ra, a.io);
    await sleep(300); // A is the leader before B starts
    const stopB = fan(f.prefix, rb, b.io);
    try {
      await warm(a, b);
      assert.ok(await admin.get(`${f.prefix}:fanout:leader`));
      const publisher = f.bus(admin);
      for (const e of eventsOf(['e1', 'e2', 'e3'])) await publisher.publish(e);
      await until(() => a.received.length === 3 && b.received.length === 3, 'first batch delivered');

      // Graceful stop of the leader; events keep arriving while B takes over.
      const stopping = stopA();
      for (const e of eventsOf(['e4', 'e5', 'e6'])) await publisher.publish(e);
      await stopping;
      await until(() => a.received.length === 6 && b.received.length === 6, 'second batch delivered by the successor');
      await sleep(400);
      const all = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
      assert.deepEqual(a.received, all);
      assert.deepEqual(b.received, all);
    } finally {
      await stopB();
      await a.close();
      await b.close();
      await f.cleanup();
    }
  });

  await t.test('a leader that dies without releasing the lock is replaced once the lease lapses', async () => {
    const f = await fixture();
    (globalThis as any).__bus = (redis: Redis) => f.bus(redis);
    const ra = open();
    const rb = open();
    const a = await instance(f.prefix, admin); // the instance's adapter uses a healthy client
    const b = await instance(f.prefix, rb);
    const dying = open();
    const stopA = fan(f.prefix, dying, a.io, { instanceId: 'A' });
    await sleep(300);
    const stopB = fan(f.prefix, rb, b.io, { instanceId: 'B' });
    try {
      await warm(a, b);
      assert.equal(await admin.get(`${f.prefix}:fanout:leader`), 'A');
      const publisher = f.bus(admin);
      for (const e of eventsOf(['e1', 'e2'])) await publisher.publish(e);
      await until(() => a.received.length === 2 && b.received.length === 2, 'first batch delivered');

      dying.disconnect(); // process death: no release, no more renewals
      for (const e of eventsOf(['e3', 'e4'])) await publisher.publish(e);
      await until(() => b.received.length === 4, 'B takes over after the lease lapses and resumes from the cursor', 6000);
      await sleep(300);
      assert.equal(await admin.get(`${f.prefix}:fanout:leader`), 'B');
      assert.deepEqual(b.received, ['e1', 'e2', 'e3', 'e4']);
      assert.deepEqual(a.received, ['e1', 'e2', 'e3', 'e4']);
    } finally {
      await stopA().catch(() => undefined);
      await stopB();
      await a.close();
      await b.close();
      await f.cleanup();
      void ra;
    }
  });

  await t.test('a leader that lost the lock does not emit', async () => {
    const f = await fixture();
    (globalThis as any).__bus = (redis: Redis) => f.bus(redis);
    const ra = open();
    const a = await instance(f.prefix, ra);
    const stopA = fan(f.prefix, ra, a.io, { instanceId: 'A', renewMs: 5_000 });
    try {
      await sleep(300);
      assert.equal(await admin.get(`${f.prefix}:fanout:leader`), 'A');
      await admin.set(`${f.prefix}:fanout:leader`, 'thief', 'PX', 5_000);
      await f.bus(admin).publish(eventsOf(['e1'])[0]);
      await sleep(600);
      assert.deepEqual(a.received, [], 'fenced: ownership is re-read before delivering');
    } finally {
      await stopA();
      await a.close();
      await f.cleanup();
    }
  });

  await t.test('the stream length stays near EVENT_BUS_MAXLEN', async () => {
    const f = await fixture();
    try {
      const bus = f.bus(admin, 100);
      for (let i = 0; i < 1500; i++) await bus.publish({ id: `e${i}`, type: 'TRADE_EXECUTED', ledger: i, marketKey: null, payload: { i } });
      const length = await admin.xlen(`${f.prefix}:events`);
      assert.ok(length >= 100, `kept at least MAXLEN entries (got ${length})`);
      assert.ok(length < 400, `trimmed close to MAXLEN (got ${length})`);
    } finally {
      await f.cleanup();
    }
  });

  await t.test('unpublished chain_events rows are published to the bus in ledger order', async () => {
    const f = await fixture();
    const { prisma } = await import('../src/lib/prisma');
    const { publishPending } = await import('../src/services/indexer.service');
    const { CONTRACTS } = await import('../src/config/contracts');
    const rows = [
      { id: '0000000300-0000000001', ledger: 300 },
      { id: '0000000100-0000000001', ledger: 100 },
      { id: '0000000200-0000000001', ledger: 200 },
    ].map((r) => ({
      ...r,
      contractId: CONTRACTS.marketCore,
      contractName: 'marketCore',
      eventName: 'Trade',
      ledgerClosedAt: new Date(),
      txHash: 'ab'.repeat(32),
      published: false,
      params: { market_id: '7', trader: 'GTRADER', outcome: { tag: 'Yes' }, is_buy: true, collateral: '10', shares: '9', fee: '1', reserve_yes: '100', reserve_no: '100' },
    }));
    (prisma.chainEvent.findMany as any) = async () =>
      rows.filter((r) => !r.published).sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : 1));
    (prisma.chainEvent.update as any) = async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id)!, data);
    (prisma.market.findUnique as any) = async () => ({ id: 'm7', question: 'Q?' });
    try {
      const bus = f.bus(admin);
      const got: Array<{ id: string; ledger: number }> = [];
      const stop = bus.subscribe((e) => { got.push({ id: e.id, ledger: e.ledger }); });
      await sleep(100);
      const result = await publishPending((type, payload, meta) => bus.publish({ ...meta, type, payload }));
      assert.equal(result.published, 3);
      await until(() => got.length === 3, 'bus delivers all three');
      await stop();
      assert.deepEqual(got.map((g) => g.ledger), [100, 200, 300]);
      assert.ok(rows.every((r) => r.published));
    } finally {
      await f.cleanup();
    }
  });

  await t.test('with Redis down the server pieces start, events stay unpublished, then drain when Redis returns', async () => {
    const f = await fixture();
    const { prisma } = await import('../src/lib/prisma');
    const { publishPending } = await import('../src/services/indexer.service');
    const { CONTRACTS } = await import('../src/config/contracts');

    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 1, retryStrategy: () => 100 });
    dead.on('error', () => undefined);
    opened.push(dead);

    // Booting against a dead Redis does not throw. (The streams adapter is not
    // built here: with Redis down it surfaces a rejected subscribe() as an
    // unhandled rejection, which server.ts logs without exiting.)
    const server = http.createServer();
    const io = new Server(server);
    const stopFan = startFanout(f.bus(dead), io, { redis: dead, prefix: `${f.prefix}:fanout`, renewMs: 100 });

    const row = {
      id: '0000000100-0000000001', ledger: 100, contractId: CONTRACTS.marketCore, contractName: 'marketCore',
      eventName: 'Trade', ledgerClosedAt: new Date(), txHash: 'cd'.repeat(32), published: false,
      params: { market_id: '7', trader: 'GTRADER', outcome: { tag: 'No' }, is_buy: true, collateral: '10', shares: '9', fee: '1', reserve_yes: '100', reserve_no: '100' },
    };
    (prisma.chainEvent.findMany as any) = async () => (row.published ? [] : [row]);
    (prisma.chainEvent.update as any) = async ({ data }: any) => Object.assign(row, data);
    (prisma.market.findUnique as any) = async () => null;
    try {
      const down = await publishPending((type, payload, meta) => f.bus(dead).publish({ ...meta, type, payload }));
      assert.equal(down.failed, true);
      assert.equal(row.published, false, 'the row waits for the bus');

      const up = await publishPending((type, payload, meta) => f.bus(admin).publish({ ...meta, type, payload }));
      assert.deepEqual({ published: up.published, failed: up.failed }, { published: 1, failed: false });
      assert.equal(row.published, true);
      assert.equal(await admin.xlen(`${f.prefix}:events`), 1);
    } finally {
      await stopFan().catch(() => undefined);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await f.cleanup();
    }
  });

  for (const client of opened) client.disconnect();
});
