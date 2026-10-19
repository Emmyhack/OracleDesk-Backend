import { Account } from '@stellar/stellar-sdk';

/**
 * An in-memory Redis double covering exactly the commands the sequence lock
 * uses (get/set PX NX/del/incr/zadd/zrange/zrem/pexpire/eval of the three
 * script constants). Shared by the sequence and agent-controls tests so the
 * live write path can run without a Redis server (#36).
 */
export class FakeRedis {
  store = new Map<string, string>();
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

  async pexpire(key: string, ms: number): Promise<number> {
    this.expiries.set(key, Date.now() + Number(ms));
    return 1;
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

/** A minimal RPC double whose getAccount returns an account at `seq`. */
export function fakeRpc(seq: bigint): {
  state: { seq: bigint };
  rpc: { getAccount(account: string): Promise<Account> };
} {
  const state = { seq };
  return {
    state,
    rpc: { async getAccount(account: string) { return new Account(account, state.seq.toString()); } },
  };
}
