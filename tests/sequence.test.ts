import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Account } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// ─── A hand-written Redis double for exactly the commands sequence.ts uses ───

class FakeRedis {
  private store = new Map<string, string>();
  private expiries = new Map<string, number>();
  private zsets = new Map<string, Array<{ score: number; member: string }>>();
  failAll = false;
  failRenew = false;

  private live(key: string): boolean {
    const exp = this.expiries.get(key);
    if (exp !== undefined && exp <= Date.now()) {
      this.store.delete(key);
      this.expiries.delete(key);
      return false;
    }
    return true;
  }

  async get(key: string): Promise<string | null> {
    if (this.failAll) throw new Error('redis down');
    if (!this.live(key)) return null;
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: string[]): Promise<'OK' | null> {
    if (this.failAll) throw new Error('redis down');
    const nx = args.includes('NX');
    if (nx && this.live(key) && this.store.has(key)) return null;
    this.store.set(key, value);
    const px = args.indexOf('PX');
    if (px >= 0) this.expiries.set(key, Date.now() + Number(args[px + 1]));
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.store.delete(key);
    this.expiries.delete(key);
    return 1;
  }

  async incr(key: string): Promise<number> {
    if (this.failAll) throw new Error('redis down');
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const arr = this.zsets.get(key) ?? [];
    const existing = arr.find((e) => e.member === member);
    if (existing) existing.score = score;
    else arr.push({ score, member });
    arr.sort((a, b) => a.score - b.score);
    this.zsets.set(key, arr);
    return 1;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = this.zsets.get(key) ?? [];
    const end = stop < 0 ? arr.length + stop + 1 : stop + 1;
    return arr.slice(start, end).map((e) => e.member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const arr = this.zsets.get(key) ?? [];
    const next = arr.filter((e) => e.member !== member);
    this.zsets.set(key, next);
    return next.length === arr.length ? 0 : 1;
  }

  async eval(script: string, numKeys: number, ...rest: string[]): Promise<number> {
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    if (script.includes('PEXPIRE')) {
      if (this.failRenew) return 0;
      if (this.store.get(keys[0]) !== args[0]) return 0;
      this.expiries.set(keys[0], Date.now() + Number(args[1]));
      return 1;
    }
    if (script.includes("'DEL'")) {
      if (this.store.get(keys[0]) === args[0]) {
        this.store.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    // advance-sequence script
    const stored = this.store.get(keys[1]);
    if (stored && Number(stored) > Number(args[1])) return 0;
    this.store.set(keys[0], args[0]);
    this.store.set(keys[1], args[1]);
    return 1;
  }
}

interface FakeNet {
  state: { seq: bigint };
  rpc: { getAccount(account: string): Promise<Account> };
}

function fakeNet(initial: bigint): FakeNet {
  const state = { seq: initial };
  return {
    state,
    rpc: { async getAccount(account: string) { return new Account(account, state.seq.toString()); } },
  };
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
  const net = fakeNet(100n);
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
  const net = fakeNet(10n);
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
  const net = fakeNet(5n);
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
  const net = fakeNet(5n);
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
  const net = fakeNet(5n);
  const agent = Keypair.random().publicKey();
  await assert.rejects(
    withSourceAccount(agent, async () => undefined, { deps: { rpc: net.rpc, redis: redis as any } }),
    (err: any) => err.code === 'SEQUENCE_LOCK_UNAVAILABLE',
  );
});

test('a lost lock cannot submit: assertHeld throws SequenceLockLost', async () => {
  const { withSourceAccount, SequenceLockLost } = await import('../src/services/stellar/sequence');
  const redis = new FakeRedis();
  const net = fakeNet(5n);
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
  const net = fakeNet(42n);
  const agent = Keypair.random().publicKey();
  assert.equal(await syncSequence(agent, { rpc: net.rpc, redis: redis as any }), 42n);
  assert.equal(await redis.get([...redis.store.keys()].find((k) => k.startsWith('seq:') && !k.endsWith(':fence'))!), '42');
});
