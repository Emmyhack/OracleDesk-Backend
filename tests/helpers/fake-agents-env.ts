/**
 * Everything an agent cycle touches except LLM and data-source traffic (which
 * the cassettes serve, #72): an in-memory Prisma for the models the cycles use,
 * an in-memory IPFS, a fake chain (setChainOverrides), memory stores for
 * signals, LLM guards and forecasts, and a fixed clock.
 *
 * The Prisma stub follows tests/indexer.test.ts (delegate methods replaced on
 * the shared client), with a small where/orderBy/include interpreter so the
 * services' real queries run against it.
 */
import { createHash } from 'node:crypto';

export const NOW = new Date('2026-10-18T12:00:00.000Z');
export const USDC = 10_000_000n;

type Row = Record<string, any>;

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && typeof v !== 'bigint';

const cmp = (a: any, b: any): number => {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
};
const eq = (a: any, b: any) => (a === null || a === undefined ? b === null || b === undefined : cmp(a, b) === 0);

function matchField(value: any, cond: any): boolean {
  if (!isPlainObject(cond)) return eq(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case 'equals': return eq(value, arg);
      case 'in': return (arg as any[]).some((x) => eq(value, x));
      case 'notIn': return !(arg as any[]).some((x) => eq(value, x));
      case 'not': return isPlainObject(arg) ? !matchField(value, arg) : !eq(value, arg);
      case 'gt': return value != null && cmp(value, arg) > 0;
      case 'gte': return value != null && cmp(value, arg) >= 0;
      case 'lt': return value != null && cmp(value, arg) < 0;
      case 'lte': return value != null && cmp(value, arg) <= 0;
      default: throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: any = {}): boolean {
  return Object.entries(where ?? {}).every(([k, cond]) => {
    if (k === 'OR') return (cond as any[]).some((w) => matches(row, w));
    if (k === 'AND') return (cond as any[]).every((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, cond);
    return matchField(row[k], cond);
  });
}

/** Relations the cycles read through include/select: name → (table, foreign key on this row). */
const RELATIONS: Record<string, Record<string, [string, string]>> = {
  position: { market: ['market', 'marketId'], trade: ['trade', 'tradeId'] },
  reasoningTrace: { market: ['market', 'marketId'] },
  trade: { market: ['market', 'marketId'] },
};

const DEFAULTS: Record<string, () => Row> = {
  market: () => ({ status: 'PENDING', totalLiquidity: 0, minimumLiquidity: 100, onChainMarketId: null, seedAmountRaw: null, questionHash: null, metaUri: null, currentYesProb: null }),
  position: () => ({ realisedPnlRaw: '0', realisedCollateralRaw: '0', closedAt: null }),
  tracePublication: () => ({ status: 'AWAITING_PIN', attempts: 0, submittedTraceId: null, lastError: null, nextAttemptAt: null }),
  reasoningTrace: () => ({ ipfsCid: null, traceHash: null, onChainTraceId: null }),
  positionExit: () => ({ txHash: null, error: null }),
  trade: () => ({ txHash: null, executedAt: null, builderFee: 0 }),
};

export class FakeDb {
  readonly tables = new Map<string, Map<string, Row>>();
  private seq = 0;
  /** Every delegate call, as `model.method`. */
  readonly calls: string[] = [];

  table(name: string): Map<string, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  rows(name: string): Row[] {
    return [...this.table(name).values()];
  }

  insert(name: string, data: Row): Row {
    const id = data.id ?? `${name}-${String(++this.seq).padStart(4, '0')}`;
    const row = { ...(DEFAULTS[name]?.() ?? {}), createdAt: new Date(NOW.getTime() + this.seq), updatedAt: NOW, ...data, id };
    this.table(name).set(id, row);
    return row;
  }

  private project(name: string, row: Row, shape?: { select?: any; include?: any }): Row {
    const rel = RELATIONS[name] ?? {};
    const attach = (out: Row, spec: Record<string, any>) => {
      for (const [k, v] of Object.entries(spec)) {
        if (!rel[k] || !v) continue;
        const [table, fk] = rel[k];
        const target = row[fk] == null ? null : this.table(table).get(row[fk]) ?? null;
        out[k] = target && isPlainObject(v) && (v.select || v.include) ? this.project(table, target, v) : target ? { ...target } : null;
      }
      return out;
    };
    if (shape?.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(shape.select)) if (v && !rel[k]) out[k] = row[k];
      return attach(out, shape.select);
    }
    return attach({ ...row }, shape?.include ?? {});
  }

  private apply(row: Row, data: Row): Row {
    for (const [k, v] of Object.entries(data)) {
      if (isPlainObject(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
      else if (v !== undefined) row[k] = v;
    }
    row.updatedAt = NOW;
    return row;
  }

  delegate(name: string) {
    const all = (args: any = {}) => {
      let out = this.rows(name).filter((r) => matches(r, args.where));
      const order = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
      if (order.length) {
        out = [...out].sort((a, b) => {
          for (const o of order) {
            const [k, dir] = Object.entries(o)[0] as [string, string];
            const c = cmp(a[k], b[k]);
            if (c) return dir === 'desc' ? -c : c;
          }
          return 0;
        });
      }
      return args.take ? out.slice(0, args.take) : out;
    };
    const one = (args: any) => all(args)[0] ?? null;
    const rec = (m: string) => this.calls.push(`${name}.${m}`);
    return {
      findMany: async (args: any = {}) => { rec('findMany'); return all(args).map((r) => this.project(name, r, args)); },
      findFirst: async (args: any = {}) => { rec('findFirst'); const r = one(args); return r && this.project(name, r, args); },
      findUnique: async (args: any) => { rec('findUnique'); const r = one(args); return r && this.project(name, r, args); },
      count: async (args: any = {}) => { rec('count'); return all(args).length; },
      create: async ({ data, select, include }: any) => { rec('create'); return this.project(name, this.insert(name, data), { select, include }); },
      update: async ({ where, data, select, include }: any) => {
        rec('update');
        const r = one({ where });
        if (!r) throw Object.assign(new Error(`${name} not found`), { code: 'P2025' });
        return this.project(name, this.apply(r, data), { select, include });
      },
      updateMany: async ({ where, data }: any) => { rec('updateMany'); const rs = all({ where }); rs.forEach((r) => this.apply(r, data)); return { count: rs.length }; },
      upsert: async ({ where, create, update }: any) => {
        rec('upsert');
        const r = one({ where });
        return r ? this.apply(r, update) : this.insert(name, create);
      },
      deleteMany: async ({ where }: any = {}) => { rec('deleteMany'); const rs = all({ where }); rs.forEach((r) => this.table(name).delete(r.id)); return { count: rs.length }; },
      aggregate: async () => { rec('aggregate'); return { _sum: { builderFee: 0, amount: 0 } }; },
    };
  }
}

const MODELS = [
  'agentControl', 'agentControlEvent', 'agentLog', 'market', 'reasoningTrace', 'tracePublication', 'position',
  'positionExit', 'trade', 'ipfsContent', 'chainEvent', 'correlationSnapshot', 'signalCache',
];

export interface FakeAgentsEnv {
  db: FakeDb;
  /** CID → pinned bytes. */
  ipfs: Map<string, Buffer>;
  /** Chain writes and reads the cycle made, in order. */
  chain: Array<{ fn: string; args: unknown[] }>;
  signals: import('../../src/services/signal-store.service').MemorySignalStore;
  /** Waits for fire-and-forget work (trace publication) to settle. */
  settle(): Promise<void>;
  restore(): Promise<void>;
}

/** Installs the fakes; `chain` overrides are merged over the defaults. */
export async function installFakeAgentsEnv(opts: {
  chain?: Partial<import('../../src/services/chain.service').ChainOverrides>;
} = {}): Promise<FakeAgentsEnv> {
  const { prisma } = await import('../../src/lib/prisma');
  const { setChainOverrides } = await import('../../src/services/chain.service');
  const { setIpfsTransport, cidForBytes } = await import('../../src/services/ipfs.service');
  const { MemorySignalStore, setSignalStore } = await import('../../src/services/signal-store.service');
  const { MemoryGuardStore, setLlmGuardStore } = await import('../../src/lib/llm-budget');
  const { MemoryForecastCache, setForecastCache } = await import('../../src/services/forecast.service');
  const { FakeClock, setClock } = await import('../../src/lib/clock');
  const { setSecretsForTest, SECRET_NAMES } = await import('../../src/config/secrets');

  const p: any = prisma;
  const db = new FakeDb();
  const saved: Array<[any, string, any]> = [];
  const replace = (obj: any, key: string, value: any) => { saved.push([obj, key, obj[key]]); obj[key] = value; };
  for (const model of MODELS) {
    const d = db.delegate(model);
    for (const [method, fn] of Object.entries(d)) replace(p[model], method, fn);
  }
  // Raw SQL on these paths: market-creation claims (dry-run never needs one) and chain_events scans.
  replace(p, '$executeRaw', async () => 0);
  replace(p, '$queryRaw', async () => []);
  replace(p, '$queryRawUnsafe', async () => []);
  replace(p, '$transaction', async (arg: any) => (typeof arg === 'function' ? arg(p) : Promise.all(arg)));

  const ipfs = new Map<string, Buffer>();
  const prevIpfs = setIpfsTransport({
    async pin(bytes) { const cid = cidForBytes(bytes); ipfs.set(cid, Buffer.from(bytes)); return cid; },
    async fetch(cid) {
      const b = ipfs.get(cid);
      if (!b) throw new Error(`not pinned: ${cid}`);
      return b;
    },
  });

  const chain: FakeAgentsEnv['chain'] = [];
  const log = <T>(fn: string, impl: (...a: any[]) => Promise<T>) => async (...args: any[]) => { chain.push({ fn, args }); return impl(...args); };
  const prevChain = setChainOverrides({
    marketCoreConfig: log('marketCoreConfig', async () => ({ paused: false, default_fee_bps: 100 }) as any),
    treasuryAvailableCapital: log('treasuryAvailableCapital', async () => 10_000n * USDC),
    treasuryRiskConfig: log('treasuryRiskConfig', async () => ({ agent: 'G', collateral: 'C', market_core: 'M', max_trade: 1_000n * USDC, max_market: 5_000n * USDC, max_daily: 5_000n * USDC })),
    treasuryDailyUsage: log('treasuryDailyUsage', async () => ({ amount: 0n, day_start: 0n })),
    marketCount: log('marketCount', async () => 0n),
    agentCreateMarket: log('agentCreateMarket', async () => ({ mode: 'dry-run', method: 'agent_create_market', value: 0n, txHash: null }) as any),
    publishTrace: log('publishTrace', async () => { throw new Error('publishTrace is not expected in dry-run'); }),
    ...Object.fromEntries(Object.entries(opts.chain ?? {}).map(([fn, impl]) => [fn, log(fn, impl as any)])),
  });

  const signals = new MemorySignalStore();
  const prevSignals = setSignalStore(signals);
  const prevGuard = setLlmGuardStore(new MemoryGuardStore());
  const prevForecast = setForecastCache(new MemoryForecastCache());
  const prevClock = setClock(new FakeClock(NOW));

  // Data-source keys present so ingestion calls out (the cassette answers);
  // fake values, never real ones.
  const fakeKey = (n: string) => createHash('sha256').update(`fake-${n}`).digest('hex').slice(0, 32);
  setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, n === 'NEWSAPI_KEY' || n === 'FRED_API_KEY' ? fakeKey(n) : ''])) as any);

  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };

  return {
    db, ipfs, chain, signals, settle,
    async restore() {
      await settle();
      for (const [obj, key, value] of saved.reverse()) obj[key] = value;
      setIpfsTransport(prevIpfs);
      setChainOverrides(prevChain);
      setSignalStore(prevSignals);
      setLlmGuardStore(prevGuard);
      setForecastCache(prevForecast);
      setClock(prevClock);
      setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, ''])) as any);
    },
  };
}
