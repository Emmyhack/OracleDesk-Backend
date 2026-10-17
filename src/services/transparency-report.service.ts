/**
 * Daily, chain-only transparency report (#159).
 *
 * The report is a deterministic JSON document (schema v1) computed from chain
 * reads and `chain_events`. Prisma float models are never used.
 * Amounts are decimal strings in base units. The document is pinned, its
 * sha256 is published through the reasoning registry under the documented
 * sentinel market id, and a row is persisted for the public index.
 */
import dayjs from 'dayjs';
import { Contract, xdr } from '@stellar/stellar-sdk';
import utc from 'dayjs/plugin/utc';
import { config } from '../config';
import { CONTRACTS } from '../config/contracts';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { priceYesBps, collateralOutForShares, settleValue, type Settlement } from '../generated/fpmm';
import type { Market as OnChainMarket, Position } from '../generated/market-core';
import { agentSigner, rpcServer } from './stellar/clients';
import {
  getOnChainMarket,
  getPosition,
  marketCount,
  treasuryAvailableCapital,
  treasuryConfig,
  treasuryDailyUsage,
} from './chain.service';
import { pinAndPublishDocument, publishPinnedDocument } from './trace-publish.service';

dayjs.extend(utc);

/** u64::MAX: reports are not about one market, so they use a sentinel. */
export const REPORT_MARKET_ID = 18446744073709551615n;
export const REPORT_KIND = 'oracledesk.transparency-report';
export const REPORT_SCHEMA_VERSION = 1;

export interface ReportMarket {
  marketId: string;
  status: 'Open' | 'Resolved:Yes' | 'Resolved:No' | 'Void';
  createdByTreasury: boolean;
  position: { yesRaw: string; noRaw: string };
  reserves: { yesRaw: string; noRaw: string };
  priceYesBps: number;
  markValueRaw: string;
  liquidationValueRaw: string;
  settlementValueRaw: string | null;
  lpRemainderRaw?: string;
  archived?: boolean;
}

export interface TransparencyReportV1 {
  kind: typeof REPORT_KIND;
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  network: string;
  contracts: { treasury: string; marketCore: string; usdc: string; reasoningRegistry: string };
  agent: string;
  period: { from: string; to: string };
  anchor: { ledger: number; closedAt: string };
  consistency: 'exact' | 'best_effort';
  treasury: {
    usdcBalanceRaw: string;
    availableCapitalRaw: string;
    riskConfig: { maxTradeRaw: string; maxMarketRaw: string; maxDailyRaw: string };
    dailyUsage: { amountRaw: string; dayStart: number };
  };
  markets: ReportMarket[];
  totals: { positionsMarkRaw: string; positionsLiquidationRaw: string; navRaw: string };
  period_flows: {
    coverage: { fromLedger: number; toLedger: number; complete: boolean; gaps: Array<[number, number]> };
    tradesBoughtRaw: string;
    tradesSoldRaw: string;
    feesPaidRaw: string;
    redeemedRaw: string;
    feesCollectedRaw: string;
    seedDeployedRaw: string;
    tradeCount: number;
  };
  traces: { total: number; byAction: Record<string, number> };
  method: { version: '1'; doc: string };
  previous: { onChainTraceId: string; traceHash: string } | null;
}

function statusLabel(status: OnChainMarket['status']): ReportMarket['status'] {
  if (status.tag === 'Open') return 'Open';
  if (status.tag === 'Void') return 'Void';
  return status.values[0].tag === 'Yes' ? 'Resolved:Yes' : 'Resolved:No';
}

function settlementKind(label: ReportMarket['status']): Settlement | null {
  if (label === 'Resolved:Yes') return 'yes';
  if (label === 'Resolved:No') return 'no';
  if (label === 'Void') return 'void';
  return null;
}

export function markValueRaw(yes: bigint, no: bigint, yesBps: number): string {
  const p = BigInt(yesBps);
  return ((yes * p + no * (10_000n - p)) / 10_000n).toString();
}

