/**
 * `npm run db:seed` / `npx prisma db seed` (#147).
 *
 * Deterministic dataset. The same seed always produces the same rows, every
 * hash is computed with the production helpers, and the pinned bytes are
 * written to the local IPFS stub so `POST /traces/verify` can pass offline.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { canonicalBytes } from '../src/utils/hash.util';
import { questionDocument } from '../src/services/market-chain.service';
import { cidForBytes } from '../src/services/ipfs.service';
import { buildSeedData, SEED_EPOCH } from '../src/seed/scenario';
import { encodeSeedEvents } from '../src/seed/raw-events';
import { ensureAdminRbacSeeded } from '../src/services/admin-rbac.service';

const prisma = new PrismaClient();

const TABLE_ORDER = [
  'copyTrade',
  'position',
  'subscription',
  'paymentEvent',
  'spendingAllowance',
  'agentLog',
  'signalCache',
  'reasoningTrace',
  'trade',
  'chainEvent',
  'indexerCursor',
  'marketGenerationJob',
  'market',
  'user',
] as const;

interface Args {
  reset: boolean;
  now: boolean;
  linkTestnet: boolean;
  withRawEvents?: string;
  fromSnapshot?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { reset: false, now: false, linkTestnet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reset') args.reset = true;
    else if (arg === '--now') args.now = true;
    else if (arg === '--link-testnet') args.linkTestnet = true;
    else if (arg === '--with-raw-events') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--with-raw-events needs a file path');
      args.withRawEvents = next;
      i++;
    } else if (arg === '--from-snapshot') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--from-snapshot needs a directory');
      args.fromSnapshot = next;
      i++;
    }
  }
  return args;
}

function assertSafeDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production');
  }
  if (process.env.CHAIN_EXECUTION_MODE === 'live') {
    throw new Error('Refusing to seed with CHAIN_EXECUTION_MODE=live; the seed is read-only');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  const allowed = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'oracledesk']);
  if (!allowed.has(host) && process.env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to seed remote database host "${host}"; set SEED_ALLOW_REMOTE=1 to override`);
  }
}

async function reset(): Promise<void> {
  for (const table of TABLE_ORDER) {
    await (prisma as any)[table].deleteMany({});
  }
}

async function insertData(data: ReturnType<typeof buildSeedData>): Promise<void> {
  const sets: Array<[string, any[]]> = [
    ['user', data.users],
    ['market', data.markets],
    ['reasoningTrace', data.traces],
    ['trade', data.trades],
    ['position', data.positions],
    ['copyTrade', data.copyTrades],
    ['subscription', data.subscriptions],
    ['paymentEvent', data.paymentEvents],
    ['spendingAllowance', data.spendingAllowances],
    ['agentLog', data.agentLogs],
    ['signalCache', data.signalCache],
    ['chainEvent', data.chainEvents],
    ['indexerCursor', data.indexerCursors],
    ['marketGenerationJob', data.marketGenerationJobs],
  ];
  for (const [table, rows] of sets) {
    if (rows.length === 0) continue;
    await (prisma as any)[table].createMany({ data: rows, skipDuplicates: true });
  }
}

/** Writes the exact bytes each seeded hash commits to, under `.ipfs-local/`. */
function writeLocalIpfs(data: ReturnType<typeof buildSeedData>): string {
  const dir = process.env.IPFS_LOCAL_DIR || '.ipfs-local';
  fs.mkdirSync(dir, { recursive: true });
  for (const market of data.markets) {
    const bytes = canonicalBytes(questionDocument(market as any, market.resolutionHash));
    fs.writeFileSync(path.join(dir, cidForBytes(bytes)), bytes);
  }
  for (const trace of data.traces) {
    const payload: Record<string, unknown> = {
      agentType: trace.agentType,
      decisionType: trace.decisionType,
      marketId: trace.marketId,
      sourcesUsed: trace.sourcesUsed,
      probabilityEstimate: trace.probabilityEstimate,
      marketProbability: trace.marketProbability,
      edge: trace.edge,
      confidenceInterval: trace.confidenceInterval,
      ...(trace.agentType === 'TRADER'
        ? { betFraction: trace.betFraction ?? undefined, betSizeUsdc: trace.betSizeUsdc ?? undefined }
        : {}),
      hedgeConditions: trace.hedgeConditions,
      agentWallet: trace.agentWallet,
      timestamp: trace.createdAt.toISOString(),
      traceId: trace.id,
    };
    const bytes = canonicalBytes(payload);
    fs.writeFileSync(path.join(dir, cidForBytes(bytes)), bytes);
  }
  return dir;
}

