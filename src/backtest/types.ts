import type { TraderParams } from '../agents/trader-policy';

/** A stored market-core event: the columns of chain_events the backtester reads. */
export interface HistoryEvent {
  id: string;
  eventName: 'MarketCreated' | 'Trade' | 'MarketResolved' | string;
  ledger: number;
  /** ISO timestamp. */
  ledgerClosedAt: string;
  /** Decoded params; bigints as decimal strings. */
  params: Record<string, any>;
}

/** A signal_cache row: one source's payload at the time it was fetched. */
export interface SignalRecord {
  source: string;
  fetchedAt: string;
  payload: Array<Record<string, any>>;
}

/** A forecast the live agent stored in reasoning_traces.probabilityEstimate. */
export interface RecordedForecast {
  /** On-chain market id, as a decimal string. */
  marketId: string;
  at: string;
  p: number;
  ci?: { lower: number; upper: number };
}

export interface BacktestInputs {
  events: HistoryEvent[];
  signals: SignalRecord[];
  forecasts: RecordedForecast[];
}

export type ImpactMode = 'reset' | 'propagate';

export interface BacktestConfig {
  /** ISO timestamps (UTC). */
  from: string;
  to: string;
  stepMinutes: number;
  bankrollRaw: bigint;
  maxTradeRaw: bigint;
  maxMarketRaw: bigint;
  maxDailyRaw: bigint;
  forecaster: string;
  seed: number;
  /** Pool fee; inferred from the first historical buy when omitted. */
  feeBps?: number;
  params: TraderParams;
}

export interface TradeRecord {
  positionId: string;
  marketId: string;
  kind: 'trade' | 'hedge';
  direction: 'YES' | 'NO';
  at: string;
  collateralRaw: string;
  sharesRaw: string;
  feeRaw: string;
  midBps: number;
  /** collateral − shares × mid: what the fill cost beyond the mid price (fee included). */
  impactCostRaw: string;
  edge: number;
  kelly: number;
}

export interface PositionSummary {
  positionId: string;
  marketId: string;
  direction: 'YES' | 'NO';
  collateralRaw: string;
  payoutRaw: string;
  pnlRaw: string;
  closeReason: string;
  closedAt: string;
}

export interface RunReport {
  impact: ImpactMode;
  summary: {
    startEquityRaw: string;
    endEquityRaw: string;
    pnlRaw: string;
    returnPct: number;
    maxDrawdownRaw: string;
    maxDrawdownPct: number;
    sharpeLike: number | null;
    turnoverRaw: string;
    turnoverMultiple: number;
    buys: number;
    hedges: number;
    closedPositions: number;
    openAtEnd: number;
    winRate: number | null;
    stopLossCount: number;
    drawdownPauses: number;
    capHits: Record<string, number>;
    avgEdgeAtEntry: number | null;
    avgForecastEdgeResolved: number | null;
    avgRealisedEdgeResolved: number | null;
    impactCostRaw: string;
    externalTradesSkipped: number;
  };
  equityCurve: Array<{ t: string; equityRaw: string }>;
  perMarket: Array<{ marketId: string; trades: number; pnlRaw: string; impactCostRaw: string }>;
  trades: TradeRecord[];
  closed: PositionSummary[];
}

export interface BacktestReport {
  version: 1;
  configHash: string;
  inputsHash: string;
  config: Record<string, unknown>;
  runs: Partial<Record<ImpactMode, RunReport>>;
}