export function liquidationValueRaw(
  reserveYes: bigint,
  reserveNo: bigint,
  yes: bigint,
  no: bigint,
  feeBps: bigint,
): string {
  let total = 0n;
  if (yes > 0n) total += collateralOutForShares(reserveYes, reserveNo, yes, feeBps);
  if (no > 0n) total += collateralOutForShares(reserveNo, reserveYes, no, feeBps);
  return total.toString();
}

export function settlementValueRaw(label: ReportMarket['status'], yes: bigint, no: bigint): string | null {
  const kind = settlementKind(label);
  return kind ? settleValue(kind, yes, no).toString() : null;
}

export interface RawMarketSnapshot {
  marketId: bigint;
  market: OnChainMarket;
  position: Position;
  archived?: boolean;
}

/** Pure valuation step, shared by the builder and tests. */
export function valueMarket(snapshot: RawMarketSnapshot, treasuryAddress: string): ReportMarket {
  const label = statusLabel(snapshot.market.status);
  const yesBps = Number(priceYesBps(BigInt(snapshot.market.reserve_yes), BigInt(snapshot.market.reserve_no)));
  const yes = BigInt(snapshot.position.yes);
  const no = BigInt(snapshot.position.no);
  const kind = settlementKind(label);
  const lpRemainder =
    kind && !snapshot.market.lp_claimed && snapshot.market.creator === treasuryAddress
      ? settleValue(kind, BigInt(snapshot.market.reserve_yes), BigInt(snapshot.market.reserve_no)).toString()
      : undefined;
  return {
    marketId: snapshot.marketId.toString(),
    status: label,
    createdByTreasury: snapshot.market.creator === treasuryAddress,
    position: { yesRaw: yes.toString(), noRaw: no.toString() },
    reserves: { yesRaw: BigInt(snapshot.market.reserve_yes).toString(), noRaw: BigInt(snapshot.market.reserve_no).toString() },
    priceYesBps: yesBps,
    markValueRaw: markValueRaw(yes, no, yesBps),
    liquidationValueRaw: liquidationValueRaw(
      BigInt(snapshot.market.reserve_yes),
      BigInt(snapshot.market.reserve_no),
      yes,
      no,
      BigInt(snapshot.market.fee_bps),
    ),
    settlementValueRaw: settlementValueRaw(label, yes, no),
    ...(lpRemainder !== undefined ? { lpRemainderRaw: lpRemainder } : {}),
    ...(snapshot.archived ? { archived: true } : {}),
  };
}

export function totalsFor(markets: ReportMarket[], usdcBalanceRaw: string) {
  const mark = markets.reduce((sum, m) => sum + BigInt(m.markValueRaw), 0n);
  const liquidation = markets.reduce((sum, m) => sum + BigInt(m.liquidationValueRaw), 0n);
  const nav = BigInt(usdcBalanceRaw) + mark;
  return {
    positionsMarkRaw: mark.toString(),
    positionsLiquidationRaw: liquidation.toString(),
    navRaw: nav.toString(),
  };
}

export interface ReportInputs {
  date: string;
  network: string;
  contracts: TransparencyReportV1['contracts'];
  agent: string;
  anchor: { ledger: number; closedAt: string };
  consistency: 'exact' | 'best_effort';
  treasury: TransparencyReportV1['treasury'];
  markets: ReportMarket[];
  periodFlows: TransparencyReportV1['period_flows'];
  traces: TransparencyReportV1['traces'];
  previous: TransparencyReportV1['previous'];
  methodDoc: string;
}

export function buildReportDocument(input: ReportInputs): TransparencyReportV1 {
  return {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    network: input.network,
    contracts: input.contracts,
    agent: input.agent,
    period: { from: `${input.date}T00:00:00.000Z`, to: `${input.date}T23:59:59.999Z` },
    anchor: input.anchor,
    consistency: input.consistency,
    treasury: input.treasury,
    markets: input.markets,
    totals: totalsFor(input.markets, input.treasury.usdcBalanceRaw),
    period_flows: input.periodFlows,
    traces: input.traces,
    method: { version: '1', doc: input.methodDoc },
    previous: input.previous,
  };
}

