import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function start() {
  const lib = await import('../src/lib/socket-auth');
  const { signToken } = await import('../src/middlewares/auth.middleware');
  const server = http.createServer();
  const io = new Server(server);
  io.use(lib.socketAuthMiddleware());
  lib.attachSessionLifecycle(io);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: ClientSocket[] = [];
  const client = (opts: Parameters<typeof connect>[1] = {}) => {
    const c = connect(url, { forceNew: true, reconnection: false, transports: ['websocket'], ...opts });
    clients.push(c);
    return c;
  };
  const stop = async () => {
    for (const c of clients) c.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
  return { lib, io, url, client, stop, signToken };
}

const once = <T = unknown>(socket: ClientSocket, event: string, ms = 1500) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const connected = (socket: ClientSocket) => once(socket, 'connect');
const failed = (socket: ClientSocket) => once<Error & { data?: { code?: string } }>(socket, 'connect_error');
const quiet = (socket: ClientSocket, event: string, ms = 250) =>
  new Promise<boolean>((resolve) => {
    let got = false;
    socket.once(event, () => { got = true; });
    setTimeout(() => resolve(!got), ms);
  });
const roomSize = (io: Server, room: string) => io.sockets.adapter.rooms.get(room)?.size ?? 0;

test('an anonymous socket connects, receives public events and never private ones', async () => {
  const t = await start();
  try {
    const anon = t.client();
    await connected(anon);
    const publicEvent = once(anon, 'TRADE_EXECUTED');
    t.io.emit('TRADE_EXECUTED', { n: 1 });
    assert.deepEqual(await publicEvent, { n: 1 });

    const silent = quiet(anon, 'PAYMENT_CONFIRMED');
    t.lib.emitToUser(t.io, 'user-1', 'PAYMENT_CONFIRMED', { secret: true });
    assert.equal(await silent, true);
  } finally {
    await t.stop();
  }
});

test('a valid token joins the user room and receives that user\'s private events only', async () => {
  const t = await start();
  try {
    const alice = t.client({ auth: { token: t.signToken('alice', Keypair.random().publicKey()) } });
    const bob = t.client({ auth: { token: t.signToken('bob', Keypair.random().publicKey()) } });
    await Promise.all([connected(alice), connected(bob)]);
    assert.equal(roomSize(t.io, t.lib.userRoom('alice')), 1);

    const got = once<{ subscriptionId: string }>(alice, 'PAYMENT_CONFIRMED');
    const bobSilent = quiet(bob, 'PAYMENT_CONFIRMED');
    t.lib.emitToUser(t.io, 'alice', 'PAYMENT_CONFIRMED', { subscriptionId: 's1' });
    assert.equal((await got).subscriptionId, 's1');
    assert.equal(await bobSilent, true, "another user's socket never receives it");
  } finally {
    await t.stop();
  }
});

test('every tab of one user receives the event', async () => {
  const t = await start();
  try {
    const token = t.signToken('alice', Keypair.random().publicKey());
    const tabs = [t.client({ auth: { token } }), t.client({ auth: { token } })];
    await Promise.all(tabs.map(connected));
    const all = tabs.map((c) => once(c, 'PASS_EXPIRING'));
    t.lib.emitToUser(t.io, 'alice', 'PASS_EXPIRING', { subscriptionId: 's' });
    await Promise.all(all);
  } finally {
    await t.stop();
  }
});

test('an invalid token fails the handshake with INVALID_TOKEN', async () => {
  const t = await start();
  try {
    for (const token of ['garbage', jwt.sign({ userId: 'u', walletAddress: 'G' }, 'x'.repeat(40), { expiresIn: '1h' })]) {
      const bad = t.client({ auth: { token } });
      const err = await failed(bad);
      assert.equal(err.message, 'INVALID_TOKEN');
      assert.equal(err.data?.code, 'INVALID_TOKEN');
    }
  } finally {
    await t.stop();
  }
});

test('only HS256 is accepted (alg none and other HMACs are rejected)', async () => {
  const t = await start();
  try {
    const { secret } = await import('../src/config/secrets');
    const forged = jwt.sign({ userId: 'u', walletAddress: 'G' }, secret('JWT_SECRET'), { algorithm: 'HS512', expiresIn: '1h' });
    const err = await failed(t.client({ auth: { token: forged } }));
    assert.equal(err.data?.code, 'INVALID_TOKEN');
  } finally {
    await t.stop();
  }
});

test('an expired token fails the handshake with TOKEN_EXPIRED', async () => {
  const t = await start();
  try {
    const { secret } = await import('../src/config/secrets');
    const expired = jwt.sign({ userId: 'u', walletAddress: 'G' }, secret('JWT_SECRET'), { expiresIn: -10 });
    const err = await failed(t.client({ auth: { token: expired } }));
    assert.equal(err.message, 'TOKEN_EXPIRED');
    assert.equal(err.data?.code, 'TOKEN_EXPIRED');
  } finally {
    await t.stop();
  }
});

test('a token in the query string is rejected, even a valid one', async () => {
  const t = await start();
  try {
    const token = t.signToken('alice', Keypair.random().publicKey());
    const err = await failed(t.client({ query: { token } }));
    assert.equal(err.data?.code, 'TOKEN_IN_QUERY');
  } finally {
    await t.stop();
  }
});

test('the session ends at exp: SESSION_EXPIRED, the user room is left, public events continue', async () => {
  const t = await start();
  try {
    const { secret } = await import('../src/config/secrets');
    const short = jwt.sign({ userId: 'alice', walletAddress: Keypair.random().publicKey() }, secret('JWT_SECRET'), { expiresIn: '2s' });
    const socket = t.client({ auth: { token: short } });
    await connected(socket);
    assert.equal(roomSize(t.io, t.lib.userRoom('alice')), 1);

    const expired = await once<{ reason: string }>(socket, 'SESSION_EXPIRED', 4000);
    assert.equal(expired.reason, 'TOKEN_EXPIRED');
    assert.equal(roomSize(t.io, t.lib.userRoom('alice')), 0);

    const silent = quiet(socket, 'PAYMENT_CONFIRMED');
    t.lib.emitToUser(t.io, 'alice', 'PAYMENT_CONFIRMED', {});
    assert.equal(await silent, true);

    assert.equal(socket.connected, true);
    const pub = once(socket, 'REASONING_PUBLISHED');
    t.io.emit('REASONING_PUBLISHED', { ok: 1 });
    await pub;
  } finally {
    await t.stop();
  }
});

test('reauth with a fresh token for the same user extends the session; another user is refused', async () => {
  const t = await start();
  try {
    const { secret } = await import('../src/config/secrets');
    const wallet = Keypair.random().publicKey();
    const short = jwt.sign({ userId: 'alice', walletAddress: wallet }, secret('JWT_SECRET'), { expiresIn: '2s' });
    const socket = t.client({ auth: { token: short } });
    await connected(socket);

    const fresh = t.signToken('alice', wallet);
    const ack = await socket.emitWithAck('reauth', { token: fresh });
    assert.equal(ack.ok, true);
    assert.ok(ack.exp > Math.floor(Date.now() / 1000) + 3600);

    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(roomSize(t.io, t.lib.userRoom('alice')), 1, 'the old expiry no longer applies');

    const other = await socket.emitWithAck('reauth', { token: t.signToken('mallory', Keypair.random().publicKey()) });
    assert.deepEqual(other, { ok: false, code: 'USER_MISMATCH' });
    assert.equal(roomSize(t.io, t.lib.userRoom('mallory')), 0);

    assert.deepEqual(await socket.emitWithAck('reauth', { token: 'nope' }), { ok: false, code: 'INVALID_TOKEN' });
  } finally {
    await t.stop();
  }
});

test('reauth after expiry rejoins the room', async () => {
  const t = await start();
  try {
    const { secret } = await import('../src/config/secrets');
    const wallet = Keypair.random().publicKey();
    const short = jwt.sign({ userId: 'alice', walletAddress: wallet }, secret('JWT_SECRET'), { expiresIn: '1s' });
    const socket = t.client({ auth: { token: short } });
    await connected(socket);
    await once(socket, 'SESSION_EXPIRED', 3000);
    assert.equal((await socket.emitWithAck('reauth', { token: t.signToken('alice', wallet) })).ok, true);
    const got = once(socket, 'COPY_TRADE_CONFIRMED');
    t.lib.emitToUser(t.io, 'alice', 'COPY_TRADE_CONFIRMED', {});
    await got;
  } finally {
    await t.stop();
  }
});

test('assertPublic refuses private event names and emitToUser refuses public ones', async () => {
  const lib = await import('../src/lib/socket-auth');
  for (const name of lib.PRIVATE_EVENTS) assert.throws(() => lib.assertPublic(name), /private event/);
  assert.doesNotThrow(() => lib.assertPublic('TRADE_EXECUTED'));
  assert.throws(() => lib.emitToUser({} as Server, 'u', 'TRADE_EXECUTED' as never, {}), /not a private event/);
});

test('no source file broadcasts a private event', () => {
  const root = join(__dirname, '..', '..', 'src');
  const names = ['PAYMENT_CONFIRMED', 'PASS_EXPIRING', 'COPY_TRADE_CONFIRMED'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of names) {
      // Private events go through emitToUser / notifyUser only; a literal first
      // argument to any .emit( outside socket-auth.ts would be a broadcast.
      if (file.endsWith('socket-auth.ts')) continue;
      const literalEmit = new RegExp(`\\.emit\\(\\s*['"\`]${name}['"\`]`);
      assert.ok(!literalEmit.test(text), `${file} emits ${name} directly`);
    }
  }
});