function readNdjson(dir: string): Record<string, any[]> {
  const tables: Record<string, any[]> = {};
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ndjson')) continue;
    const table = entry.replace(/\.ndjson$/, '');
    tables[table] = fs
      .readFileSync(path.join(dir, entry), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return tables;
}

async function insertSnapshot(dir: string): Promise<void> {
  const tables = readNdjson(dir);
  const order = [
    'user',
    'market',
    'reasoning_trace',
    'trade',
    'position',
    'copy_trade',
    'subscription',
    'payment_event',
    'spending_allowance',
    'agent_log',
    'signal_cache',
    'chain_event',
    'indexer_cursor',
  ];
  const map: Record<string, string> = {
    user: 'user',
    market: 'market',
    reasoning_trace: 'reasoningTrace',
    trade: 'trade',
    position: 'position',
    copy_trade: 'copyTrade',
    subscription: 'subscription',
    payment_event: 'paymentEvent',
    spending_allowance: 'spendingAllowance',
    agent_log: 'agentLog',
    signal_cache: 'signalCache',
    chain_event: 'chainEvent',
    indexer_cursor: 'indexerCursor',
  };
  for (const key of order) {
    const rows = tables[key];
    if (!rows?.length) continue;
    await (prisma as any)[map[key]].createMany({ data: rows, skipDuplicates: true });
  }
}

async function linkTestnet(): Promise<void> {
  // Reads only, never writes to chain. A real on-chain id may only be linked
  // when `get_market` succeeds; the hash is copied from chain, never invented.
  const ids = (process.env.SEED_TESTNET_MARKET_IDS ?? '0,1')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  const { getOnChainMarket } = await import('../src/services/chain.service');
  for (const id of ids) {
    try {
      const market = await getOnChainMarket(BigInt(id));
      const tags = (market.category as any)?.tag ? [(market.category as any).tag] : [];
      const backendCategory =
        tags[0] === 'Macro' ? 'MACRO'
        : tags[0] === 'Geopolitics' ? 'GEOPOLITICAL'
        : tags[0] === 'Crypto' ? 'CRYPTO'
        : tags[0] === 'Sports' ? 'SPORTS'
        : tags[0] === 'Culture' ? 'ENTERTAINMENT'
        : 'MACRO';
      await (prisma as any).market.createMany({
        data: [{
          id: `seed-testnet-market-${id}`,
          question: `[testnet market ${id}] (question text unavailable)`,
          category: backendCategory,
          status: 'ACTIVE',
          initialYesProb: 0.5,
          currentYesProb: 0.5,
          confidenceInterval: { lower: 0.4, upper: 0.6 },
          expiryTimestamp: new Date(SEED_EPOCH + 30 * 86_400_000),
          onChainMarketId: BigInt(id),
          questionHash: Buffer.from((market as any).question_hash).toString('hex'),
          metaUri: (market as any).meta_uri,
          resolutionHash: Buffer.from((market as any).resolution_hash).toString('hex'),
          seedAmountRaw: (market as any).seed_amount?.toString?.() ?? null,
        }],
        skipDuplicates: true,
      });
      console.log(`Linked testnet market ${id}`);
    } catch (err) {
      console.warn(`Skipping testnet market ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main(): Promise<void> {
  assertSafeDatabase();
  const args = parseArgs(process.argv.slice(2));
  if (args.reset) await reset();

  if (args.fromSnapshot) {
    await insertSnapshot(args.fromSnapshot);
    console.log(`Loaded snapshot from ${args.fromSnapshot}`);
  } else {
    const data = buildSeedData({ now: args.now });
    await insertData(data);
    const dir = writeLocalIpfs(data);
    console.log(
      `Seeded ${data.markets.length} markets, ${data.traces.length} traces, ${data.chainEvents.length} chain events (IPFS stub: ${dir})`,
    );
    if (args.withRawEvents) {
      fs.writeFileSync(args.withRawEvents, JSON.stringify(encodeSeedEvents(data.chainEvents), null, 2) + '\n');
      console.log(`Wrote raw getEvents fixture to ${args.withRawEvents}`);
    }
  }

  // Seed the admin RBAC catalogue and first-deploy super admins (#49).
  // Idempotent: existing DB assignments are never overwritten from env.
  await ensureAdminRbacSeeded();

  if (args.linkTestnet) await linkTestnet();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