export interface ReportDeps {
  now?: () => Date;
  latestLedger?: () => Promise<number>;
  marketCount?: () => Promise<bigint>;
  getMarket?: (id: bigint) => Promise<OnChainMarket>;
  getPosition?: (id: bigint, holder: string) => Promise<Position>;
  treasuryConfig?: () => Promise<{ agent: string; max_daily: bigint; max_market: bigint; max_trade: bigint }>;
  dailyUsage?: () => Promise<{ amount: bigint; day_start: bigint }>;
  availableCapital?: () => Promise<bigint>;
  traceCount?: () => Promise<bigint>;
  getTrace?: (id: bigint) => Promise<{ agent: string; action: string }>;
  chainEvents?: (from: Date, to: Date) => Promise<Array<{ contractName: string; eventName: string; ledger: number; ledgerClosedAt: Date; params: unknown }>>;
  indexerCursor?: () => Promise<number | null>;
  previousReport?: (date: string) => Promise<{ onChainTraceId: bigint | null; hash: string } | null>;
  methodDoc?: string;
  ledgerEntries?: () => Promise<Array<{ lastModifiedLedgerSeq: number }>>;
}

const SNAPSHOT_ATTEMPTS = 3;

/** Treasury instance entry's lastModifiedLedgerSeq, used for drift detection. */
async function treasuryInstanceEntries(): Promise<Array<{ lastModifiedLedgerSeq: number }>> {
  try {
    const key = (xdr.LedgerKey.contractData as any)({
      contract: new Contract(CONTRACTS.treasury).address(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    });
    const res = await rpcServer.getLedgerEntries(key);
    return (res.entries ?? []).map((entry) => ({ lastModifiedLedgerSeq: (entry as any).lastModifiedLedgerSeq ?? 0 }));
  } catch {
    return [];
  }
}

function eventParams(event: { params: unknown }): Record<string, unknown> {
  return (event.params ?? {}) as Record<string, unknown>;
}

export async function buildReportForDate(date: string, deps: ReportDeps = {}): Promise<TransparencyReportV1> {
  const getLatest = deps.latestLedger ?? (async () => (await rpcServer.getLatestLedger()).sequence);
  const count = deps.marketCount ?? marketCount;
  const market = deps.getMarket ?? getOnChainMarket;
  const position = deps.getPosition ?? getPosition;
  const risk = deps.treasuryConfig ?? treasuryConfig;
  const usage = deps.dailyUsage ?? treasuryDailyUsage;
  const available = deps.availableCapital ?? treasuryAvailableCapital;
  const entries = deps.ledgerEntries ?? treasuryInstanceEntries;
  const readTraceCount = deps.traceCount ?? (async () => (await import('./stellar/clients')).readClients.reasoningRegistry().trace_count().then((tx) => tx.result as bigint));
  const getTrace = deps.getTrace ?? (async (id: bigint) => {
    const { getOnChainTrace } = await import('./chain.service');
    return getOnChainTrace(id);
  });
  const chainEvents = deps.chainEvents ?? (async (from, to) => prisma.chainEvent.findMany({
    where: { ledgerClosedAt: { gte: from, lte: to } },
    orderBy: { ledger: 'asc' },
  }));
  const indexerCursor = deps.indexerCursor ?? (async () => {
    const cursor = await prisma.indexerCursor.findFirst({ orderBy: { updatedAt: 'desc' } });
    return cursor?.lastLedger ?? null;
  });
  const previousReport = deps.previousReport ?? (async (d) => {
    const prev = await prisma.transparencyReport.findFirst({
      where: { date: { lt: d }, onChainTraceId: { not: null } },
      orderBy: { date: 'desc' },
    });
    return prev ? { onChainTraceId: prev.onChainTraceId, hash: prev.hash } : null;
  });

  const [riskCfg, daily, capital] = await Promise.all([risk(), usage(), available()]);
  const treasuryAddress = (riskCfg as { agent: string }).agent;

  let consistency: 'exact' | 'best_effort' = 'exact';
  let anchor = 0;
  let snapshots: RawMarketSnapshot[] = [];

  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    const l0 = await getLatest();
    const touched = await entries();
    const total = await count();
    const next: RawMarketSnapshot[] = [];
    for (let i = 0n; i < total; i++) {
      try {
        const [m, p] = await Promise.all([market(i), position(i, treasuryAddress)]);
        const held = BigInt(p.yes) > 0n || BigInt(p.no) > 0n;
        if (m.creator === treasuryAddress || held) next.push({ marketId: i, market: m, position: p });
      } catch (err) {
        logger.warn({ err, marketId: i.toString() }, 'Transparency report: market read failed; skipped');
      }
    }
    const l1 = await getLatest();
    snapshots = next;
    anchor = l1;
    const modifiedDuringSnapshot = touched.some((entry) => entry.lastModifiedLedgerSeq > l0);
    if (l1 <= l0 && !modifiedDuringSnapshot) {
      consistency = 'exact';
      break;
    }
    if (attempt === SNAPSHOT_ATTEMPTS) consistency = 'best_effort';
  }

  const markets = snapshots.map((snapshot) => valueMarket(snapshot, treasuryAddress));

  const start = dayjs.utc(date).startOf('day').toDate();
  const end = dayjs.utc(date).endOf('day').toDate();
  const events = await chainEvents(start, end);
  let tradesBought = 0n;
  let tradesSold = 0n;
  let feesPaid = 0n;
  let redeemed = 0n;
  let feesCollected = 0n;
  let seedDeployed = 0n;
  let tradeCount = 0;

  for (const event of events) {
    const p = eventParams(event);
    const trader = String(p.trader ?? p.holder ?? p.creator ?? '');
    if (event.contractName === 'marketCore' && event.eventName === 'Trade' && trader === treasuryAddress) {
      tradeCount++;
      const collateral = BigInt((p.collateral as string | number | bigint | undefined) ?? 0);
      if (p.is_buy === true) tradesBought += collateral;
      else tradesSold += collateral;
      feesPaid += BigInt((p.fee as string | number | bigint | undefined) ?? 0);
    } else if (event.contractName === 'marketCore' && event.eventName === 'Redeemed' && trader === treasuryAddress) {
      redeemed += BigInt((p.amount as string | number | bigint | undefined) ?? 0);
    } else if (event.contractName === 'treasury' && event.eventName === 'FeesCollected') {
      feesCollected += BigInt((p.amount as string | number | bigint | undefined) ?? 0);
    } else if (event.contractName === 'marketCore' && event.eventName === 'MarketCreated' && trader === treasuryAddress) {
      seedDeployed += BigInt((p.seed_amount as string | number | bigint | undefined) ?? 0);
    }
  }

  const fromLedger = events.length > 0 ? events[0].ledger : anchor;
  const toLedger = events.length > 0 ? events[events.length - 1].ledger : anchor;
  const cursor = await indexerCursor();
  const complete = cursor === null ? events.length === 0 : cursor >= toLedger;
  const gaps: Array<[number, number]> = complete ? [] : [[(cursor ?? fromLedger) + 1, toLedger]];

  const totalTraces = Number(await readTraceCount());
  const byAction: Record<string, number> = {};
  let agentTraceTotal = 0;
  for (let i = 0; i < totalTraces; i++) {
    let cached = await prisma.registryTraceCache.findUnique({ where: { traceId: BigInt(i) } }).catch(() => null);
    if (!cached) {
      const trace = await getTrace(BigInt(i)).catch(() => null);
      if (trace) {
        await prisma.registryTraceCache.create({
          data: {
            traceId: BigInt(i),
            agent: (trace as { agent?: string }).agent ?? '',
            marketId: BigInt((trace as { market_id?: bigint }).market_id ?? 0n),
            action: (trace as { action?: string }).action ?? '',
            traceHash: Buffer.from((trace as { trace_hash?: Buffer }).trace_hash ?? Buffer.alloc(0)).toString('hex'),
            ipfsCid: (trace as { ipfs_cid?: string }).ipfs_cid ?? '',
            publishedAt: BigInt((trace as { published_at?: bigint }).published_at ?? 0n),
          },
        }).catch(() => undefined);
        cached = await prisma.registryTraceCache.findUnique({ where: { traceId: BigInt(i) } }).catch(() => null);
      }
    }
    if (cached && cached.agent === treasuryAddress) {
      agentTraceTotal++;
      byAction[cached.action] = (byAction[cached.action] ?? 0) + 1;
    }
  }

  const previousRow = await previousReport(date);
  const methodDoc = deps.methodDoc ?? process.env.REPORT_METHOD_DOC ?? 'https://github.com/OracleDesk/oracledesk-backend/blob/main/docs/transparency-reports.md';

  return buildReportDocument({
    date,
    network: config.STELLAR_NETWORK_PASSPHRASE,
    contracts: {
      treasury: CONTRACTS.treasury,
      marketCore: CONTRACTS.marketCore,
      usdc: CONTRACTS.usdc,
      reasoningRegistry: CONTRACTS.reasoningRegistry,
    },
    agent: treasuryAddress,
    anchor: { ledger: anchor, closedAt: new Date().toISOString() },
    consistency,
    treasury: {
      usdcBalanceRaw: capital.toString(),
      availableCapitalRaw: capital.toString(),
      riskConfig: {
        maxTradeRaw: BigInt((riskCfg as { max_trade: bigint }).max_trade).toString(),
        maxMarketRaw: BigInt((riskCfg as { max_market: bigint }).max_market).toString(),
        maxDailyRaw: BigInt((riskCfg as { max_daily: bigint }).max_daily).toString(),
      },
      dailyUsage: { amountRaw: BigInt((daily as { amount: bigint }).amount).toString(), dayStart: Number((daily as { day_start: bigint }).day_start) },
    },
    markets,
    periodFlows: {
      coverage: { fromLedger, toLedger, complete, gaps },
      tradesBoughtRaw: tradesBought.toString(),
      tradesSoldRaw: tradesSold.toString(),
      feesPaidRaw: feesPaid.toString(),
      redeemedRaw: redeemed.toString(),
      feesCollectedRaw: feesCollected.toString(),
      seedDeployedRaw: seedDeployed.toString(),
      tradeCount,
    },
    traces: { total: agentTraceTotal, byAction },
    previous: previousRow && previousRow.onChainTraceId !== null
      ? { onChainTraceId: previousRow.onChainTraceId.toString(), traceHash: previousRow.hash }
      : null,
    methodDoc,
  });
}

