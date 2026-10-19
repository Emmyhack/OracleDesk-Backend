/**
 * Replays stored market-core history through the trader policy (#81).
 *
 * A simulated clock steps through the range at the cron cadence. Between
 * steps every event with ledgerClosedAt ≤ now is applied in order (markets
 * appear, external trades move pools, resolutions settle positions), then the
 * real policy (runTraderPolicy) runs against a BacktestEnv built only from
 * that replayed state. Agent orders fill against the simulated pool with the
 * contract's math and spend through a SimTreasury that enforces the risk caps.
 *
 * Nothing here reads the database or the wall clock: the same inputs, config
 * and seed give the same report.
 */
import { DEFAULT_PARAMS, runTraderPolicy, type TraderParams } from '../agents/trader-policy';
import type {
  BuyOrder, Clock, DecisionRecord, ExecResult, Forecast, MarketView, PositionView, TraderEnv,
} from '../agents/trader-env';
import { MathError } from '../generated/fpmm';
import { toDisplayUsdc, usdcFromNumber } from '../lib/amounts';
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import { evaluateStopLoss, planHedges } from '../services/hedging.service';
import { evaluateCorrelation } from '../services/correlation.service';
import type { AggregatedSignals, HedgeRecommendation } from '../types';
import { parseForecaster, type Forecaster } from './forecasters';
import { SimError, SimPool, settlePosition, type Outcome } from './sim-pool';
import { SimTreasury } from './sim-treasury';
import type { MarketExposure, TreasuryBudget } from '../services/treasury-budget.service';
import type {
  BacktestConfig, BacktestInputs, BacktestReport, HistoryEvent, ImpactMode, PositionSummary, RunReport, TradeRecord,
} from './types';

const BPS = 10_000n;
const DEFAULT_FEE_BPS = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PolicyFn = (env: TraderEnv, params: TraderParams, opts?: { signal?: AbortSignal }) => Promise<void>;

export interface RunOptions {
  /** Replaces the trader policy (tests drive scripted behaviour through it). */
  policy?: PolicyFn;
  /** Called on every env read with the newest event the replay has applied. */
  observe?: (info: { method: string; now: Date; latestEventAt: Date | null }) => void;
}

const outcomeTag = (o: unknown): string | null =>
  typeof o === 'string' ? o : o && typeof o === 'object' && 'tag' in o ? String((o as { tag: unknown }).tag) : null;

/** Contract categories carry less than the backend's; this is the closest backend category. */
const BACKEND_CATEGORY: Record<string, string> = {
  Crypto: 'CRYPTO', Macro: 'MACRO', Geopolitics: 'GEOPOLITICAL', Sports: 'SPORTS', Culture: 'ENTERTAINMENT', Other: 'MACRO',
};

interface SimMarket {
  id: string;
  category: string;
  pool: SimPool;
  closeTime: number;
  initialYesProb: number;
  outcome: 'Yes' | 'No' | 'Void' | null;
}

interface SimPosition {
  id: string;
  marketId: string;
  kind: 'trade' | 'hedge';
  direction: 'YES' | 'NO';
  shares: bigint;
  collateralRaw: bigint;
  entryMid: number;
  edge: number;
  kelly: number;
  status: 'OPEN' | 'CLOSED';
  payoutRaw: bigint;
  closeReason?: string;
  closedAt?: Date;
}

const sideOf = (d: 'YES' | 'NO'): Outcome => (d === 'YES' ? 'Yes' : 'No');
const eventTime = (e: HistoryEvent) => new Date(e.ledgerClosedAt).getTime();

