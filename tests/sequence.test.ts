import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';
import { FakeRedis, fakeRpc } from './helpers/fake-redis';

setupTestEnv();

interface FakeNet {
  state: { seq: bigint };
  rpc: { getAccount(account: string): Promise<import('@stellar/stellar-sdk').Account> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Models the network rule: only current + 1 is accepted; an accepted tx advances the account. */
async function submit(ctx: { account: Account; advanceSequence(): Promise<void> }, net: FakeNet): Promise<'OK' | 'BAD_SEQ'> {
  const txSeq = BigInt(ctx.account.sequenceNumber()) + 1n;
  if (txSeq !== net.state.seq + 1n) return 'BAD_SEQ';
  net.state.seq = txSeq;
  await ctx.advanceSequence();
  return 'OK';
}

test('twenty concurrent writes from four workers land gap-free and never bad-sequence', async () => {
  const { withSourceAccount } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(100n);
  const agent = Keypair.random().publicKey();

  const worker = async () => {
    for (let i = 0; i < 5; i++) {
      await withSourceAccount(
        agent,
        async (ctx) => {
          await sleep(Math.floor(Math.random() * 3));
          assert.equal(await submit(ctx, net), 'OK');
        },
        { deps: { rpc: net.rpc, redis: redis as any } },
      );
    }
  };

  await Promise.all([worker(), worker(), worker(), worker()]);
  assert.equal(net.state.seq, 120n, 'sequence advanced exactly 20 times');
});

test('a stale holder with an older fence cannot move the cached sequence backwards', async () => {
  const { withSourceAccount } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(10n);
  const agent = Keypair.random().publicKey();

  let staleCtx: any;
  // First holder gets fence 1 and holds the lock briefly.
  const hold = withSourceAccount(agent, async (ctx) => {
    staleCtx = ctx;
    await sleep(30);
  }, { deps: { rpc: net.rpc, redis: redis as any } });
  await sleep(1);
  // Second holder queues behind it, so it gets the higher fence.
  const second = withSourceAccount(agent, async (ctx) => {
    ctx.account.sequenceNumber = () => '20';
    await ctx.advanceSequence();
  }, { deps: { rpc: net.rpc, redis: redis as any } });
  await hold;
  await second;

  const seqKey = [...redis.store.keys()].find((k) => k.startsWith('seq:') && !k.endsWith(':fence'))!;
  assert.equal(await redis.get(seqKey), '21');

  // The stale, older-fence holder must not regress the cache.
  staleCtx.account.sequenceNumber = () => '11';
  await staleCtx.advanceSequence();
  assert.equal(await redis.get(seqKey), '21');
});

test('re-entrant withSourceAccount for the same account throws SequenceReentrancy', async () => {
  const { withSourceAccount, SequenceReentrancy } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(5n);
  const agent = Keypair.random().publicKey();
  await assert.rejects(
    withSourceAccount(agent, async () => {
      await withSourceAccount(agent, async () => undefined, { deps: { rpc: net.rpc, redis: redis as any } });
    }, { deps: { rpc: net.rpc, redis: redis as any } }),
    SequenceReentrancy,
  );
});

test('a waited-out acquisition fails with a retryable SEQUENCE_LOCK_TIMEOUT', async () => {
  const { withSourceAccount } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(5n);
  const agent = Keypair.random().publicKey();

  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const first = withSourceAccount(agent, async () => { await held; }, { deps: { rpc: net.rpc, redis: redis as any } });
  await sleep(1);

  await assert.rejects(
    withSourceAccount(agent, async () => undefined, { waitMs: 0, deps: { rpc: net.rpc, redis: redis as any } }),
    (err: any) => err.code === 'SEQUENCE_LOCK_TIMEOUT',
  );
  release();
  await first;
});

test('Redis being unavailable makes the lock fail closed', async () => {
  const { withSourceAccount } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  redis.failAll = true;
  const net = fakeRpc(5n);
  const agent = Keypair.random().publicKey();
  await assert.rejects(
    withSourceAccount(agent, async () => undefined, { deps: { rpc: net.rpc, redis: redis as any } }),
    (err: any) => err.code === 'SEQUENCE_LOCK_UNAVAILABLE',
  );
});

test('a lost lock cannot submit: assertHeld throws SequenceLockLost', async () => {
  const { withSourceAccount, SequenceLockLost } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(5n);
  const agent = Keypair.random().publicKey();
  await withSourceAccount(agent, async (ctx) => {
    redis.failRenew = true;
    await ctx.renew();
    assert.throws(() => ctx.assertHeld(), SequenceLockLost);
  }, { deps: { rpc: net.rpc, redis: redis as any } });
});

test('syncSequence reads the account sequence from RPC into Redis', async () => {
  const { syncSequence } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeRpc(42n);
  const agent = Keypair.random().publicKey();
  assert.equal(await syncSequence(agent, { rpc: net.rpc, redis: redis as any }), 42n);
  assert.equal(await redis.get([...redis.store.keys()].find((k) => k.startsWith('seq:') && !k.endsWith(':fence'))!), '42');
});