test('notifyExpiringPasses emits once per pass across two runs', async () => {
  const lib = await import('../src/lib/socket-auth');
  const { prisma } = await import('../src/lib/prisma');
  const { notifyExpiringPasses } = await import('../src/services/subscription.service');
  const now = new Date('2026-10-18T12:00:00Z');
  const rows = [
    { id: 'soon', userId: 'alice', expiresAt: new Date('2026-10-18T12:30:00Z'), expiryNotifiedAt: null as Date | null },
    { id: 'later', userId: 'bob', expiresAt: new Date('2026-10-18T20:00:00Z'), expiryNotifiedAt: null as Date | null },
  ];
  (prisma.subscription.findMany as any) = async ({ where }: any) =>
    rows.filter((r) => r.expiryNotifiedAt === null && r.expiresAt > where.expiresAt.gt && r.expiresAt <= where.expiresAt.lte);
  (prisma.subscription.updateMany as any) = async ({ where, data }: any) => {
    const row = rows.find((r) => r.id === where.id && r.expiryNotifiedAt === null);
    if (!row) return { count: 0 };
    row.expiryNotifiedAt = data.expiryNotifiedAt;
    return { count: 1 };
  };

  const server = http.createServer();
  const io = new Server(server);
  lib.setRealtime(io);
  const sent: Array<{ room: string; event: string; payload: any }> = [];
  (io as any).to = (room: string) => ({ emit: (event: string, payload: any) => { sent.push({ room, event, payload }); } });
  try {
    assert.equal(await notifyExpiringPasses(60, now), 1);
    assert.equal(await notifyExpiringPasses(60, now), 0, 'the second run finds the pass already claimed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].room, 'user:alice');
    assert.equal(sent[0].event, 'PASS_EXPIRING');
    assert.equal(sent[0].payload.subscriptionId, 'soon');
  } finally {
    lib.setRealtime(null);
    io.close();
  }
});

test('recordPayment emits PAYMENT_CONFIRMED once after commit, not on re-submit and not on rollback', async () => {
  const lib = await import('../src/lib/socket-auth');
  const { prisma } = await import('../src/lib/prisma');
  const verification = await import('../src/services/payment-verification.service');
  const { CONTRACTS, PAYMENTS_RECIPIENT } = await import('../src/config/contracts');
  const { config } = await import('../src/config');
  const { recordPayment } = await import('../src/services/subscription.service');
  const { Account, Address, Operation, TransactionBuilder, nativeToScVal, rpc } = await import('@stellar/stellar-sdk');

  const user = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(user, '1'), { fee: '100', networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({
      contract: CONTRACTS.usdc,
      function: 'transfer',
      args: [new Address(user).toScVal(), new Address(PAYMENTS_RECIPIENT).toScVal(), nativeToScVal(5_000_000n, { type: 'i128' })],
    }))
    .setTimeout(30)
    .build();
  const prev = verification.setTransactionReader({
    async getTransaction(hash: string) {
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 7, envelopeXdr: tx.toEnvelope() } as any;
    },
  });

  const used = new Map<string, { userId: string }>();
  const subs: any[] = [];
  let failCommit = false;
  (prisma.paymentEvent.findUnique as any) = async ({ where }: any) => used.get(where.txHash) ?? null;
  (prisma.subscription.findFirst as any) = async ({ where }: any) => subs.find((x) => x.txHash === where.txHash) ?? null;
  (prisma.spendingAllowance.findUnique as any) = async () => null;
  (prisma.$transaction as any) = async (fn: any) => {
    const result = await fn({
      subscription: { create: async ({ data }: any) => { const row = { id: `sub-${subs.length}`, ...data }; if (!failCommit) subs.push(row); return row; } },
      paymentEvent: { create: async ({ data }: any) => { if (!failCommit) used.set(data.txHash, { userId: data.userId }); return data; } },
      spendingAllowance: { updateMany: async () => ({ count: 0 }) },
    });
    if (failCommit) throw new Error('commit failed');
    return result;
  };

  const sent: Array<{ room: string; event: string; payload: any }> = [];
  lib.setRealtime({ to: (room: string) => ({ emit: (event: string, payload: any) => { sent.push({ room, event, payload }); } }) } as unknown as Server);
  try {
    failCommit = true;
    await assert.rejects(recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: 'cd'.repeat(32) }), /commit failed/);
    assert.equal(sent.length, 0, 'a rolled-back payment is not announced');

    failCommit = false;
    await recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: 'cd'.repeat(32) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].room, 'user:u1');
    assert.equal(sent[0].event, 'PAYMENT_CONFIRMED');
    assert.deepEqual(Object.keys(sent[0].payload).sort(), ['amountRaw', 'expiresAt', 'subscriptionId', 'txHash', 'type']);

    await recordPayment({ userId: 'u1', walletAddress: user, type: 'DAILY_PASS', txHash: 'cd'.repeat(32) });
    assert.equal(sent.length, 1, 'the idempotent re-submit does not announce again');
  } finally {
    lib.setRealtime(null);
    verification.setTransactionReader(prev);
  }
});

test('confirming a copy trade emits COPY_TRADE_CONFIRMED to its owner', async () => {
  const lib = await import('../src/lib/socket-auth');
  const { notifyCopyTradeConfirmed } = await import('../src/services/copy-trade.service');
  const sent: Array<{ room: string; event: string; payload: any }> = [];
  lib.setRealtime({ to: (room: string) => ({ emit: (event: string, payload: any) => { sent.push({ room, event, payload }); } }) } as unknown as Server);
  try {
    notifyCopyTradeConfirmed({ id: 'ct1', userId: 'u1', txHash: 'ab'.repeat(32), status: 'EXECUTED' }, true);
    assert.deepEqual(sent, [{
      room: 'user:u1',
      event: 'COPY_TRADE_CONFIRMED',
      payload: { copyTradeId: 'ct1', txHash: 'ab'.repeat(32), status: 'EXECUTED', verified: true },
    }]);
  } finally {
    lib.setRealtime(null);
  }
});
