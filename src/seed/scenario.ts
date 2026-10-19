/**
 * Deterministic, internally consistent seed dataset (#147).
 *
 * Every generated hash is computed with the production helpers:
 *   questionHash = sha256(canonical questionDocument)
 *   resolutionHash = sha256(XDR(ResolutionSpec))
 *   traceHash = sha256(canonical trace payload)
 * and the pinned bytes are available from the local IPFS stub because the
 * CID is CIDv1(raw, sha2-256) over exactly those bytes.
 */
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { canonicalBytes, sha256Hex } from '../utils/hash.util';
import { resolutionHash, type ResolutionSpecJson } from '../lib/resolution-spec';
import { questionDocument } from '../services/market-chain.service';
import { cidForBytes } from '../services/ipfs.service';
import { calcBuy, priceYesBps, seedReserves } from '../generated/fpmm';
import { CONTRACTS, DEPLOYED_AGENT } from '../config/contracts';
import { config } from '../config';
import { CURSOR_ID } from '../services/indexer.service';
import { int, mulberry32, pick, seedHash, uuidFrom } from './rng';

export const SEED_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
const USDC_UNIT = 10_000_000n;
const ONCHAIN_BASE = BigInt(process.env.SEED_ONCHAIN_BASE ?? '1000000');
const SEED_BASE_LEDGER = Number(process.env.SEED_BASE_LEDGER ?? '6000000');

const CATEGORIES = [
  'FED',
  'ECB',
  'ELECTION',
  'GEOPOLITICAL',
  'CRYPTO',
  'MACRO',
  'SPORTS',
  'ENTERTAINMENT',
  'POLITICS',
] as const;

const STATUSES = ['PENDING', 'ACTIVE', 'RESOLVING', 'RESOLVED', 'CANCELLED'] as const;

const SOURCES = ['NEWSAPI', 'FRED', 'GDELT', 'ANTHROPIC'];

export interface SeedOptions {
  seed?: number;
  now?: boolean;
  marketCount?: number;
}

export interface SeedData {
  users: any[];
  markets: any[];
  traces: any[];
  trades: any[];
  positions: any[];
  copyTrades: any[];
  subscriptions: any[];
  paymentEvents: any[];
  spendingAllowances: any[];
  chainEvents: any[];
  indexerCursors: any[];
  agentLogs: any[];
  signalCache: any[];
  marketGenerationJobs: any[];
}

function walletFor(label: string): Keypair {
  return Keypair.fromRawEd25519Seed(crypto.createHash('sha256').update(label).digest());
}