/** Daily job: build → pin → publish → persist. Re-publishes stored bytes after a crash. */
export async function runReportJob(date = dayjs.utc().format('YYYY-MM-DD'), deps: ReportDeps = {}) {
  const existing = await prisma.transparencyReport.findUnique({ where: { date } });
  if (existing) {
    if (existing.onChainTraceId !== null) return existing;
    // Crash between pin and publish (or a dry run that is being retried):
    // re-publish the stored bytes, never recompute.
    const published = await publishPinnedDocument({
      cid: existing.cid,
      hash: existing.hash,
      action: 'report',
      marketId: REPORT_MARKET_ID,
    }, { dryRun: config.REPORT_MODE === 'dry-run' });
    if (published.onChainTraceId === null) return existing;
    return prisma.transparencyReport.update({
      where: { id: existing.id },
      data: {
        onChainTraceId: published.onChainTraceId,
        mode: published.mode,
      },
    });
  }

  const report = await buildReportForDate(date, deps);
  const published = await pinAndPublishDocument({
    document: report,
    name: `oracledesk-report-${date}`,
    action: 'report',
    marketId: REPORT_MARKET_ID,
  }, { dryRun: config.REPORT_MODE === 'dry-run' });

  return prisma.transparencyReport.create({
    data: {
      date,
      anchorLedger: report.anchor.ledger,
      cid: published.cid,
      hash: published.hash,
      onChainTraceId: published.onChainTraceId,
      mode: published.mode,
      consistency: report.consistency,
      report: report as unknown as object,
    },
  });
}

export function reportAgent(): string {
  return agentSigner().publicKey as string;
}