export function sortEvents(events: HistoryEvent[]): HistoryEvent[] {
  return [...events].sort((a, b) => eventTime(a) - eventTime(b) || a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** feeBps from the first historical buy: fee = ceil(collateral × feeBps / 10 000). */
export function inferFeeBps(events: HistoryEvent[]): number {
  for (const e of events) {
    if (e.eventName !== 'Trade' || !e.params.is_buy) continue;
    const collateral = BigInt(e.params.collateral);
    const fee = BigInt(e.params.fee);
    if (collateral > 0n) return Number((fee * BPS) / collateral);
  }
  return DEFAULT_FEE_BPS;
}

class Replay {
  readonly markets = new Map<string, SimMarket>();
  readonly positions: SimPosition[] = [];
  readonly treasury: SimTreasury;
  readonly trades: TradeRecord[] = [];
  readonly capHits: Record<string, number> = {
    TradeCapExceeded: 0, MarketCapExceeded: 0, DailyCapExceeded: 0, InsufficientBalance: 0, InvalidAmount: 0, MarketClosed: 0, PoolError: 0,
  };
  readonly outcomes = new Map<string, 'Yes' | 'No' | 'Void'>();
  readonly hedged = new Set<string>();
  turnoverRaw = 0n;
  stopLossCount = 0;
  drawdownPauses = 0;
  externalTradesSkipped = 0;
  latestEventAt: Date | null = null;
  now: Date;
  private cursor = 0;
  private nextId = 1;

  constructor(
    readonly events: HistoryEvent[],
    readonly cfg: BacktestConfig,
    readonly impact: ImpactMode,
    readonly feeBps: number,
  ) {
    this.treasury = new SimTreasury({ cash: cfg.bankrollRaw, maxTrade: cfg.maxTradeRaw, maxMarket: cfg.maxMarketRaw, maxDaily: cfg.maxDailyRaw });
    this.now = new Date(cfg.from);
    // What each market resolves to: read only by the oracle-noise forecaster.
    for (const e of events) {
      if (e.eventName === 'MarketResolved') this.outcomes.set(String(e.params.market_id), (outcomeTag(e.params.outcome) as 'Yes' | 'No' | null) ?? 'Void');
    }
  }

  get nowSecs(): number {
    return Math.floor(this.now.getTime() / 1000);
  }

  /** Applies every not-yet-applied event with ledgerClosedAt ≤ now. */
  advance(now: Date): void {
    this.now = now;
    while (this.cursor < this.events.length && eventTime(this.events[this.cursor]) <= now.getTime()) {
      const event = this.events[this.cursor++];
      this.apply(event);
      this.latestEventAt = new Date(eventTime(event));
    }
  }

  private apply(e: HistoryEvent): void {
    const p = e.params;
    const id = String(p.market_id);

    if (e.eventName === 'MarketCreated') {
      if (this.markets.has(id)) return;
      try {
        const pool = SimPool.seeded(BigInt(p.seed_amount), Number(p.initial_yes_bps), this.feeBps, Number(p.close_time));
        this.markets.set(id, {
          id, pool, closeTime: Number(p.close_time), initialYesProb: Number(p.initial_yes_bps) / 10_000,
          category: BACKEND_CATEGORY[outcomeTag(p.category) ?? 'Other'] ?? 'MACRO', outcome: null,
        });
      } catch (err) {
        if (!(err instanceof MathError)) throw err;
      }
      return;
    }

    const market = this.markets.get(id);
    if (!market) return;

    if (e.eventName === 'Trade') {
      if (market.pool.status !== 'open') return;
      if (this.impact === 'reset') {
        // Optimistic upper bound: the agent's impact vanishes at the next external trade.
        market.pool.setReserves(BigInt(p.reserve_yes), BigInt(p.reserve_no));
      } else if (!market.pool.applyExternalTrade(outcomeTag(p.outcome) === 'No' ? 'No' : 'Yes', Boolean(p.is_buy), BigInt(p.collateral))) {
        this.externalTradesSkipped++;
      }
      return;
    }

    if (e.eventName === 'MarketResolved') {
      const outcome = outcomeTag(p.outcome) as 'Yes' | 'No' | null; // null: voided
      market.pool.resolve(outcome);
      market.outcome = outcome ?? 'Void';
      const kind = outcome === null ? 'void' : outcome === 'Yes' ? 'yes' : 'no';
      const at = new Date(eventTime(e));
      for (const pos of this.positions) {
        if (pos.marketId !== id || pos.status !== 'OPEN') continue;
        const payout = settlePosition(kind, sideOf(pos.direction), pos.shares);
        this.treasury.credit(payout);
        this.close(pos, payout, outcome === null ? 'VOIDED' : `${outcome.toUpperCase()}_RESOLVED`, at);
      }
    }
  }

  private close(pos: SimPosition, payout: bigint, reason: string, at: Date): void {
    pos.status = 'CLOSED';
    pos.payoutRaw = payout;
    pos.closeReason = reason;
    pos.closedAt = at;
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  buy(marketId: string, direction: 'YES' | 'NO', amount: number, edge: number, kelly: number, kind: 'trade' | 'hedge'): ExecResult {
    const market = this.markets.get(marketId);
    if (!market) return { ok: false, reason: 'MarketNotFound' };
    // The policy works in floats; the simulation in base units. This is the only conversion.
    const collateral = usdcFromNumber(amount);
    const outcome = sideOf(direction);
    const midBps = market.pool.priceBps(outcome);

    let fill;
    try {
      fill = market.pool.quoteBuy(outcome, collateral, this.nowSecs);
    } catch (err) {
      if (err instanceof SimError) {
        this.capHits[err.code === 'MarketClosed' ? 'MarketClosed' : 'PoolError']++;
        return { ok: false, reason: err.code };
      }
      if (err instanceof MathError) { this.capHits.PoolError++; return { ok: false, reason: 'PoolError' }; }
      throw err;
    }

    const capError = this.treasury.reserve(marketId, collateral, this.nowSecs);
    if (capError) {
      this.capHits[capError]++;
      return { ok: false, reason: capError };
    }
    market.pool.commit(fill);

    const pos: SimPosition = {
      id: `pos-${this.nextId++}`, marketId, kind, direction, shares: fill.sharesOut, collateralRaw: collateral,
      entryMid: midBps / 10_000, edge, kelly, status: 'OPEN', payoutRaw: 0n,
    };
    this.positions.push(pos);
    this.turnoverRaw += collateral;
    this.trades.push({
      positionId: pos.id, marketId, kind, direction, at: this.now.toISOString(),
      collateralRaw: collateral.toString(), sharesRaw: fill.sharesOut.toString(), feeRaw: fill.fee.toString(), midBps,
      impactCostRaw: (collateral - (fill.sharesOut * BigInt(midBps)) / BPS).toString(), edge, kelly,
    });
    return { ok: true };
  }

  exit(positionId: string, reason: string): ExecResult {
    const pos = this.positions.find((p) => p.id === positionId && p.status === 'OPEN');
    const market = pos && this.markets.get(pos.marketId);
    if (!pos || !market) return { ok: false, reason: 'PositionNotFound' };
    try {
      // agent_sell is not capped.
      const { collateralOut } = market.pool.agentSell(sideOf(pos.direction), pos.shares, this.nowSecs);
      this.treasury.credit(collateralOut);
      this.turnoverRaw += collateralOut;
      this.close(pos, collateralOut, reason, this.now);
      if (reason === 'STOP_LOSS') this.stopLossCount++;
      return { ok: true };
    } catch (err) {
      if (err instanceof SimError || err instanceof MathError) return { ok: false, reason: err instanceof SimError ? err.code : 'PoolError' };
      throw err;
    }
  }

  // ─── Valuation ───────────────────────────────────────────────────────────

  positionValue(pos: SimPosition): bigint {
    if (pos.status === 'CLOSED') return pos.payoutRaw;
    const market = this.markets.get(pos.marketId)!;
    return market.pool.liquidationValue(sideOf(pos.direction), pos.shares);
  }

  equityRaw(): bigint {
    let equity = this.treasury.cash;
    for (const pos of this.positions) if (pos.status === 'OPEN') equity += this.positionValue(pos);
    return equity;
  }

  midPrice(pos: SimPosition): number {
    return this.markets.get(pos.marketId)!.pool.priceBps(sideOf(pos.direction)) / 10_000;
  }
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The policy's window onto the replay. Every read is built from state the
 * replay has applied up to the simulated clock; nothing consults the
 * database or the wall clock. The clock is explicitly UTC (production's
 * drawdown check uses local midnight).
 */
class BacktestEnv implements TraderEnv {
  readonly clock: Clock;

  constructor(
    private readonly r: Replay,
    private readonly inputs: BacktestInputs,
    private readonly forecaster: Forecaster,
    private readonly observe: RunOptions['observe'],
  ) {
    this.clock = { now: () => new Date(r.now), startOfDay: () => utcMidnight(r.now) };
  }

  private seen(method: string): void {
    this.observe?.({ method, now: new Date(this.r.now), latestEventAt: this.r.latestEventAt });
  }

  private view(pos: SimPosition): PositionView {
    const mid = this.r.midPrice(pos);
    return {
      id: pos.id, marketId: pos.marketId, category: this.r.markets.get(pos.marketId)?.category, direction: pos.direction,
      entryPrice: pos.entryMid, currentPrice: mid, size: toDisplayUsdc(pos.collateralRaw),
      pnl: (mid - pos.entryMid) * toDisplayUsdc(pos.collateralRaw),
    };
  }

  private open(): SimPosition[] {
    return this.r.positions.filter((p) => p.status === 'OPEN');
  }

  private tradable(m: SimMarket): boolean {
    return m.pool.status === 'open' && this.r.nowSecs < m.closeTime;
  }

  private liquidity(m: SimMarket): number {
    return toDisplayUsdc(m.pool.reserveYes + m.pool.reserveNo);
  }

  private marketView(m: SimMarket): MarketView {
    return {
      id: m.id, category: m.category, currentYesProb: m.pool.priceYesBps() / 10_000, initialYesProb: m.initialYesProb,
      totalLiquidity: this.liquidity(m), expiryTimestamp: new Date(m.closeTime * 1000),
    };
  }

  /** The simulated treasury's views, as production reads them from the chain (#76). */
  async budget(): Promise<TreasuryBudget> {
    this.seen('budget');
    const t = this.r.treasury;
    const usage = t.rolledDailyUsage(this.r.nowSecs);
    const remaining = t.maxDaily - usage.amount;
    return {
      availableRaw: t.cash,
      maxTradeRaw: t.maxTrade,
      maxMarketRaw: t.maxMarket,
      maxDailyRaw: t.maxDaily,
      dailyUsedRaw: usage.amount,
      dailyRemainingRaw: remaining > 0n ? remaining : 0n,
      dailyWindowStart: new Date(usage.dayStart * 1000),
      dailyResetsAt: new Date((usage.dayStart + 86_400) * 1000),
      readAt: new Date(this.r.now),
    };
  }

  async marketExposure(marketId: string): Promise<MarketExposure> {
    this.seen('marketExposure');
    return { totalRaw: this.r.treasury.marketTotals.get(marketId) ?? 0n, estimated: false };
  }

  async openPositions() {
    this.seen('openPositions');
    return this.open().map((p) => this.view(p));
  }

  async hasOpenPosition(marketId: string) {
    this.seen('hasOpenPosition');
    return this.open().some((p) => p.marketId === marketId);
  }

  async candidateMarkets(now: Date, filter: { minLiquidity: number; horizonDays: number }) {
    this.seen('candidateMarkets');
    const horizon = now.getTime() + filter.horizonDays * DAY_MS;
    return [...this.r.markets.values()]
      .filter((m) => this.tradable(m) && m.closeTime * 1000 > now.getTime() && m.closeTime * 1000 <= horizon && this.liquidity(m) >= filter.minLiquidity)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((m) => this.marketView(m));
  }

  async signals(now: Date): Promise<AggregatedSignals> {
    this.seen('signals');
    // The newest payload per source that had been fetched by `now`.
    const latest = new Map<string, Array<Record<string, any>>>();
    for (const rec of [...this.inputs.signals].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
      if (new Date(rec.fetchedAt).getTime() <= now.getTime()) latest.set(rec.source, rec.payload);
    }
    const news = (latest.get('NEWSAPI') ?? []) as AggregatedSignals['news'];
    const fed = (latest.get('FRED') ?? []) as AggregatedSignals['fed'];
    const macro = (latest.get('GDELT') ?? []) as AggregatedSignals['macro'];
    return { news, fed, macro, aggregatedAt: now, signalCount: news.length + fed.length + macro.length };
  }

  async closedPnlSince(t: Date) {
    this.seen('closedPnlSince');
    return this.r.positions
      .filter((p) => p.status === 'CLOSED' && p.closedAt && p.closedAt.getTime() >= t.getTime())
      .map((p) => toDisplayUsdc(p.payoutRaw - p.collateralRaw));
  }

  async forecast(m: MarketView): Promise<Forecast | null> {
    this.seen('forecast');
    const f = this.forecaster({
      marketId: m.id, initialYesProb: m.initialYesProb, now: new Date(this.r.now), outcome: this.r.outcomes.get(m.id) ?? null,
    });
    return f ? { p: f.p, ci: f.ci, sources: [] } : null;
  }

  async stopLoss(position: PositionView) {
    this.seen('stopLoss');
    return evaluateStopLoss(position);
  }

  async correlation(marketId: string, size: number, direction: 'YES' | 'NO', bankroll: number) {
    this.seen('correlation');
    const market = this.r.markets.get(marketId);
    return evaluateCorrelation({
      proposed: { marketId, category: market?.category ?? 'MACRO', direction },
      proposedSize: size,
      bankroll,
      positions: this.open().map((p) => ({
        marketId: p.marketId, category: this.r.markets.get(p.marketId)?.category ?? 'MACRO', direction: p.direction, size: toDisplayUsdc(p.collateralRaw),
      })),
      snapshot: null, // the category matrix: no empirical snapshots in a replay
    });
  }

  async hedges(): Promise<HedgeRecommendation[]> {
    this.seen('hedges');
    const recs = await planHedges(
      this.open().map((p) => {
        const v = this.view(p);
        return {
          marketId: p.marketId, category: this.r.markets.get(p.marketId)?.category ?? 'MACRO', direction: p.direction,
          entryPrice: v.entryPrice, currentPrice: v.currentPrice, size: v.size, pnl: v.pnl, edgeDetected: p.edge,
        };
      }),
      async (category, excludeId) => {
        const pick = [...this.r.markets.values()]
          .filter((m) => m.category === category && m.id !== excludeId && this.tradable(m) && this.liquidity(m) >= 500)
          .sort((a, b) => this.liquidity(b) - this.liquidity(a) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
        return pick ?? null;
      },
    );
    // One hedge per pair: production records a PENDING hedge each cycle; here each costs real capital.
    return recs.filter((rec) => !this.r.hedged.has(`${rec.originalMarketId}|${rec.hedgeMarketId}`));
  }

  async hedge(rec: HedgeRecommendation) {
    this.seen('hedge');
    this.r.hedged.add(`${rec.originalMarketId}|${rec.hedgeMarketId}`);
    // Unlike production's autoHedge (which only records a PENDING trade), the replay executes the hedge so the rule's effect shows up.
    const res = this.r.buy(rec.hedgeMarketId, rec.hedgeDirection, rec.hedgeSize, 0, 0, 'hedge');
    if (!res.ok) throw new Error(`hedge refused: ${res.reason}`);
  }

  async buy(order: BuyOrder) {
    this.seen('buy');
    return this.r.buy(order.marketId, order.direction, order.amount, order.edge, order.kelly, 'trade');
  }

  async exit(positionId: string, reason: string) {
    this.seen('exit');
    return this.r.exit(positionId, reason);
  }

  async recordDecision(d: DecisionRecord) {
    if (d.kind === 'DRAWDOWN_PAUSE') this.r.drawdownPauses++;
  }
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function sharpeLike(curve: Array<{ t: Date; equity: bigint }>): number | null {
  // Last equity of each UTC day → daily returns → annualised mean/stdev.
  const byDay = new Map<number, bigint>();
  for (const pt of curve) byDay.set(utcMidnight(pt.t).getTime(), pt.equity);
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => Number(v));
  if (days.length < 3) return null;
  const returns = days.slice(1).map((v, i) => (days[i] > 0 ? (v - days[i]) / days[i] : 0));
  const m = mean(returns)!;
  const sd = Math.sqrt(returns.reduce((s, x) => s + (x - m) ** 2, 0) / (returns.length - 1));
  return sd === 0 ? null : (m / sd) * Math.sqrt(365);
}

function buildReport(r: Replay, impact: ImpactMode, curve: Array<{ t: Date; equity: bigint }>, startEquity: bigint): RunReport {
  const endEquity = curve.length ? curve[curve.length - 1].equity : startEquity;

  let peak = startEquity;
  let maxDd = 0n;
  let maxDdPct = 0;
  for (const pt of curve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0n ? Number((dd * 1_000_000n) / peak) / 10_000 : 0; }
  }

  const closed = r.positions.filter((p) => p.status === 'CLOSED');
  const wins = closed.filter((p) => p.payoutRaw > p.collateralRaw).length;
  const resolved = closed.filter((p) => p.closeReason?.endsWith('_RESOLVED') && p.kind === 'trade');
  const entries = r.trades.filter((t) => t.kind === 'trade');
  const impactCost = r.trades.reduce((s, t) => s + BigInt(t.impactCostRaw), 0n);

  const perMarket = new Map<string, { trades: number; pnl: bigint; impact: bigint }>();
  for (const pos of r.positions) {
    const row = perMarket.get(pos.marketId) ?? { trades: 0, pnl: 0n, impact: 0n };
    row.trades++;
    row.pnl += r.positionValue(pos) - pos.collateralRaw;
    perMarket.set(pos.marketId, row);
  }
  for (const t of r.trades) perMarket.get(t.marketId)!.impact += BigInt(t.impactCostRaw);

  const summarize = (p: SimPosition): PositionSummary => ({
    positionId: p.id, marketId: p.marketId, direction: p.direction, collateralRaw: p.collateralRaw.toString(),
    payoutRaw: p.payoutRaw.toString(), pnlRaw: (p.payoutRaw - p.collateralRaw).toString(), closeReason: p.closeReason ?? '', closedAt: p.closedAt!.toISOString(),
  });

  return {
    impact,
    summary: {
      startEquityRaw: startEquity.toString(),
      endEquityRaw: endEquity.toString(),
      pnlRaw: (endEquity - startEquity).toString(),
      returnPct: startEquity > 0n ? Number(((endEquity - startEquity) * 1_000_000n) / startEquity) / 10_000 : 0,
      maxDrawdownRaw: maxDd.toString(),
      maxDrawdownPct: maxDdPct,
      sharpeLike: sharpeLike(curve),
      turnoverRaw: r.turnoverRaw.toString(),
      turnoverMultiple: startEquity > 0n ? Number((r.turnoverRaw * 10_000n) / startEquity) / 10_000 : 0,
      buys: entries.length,
      hedges: r.trades.length - entries.length,
      closedPositions: closed.length,
      openAtEnd: r.positions.length - closed.length,
      winRate: closed.length ? wins / closed.length : null,
      stopLossCount: r.stopLossCount,
      drawdownPauses: r.drawdownPauses,
      capHits: { ...r.capHits },
      avgEdgeAtEntry: mean(entries.map((t) => Math.abs(t.edge))),
      avgForecastEdgeResolved: mean(resolved.map((p) => Math.abs(p.edge))),
      avgRealisedEdgeResolved: mean(resolved.map((p) => Number((p.payoutRaw * 10_000n) / (p.shares || 1n)) / 10_000 - p.entryMid)),
      impactCostRaw: impactCost.toString(),
      externalTradesSkipped: r.externalTradesSkipped,
    },
    equityCurve: curve.map((pt) => ({ t: pt.t.toISOString(), equityRaw: pt.equity.toString() })),
    perMarket: [...perMarket.entries()]
      .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))
      .map(([marketId, v]) => ({ marketId, trades: v.trades, pnlRaw: v.pnl.toString(), impactCostRaw: v.impact.toString() })),
    trades: r.trades,
    closed: closed.map(summarize),
  };
}

export function runOnce(inputs: BacktestInputs, cfg: BacktestConfig, impact: ImpactMode, opts: RunOptions = {}): Promise<RunReport> {
  return (async () => {
    const events = sortEvents(inputs.events);
    const feeBps = cfg.feeBps ?? inferFeeBps(events);
    const replay = new Replay(events, cfg, impact, feeBps);
    const forecaster = parseForecaster(cfg.forecaster, cfg.seed, inputs.forecasts);
    const env = new BacktestEnv(replay, inputs, forecaster, opts.observe);
    const policy = opts.policy ?? runTraderPolicy;

    const stepMs = cfg.stepMinutes * 60_000;
    const start = new Date(cfg.from).getTime();
    const end = new Date(cfg.to).getTime();
    const curve: Array<{ t: Date; equity: bigint }> = [];

    for (let t = start; t <= end; t += stepMs) {
      replay.advance(new Date(t));
      await policy(env, cfg.params);
      curve.push({ t: new Date(t), equity: replay.equityRaw() });
    }
    return buildReport(replay, impact, curve, cfg.bankrollRaw);
  })();
}

/** The canonical echo of a config, used for its hash and the report header. */
export function configEcho(cfg: BacktestConfig, feeBps: number): Record<string, unknown> {
  return {
    from: cfg.from, to: cfg.to, stepMinutes: cfg.stepMinutes, bankrollRaw: cfg.bankrollRaw, maxTradeRaw: cfg.maxTradeRaw,
    maxMarketRaw: cfg.maxMarketRaw, maxDailyRaw: cfg.maxDailyRaw, forecaster: cfg.forecaster, seed: cfg.seed, feeBps, params: cfg.params,
  };
}

export async function runBacktest(
  inputs: BacktestInputs,
  cfg: BacktestConfig,
  opts: RunOptions & { impacts?: ImpactMode[] } = {},
): Promise<BacktestReport> {
  const sorted = { ...inputs, events: sortEvents(inputs.events) };
  const feeBps = cfg.feeBps ?? inferFeeBps(sorted.events);
  const config = configEcho(cfg, feeBps);
  const runs: BacktestReport['runs'] = {};
  for (const impact of opts.impacts ?? ['reset', 'propagate']) {
    runs[impact] = await runOnce(sorted, { ...cfg, feeBps }, impact, opts);
  }
  return {
    version: 1,
    configHash: sha256Hex(canonicalJson(config)),
    inputsHash: sha256Hex(canonicalJson(sorted)),
    config,
    runs,
  };
}

export { DEFAULT_PARAMS };