export function buildSeedData(options: SeedOptions = {}): SeedData {
  const rng = mulberry32(options.seed ?? 20260101);
  const base = options.now ? Date.now() : SEED_EPOCH;
  const marketCount = options.marketCount ?? 45;
  const agent = walletFor('oracledesk-seed-agent');
  const agentWallet = agent.publicKey();

  const users = Array.from({ length: 12 }, (_, i) => {
    const wallet = walletFor(`oracledesk-seed-user-${i}`);
    return {
      id: `seed-user-${i}`,
      walletAddress: wallet.publicKey(),
      identityKey: wallet.publicKey(),
      email: i % 3 === 0 ? `seed-user-${i}@example.test` : null,
      createdAt: new Date(base - 90 * 86_400_000 + i * 3_600_000),
      updatedAt: new Date(base - 90 * 86_400_000 + i * 3_600_000),
    };
  });

  const spec: ResolutionSpecJson = {
    kind: 'signers',
    signers: [agentWallet],
    threshold: 1,
    disputeWindow: 86_400,
  };
  const specHash = resolutionHash(spec).toString('hex');

  const markets: any[] = [];
  const traces: any[] = [];
  const trades: any[] = [];
  const positions: any[] = [];
  const chainEvents: any[] = [];
  let ledger = SEED_BASE_LEDGER;
  let tradeCounter = 0;
  let traceOnchainCounter = 0;

  const eventId = () => `${String(ledger).padStart(10, '0')}-${String(chainEvents.length + 1).padStart(10, '0')}`;

  for (let i = 0; i < marketCount; i++) {
    const category = CATEGORIES[i % CATEGORIES.length];
    const status = STATUSES[i % STATUSES.length];
    const createdAt = new Date(base - (marketCount - i) * 86_400_000 - int(rng, 0, 20) * 3_600_000);
    const expiry = ['RESOLVED', 'CANCELLED'].includes(status)
      ? new Date(base - (i % 10 + 1) * 86_400_000)
      : new Date(base + (i % 25 + 5) * 86_400_000);
    const initialYesProb = Number((0.25 + rng() * 0.5).toFixed(4));
    const resolved = status === 'RESOLVED';
    const onChainMarketId = status === 'PENDING' ? null : ONCHAIN_BASE + BigInt(i);
    const seedRaw = 250n * USDC_UNIT + BigInt(int(rng, 0, 20)) * USDC_UNIT;
    const marketId = `seed-market-${i}`;

    const market: any = {
      id: marketId,
      question: `Will ${category.toLowerCase()} indicator ${i + 1} move above its ${initialYesProb > 0.5 ? 'upper' : 'lower'} band by expiry?`,
      category,
      status,
      settlementCurrency: 'USDC',
      initialYesProb,
      currentYesProb: status === 'PENDING' ? null : initialYesProb,
      confidenceInterval: {
        lower: Number(Math.max(0.01, initialYesProb - 0.12).toFixed(4)),
        upper: Number(Math.min(0.99, initialYesProb + 0.12).toFixed(4)),
      },
      expiryTimestamp: expiry,
      resolutionOracle: 'oracledesk-resolver',
      resolvedOutcome: resolved ? rng() > 0.5 : null,
      resolvedAt: resolved ? new Date(expiry.getTime() + 3_600_000) : null,
      minimumLiquidity: 100,
      totalLiquidity: Number(seedRaw) / 1e7,
      onChainMarketId,
      creationTxHash: sha256Hex(`seed-market-created-${i}`),
      seedAmountRaw: seedRaw.toString(),
      questionHash: '',
      metaUri: '',
      resolutionHash: specHash,
      resolutionSpec: spec,
      createdAt,
      updatedAt: new Date(base - 60_000),
    };

    const doc = questionDocument(market as any, specHash);
    const docBytes = canonicalBytes(doc);
    market.questionHash = sha256Hex(docBytes);
    market.metaUri = `ipfs://${cidForBytes(docBytes)}`;
    markets.push(market);

    if (onChainMarketId !== null) {
      ledger += 2;
      chainEvents.push({
        id: eventId(),
        contractId: CONTRACTS.marketCore,
        contractName: 'marketCore',
        eventName: 'MarketCreated',
        ledger,
        ledgerClosedAt: new Date(createdAt.getTime() + 60_000),
        txHash: market.creationTxHash,
        params: {
          market_id: onChainMarketId.toString(),
          creator: agentWallet,
          category: { tag: doc.contractCategory, values: undefined },
          close_time: Math.floor(expiry.getTime() / 1000).toString(),
          seed_amount: seedRaw.toString(),
          initial_yes_bps: Math.min(9900, Math.max(100, Math.round(initialYesProb * 10_000))),
        },
      });
    }

    // Trades and positions for markets that are (or were) open.
    let reserveYes = 0n;
    let reserveNo = 0n;
    if (['ACTIVE', 'RESOLVING', 'RESOLVED', 'CANCELLED'].includes(status)) {
      const seeded = seedReserves(seedRaw, BigInt(Math.min(9900, Math.max(100, Math.round(initialYesProb * 10_000)))));
      reserveYes = seeded.reserveYes;
      reserveNo = seeded.reserveNo;
      const tradeCount = status === 'ACTIVE' ? int(rng, 1, 3) : 1;
      for (let t = 0; t < tradeCount; t++) {
        const yes = rng() >= 0.5;
        const collateral = (2n + BigInt(int(rng, 0, 6))) * USDC_UNIT;
        const quote = yes
          ? calcBuy(reserveYes, reserveNo, collateral, 100n)
          : calcBuy(reserveNo, reserveYes, collateral, 100n);
        if (yes) {
          reserveYes = quote.newReserveBought;
          reserveNo = quote.newReserveOther;
        } else {
          reserveNo = quote.newReserveBought;
          reserveYes = quote.newReserveOther;
        }
        const tradeId = `seed-trade-${tradeCounter++}`;
        const txHash = sha256Hex(`seed-trade-tx-${tradeId}`);
        const executedAt = new Date(createdAt.getTime() + (t + 1) * 3_600_000);
        trades.push({
          id: tradeId,
          marketId,
          direction: yes ? 'YES' : 'NO',
          status: 'EXECUTED',
          amount: Number(collateral) / 1e7,
          price: Number(priceYesBps(reserveYes, reserveNo)) / 10_000,
          edgeDetected: Number((rng() * 0.12 - 0.02).toFixed(4)),
          kellyFraction: Number((rng() * 0.2).toFixed(4)),
          txHash,
          builderFee: 0,
          executedAt,
          createdAt: executedAt,
          updatedAt: executedAt,
        });
        positions.push({
          id: `seed-position-${tradeId}`,
          marketId,
          tradeId,
          direction: yes ? 'YES' : 'NO',
          status: status === 'ACTIVE' || status === 'RESOLVING' ? 'OPEN' : 'CLOSED',
          entryPrice: Number(priceYesBps(reserveYes, reserveNo)) / 10_000,
          currentPrice: Number(priceYesBps(reserveYes, reserveNo)) / 10_000,
          size: Number(quote.sharesOut) / 1e7,
          pnl: 0,
          closedAt: status === 'ACTIVE' || status === 'RESOLVING' ? null : new Date(expiry.getTime() + 3_600_000),
          closeReason: status === 'CANCELLED' ? 'VOIDED' : resolved ? 'YES_RESOLVED' : null,
          createdAt: executedAt,
          updatedAt: executedAt,
        });

        ledger += 1;
        chainEvents.push({
          id: eventId(),
          contractId: CONTRACTS.marketCore,
          contractName: 'marketCore',
          eventName: 'Trade',
          ledger,
          ledgerClosedAt: executedAt,
          txHash,
          params: {
            market_id: onChainMarketId!.toString(),
            trader: agentWallet,
            outcome: { tag: yes ? 'Yes' : 'No' },
            is_buy: true,
            collateral: collateral.toString(),
            shares: quote.sharesOut.toString(),
            fee: quote.fee.toString(),
            reserve_yes: reserveYes.toString(),
            reserve_no: reserveNo.toString(),
          },
        });
      }
      market.currentYesProb = Number(priceYesBps(reserveYes, reserveNo)) / 10_000;
      market.totalLiquidity = Number(reserveYes + reserveNo) / 1e7;
    }

    const traceCount = int(rng, 1, 4);
    for (let j = 0; j < traceCount; j++) {
      const agentType = j % 2 === 0 ? 'MARKET_MAKER' : 'TRADER';
      const marketProbability = market.currentYesProb ?? initialYesProb;
      const probabilityEstimate = Number(Math.min(0.98, Math.max(0.02, marketProbability + (rng() * 0.16 - 0.08))).toFixed(4));
      const traceId = `seed-trace-${i}-${j}`;
      const published = j === 0 && onChainMarketId !== null;
      const createdAtTrace = new Date(createdAt.getTime() + (j + 1) * 600_000);
      const sourcesUsed = Array.from({ length: 3 }, (_, s) => ({
        source: SOURCES[(i + j + s) % SOURCES.length],
        weight: Number((0.2 + rng() * 0.3).toFixed(3)),
        signal: `${SOURCES[(i + j + s) % SOURCES.length].toLowerCase()} signal ${i}-${j}-${s}`,
      }));
      const payload: Record<string, unknown> = {
        agentType,
        decisionType: j === 0 ? 'CREATE_MARKET' : 'TRADE',
        marketId,
        sourcesUsed,
        probabilityEstimate,
        marketProbability,
        edge: Number((probabilityEstimate - marketProbability).toFixed(4)),
        confidenceInterval: {
          lower: Number(Math.max(0.01, probabilityEstimate - 0.1).toFixed(4)),
          upper: Number(Math.min(0.99, probabilityEstimate + 0.1).toFixed(4)),
        },
        ...(agentType === 'TRADER' ? { betFraction: Number((rng() * 0.2).toFixed(4)), betSizeUsdc: Number((rng() * 50).toFixed(2)) } : {}),
        hedgeConditions: ['resolution source disagrees with market price'],
        agentWallet,
        timestamp: createdAtTrace.toISOString(),
        traceId,
      };
      const bytes = canonicalBytes(payload);
      traces.push({
        id: traceId,
        marketId,
        agentType,
        decisionType: payload.decisionType,
        sourcesUsed,
        probabilityEstimate,
        marketProbability,
        edge: payload.edge,
        confidenceInterval: payload.confidenceInterval,
        betFraction: payload.betFraction ?? null,
        betSizeUsdc: payload.betSizeUsdc ?? null,
        hedgeConditions: payload.hedgeConditions,
        agentWallet,
        ipfsCid: cidForBytes(bytes),
        traceHash: sha256Hex(bytes),
        onChainTraceId: published ? ONCHAIN_BASE + 10_000n + BigInt(traceOnchainCounter++) : null,
        publishTxHash: published ? sha256Hex(`seed-trace-publish-${traceId}`) : null,
        verified: published,
        isPublic: published,
        previewSources: sourcesUsed.slice(0, 2),
        createdAt: createdAtTrace,
        updatedAt: createdAtTrace,
      });

      if (published) {
        ledger += 1;
        chainEvents.push({
          id: eventId(),
          contractId: CONTRACTS.reasoningRegistry,
          contractName: 'reasoningRegistry',
          eventName: 'TracePublished',
          ledger,
          ledgerClosedAt: createdAtTrace,
          txHash: sha256Hex(`seed-trace-publish-${traceId}`),
          params: {
            trace_id: (ONCHAIN_BASE + 10_000n + BigInt(traceOnchainCounter - 1)).toString(),
            market_id: onChainMarketId!.toString(),
            agent: agentWallet,
            action: payload.decisionType,
            trace_hash: sha256Hex(bytes),
            ipfs_cid: cidForBytes(bytes),
            published_at: Math.floor(createdAtTrace.getTime() / 1000).toString(),
          },
        });
      }
    }

    if (status === 'RESOLVED' || status === 'CANCELLED') {
      ledger += 1;
      chainEvents.push({
        id: eventId(),
        contractId: CONTRACTS.marketCore,
        contractName: 'marketCore',
        eventName: 'MarketResolved',
        ledger,
        ledgerClosedAt: market.resolvedAt ?? expiry,
        txHash: sha256Hex(`seed-market-resolved-${i}`),
        params: {
          market_id: onChainMarketId!.toString(),
          outcome: status === 'CANCELLED' ? null : { tag: market.resolvedOutcome ? 'Yes' : 'No' },
        },
      });
    }
  }

  // Subscriptions and payments across every access path.
  const subscriptions: any[] = [];
  const paymentEvents: any[] = [];
  const spendingAllowances: any[] = [];
  const statuses = ['ACTIVE', 'EXPIRED', 'LIMIT_REACHED'] as const;
  users.forEach((user, i) => {
    const status = statuses[i % statuses.length];
    const txHash = sha256Hex(`seed-subscription-tx-${i}`);
    const createdAt = new Date(base - (20 - i) * 86_400_000);
    const expiresAt = status === 'ACTIVE' ? new Date(base + 12 * 3_600_000) : new Date(base - 86_400_000);
    const trace = traces[i % traces.length];
    subscriptions.push({
      id: `seed-subscription-${i}`,
      userId: user.id,
      traceId: i % 4 === 0 ? null : trace.id,
      type: 'DAILY_PASS',
      status,
      amountPaid: 0.5,
      currency: 'USDC',
      txHash,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    });
    paymentEvents.push({
      id: `seed-payment-${i}`,
      userId: user.id,
      txHash,
      type: 'DAILY_PASS',
      amount: 0.5,
      amountRaw: '5000000',
      fromAddress: user.walletAddress,
      currency: 'USDC',
      status: 'CONFIRMED',
      traceId: null,
      metadata: { subscriptionId: `seed-subscription-${i}`, ledger: SEED_BASE_LEDGER + i },
      createdAt,
      confirmedAt: createdAt,
    });
    spendingAllowances.push({
      id: `seed-allowance-${i}`,
      userId: user.id,
      dailyLimit: 5,
      perTraceLimit: 0.5,
      spentToday: 0.5,
      currency: 'USDC',
      lastResetAt: new Date(base - 3_600_000),
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    });
  });

  const copyTrades = traces.slice(0, 8).map((trace, i) => ({
    id: `seed-copy-${i}`,
    userId: users[i % users.length].id,
    traceId: trace.id,
    marketId: trace.marketId,
    tradeId: trades[i % Math.max(1, trades.length)]?.id ?? null,
    direction: i % 2 === 0 ? 'YES' : 'NO',
    amount: 5,
    amountRaw: '50000000',
    txHash: sha256Hex(`seed-copy-tx-${i}`),
    builderFee: 0.05,
    status: 'EXECUTED',
    pnl: 0,
    createdAt: new Date(base - i * 3_600_000),
    updatedAt: new Date(base - i * 3_600_000),
  }));

  const marketGenerationJobs = markets.slice(0, 5).map((market, i) => ({
    id: `seed-generation-job-${i}`,
    status: 'COMPLETED',
    marketId: market.id,
    traceId: traces.find((trace) => trace.marketId === market.id)?.id ?? null,
    error: null,
    startedAt: new Date(market.createdAt.getTime() - 600_000),
    completedAt: market.createdAt,
  }));

  const agentLogs = Array.from({ length: 12 }, (_, i) => ({
    id: `seed-log-${i}`,
    agentType: i % 2 === 0 ? 'MARKET_MAKER' : 'TRADER',
    level: pick(rng, ['INFO', 'WARN', 'DEBUG', 'ERROR'] as const),
    action: i % 3 === 0 ? 'market_generation' : 'trace_generation',
    marketId: markets[i % markets.length].id,
    data: { seed: true, index: i },
    error: null,
    createdAt: new Date(base - i * 1_800_000),
  }));

  const signalCache = [
    {
      id: 'seed-signal-0',
      source: 'NEWSAPI',
      payload: [{ source: 'NEWSAPI', title: 'Seed signal', content: 'Deterministic fixture', publishedAt: new Date(base).toISOString(), relevanceScore: 0.7, category: 'FED' }],
      fetchedAt: new Date(base - 3_600_000),
      expiresAt: new Date(base + 3_600_000),
    },
    {
      id: 'seed-signal-1',
      source: 'FRED',
      payload: [{ source: 'FRED', title: 'FEDFUNDS: 4.25', content: 'Seed macro observation', publishedAt: new Date(base).toISOString(), relevanceScore: 0.9, category: 'FED' }],
      fetchedAt: new Date(base - 7_200_000),
      expiresAt: new Date(base + 3_600_000),
    },
  ];

  const maxLedger = chainEvents.reduce((max, event) => Math.max(max, event.ledger), SEED_BASE_LEDGER);

  return {
    users,
    markets,
    traces,
    trades,
    positions,
    copyTrades,
    subscriptions,
    paymentEvents,
    spendingAllowances,
    chainEvents,
    indexerCursors: [{ id: CURSOR_ID, lastLedger: maxLedger }],
    agentLogs,
    signalCache,
    marketGenerationJobs,
  };
}

/** CIDv1 raw leaves for exactly the bytes the seed hashed. */
export function seedCid(bytes: Buffer): string {
  return cidForBytes(bytes);
}

export { ONCHAIN_BASE, SEED_BASE_LEDGER, USDC_UNIT, walletFor, DEPLOYED_AGENT, config };
