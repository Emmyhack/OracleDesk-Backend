import type { 
  Market, Trade, Position, ReasoningTrace, 
  AgentType, TradeDirection, MarketCategory,
  SettlementCurrency 
} from '@prisma/client';

// ─── Re-export Prisma types ───
export type { Market, Trade, Position, ReasoningTrace };

// ─── Enum types ───
export enum JobStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}


import type { SanitizedSignal } from '../services/llm-guard.service';

// ─── Signal types (from ingestion) ───
export interface RawSignal {
  source: string;
  title: string;
  content: string;
  publishedAt: string;
  relevanceScore: number;
  category: string;
}

export interface WeightedSignal extends Record<string, unknown> {
  source: string;
  weight: number;
  signal: string;
  rawValue?: number;
  /** Signal-store row the evidence came from (#73). Absent on traces written before it. */
  signalId?: string;
  url?: string;
  publisher?: string | null;
  publishedAt?: string;
}

/** One cluster representative from the signal store (#73). */
export interface AggregatedSignal extends SanitizedSignal {
  /** signals.id; stable, unlike `id`, which the prompt builder reassigns (n1, f1…). */
  signalId: string;
  publisher: string | null;
  /** Distinct signals (outlets) in the near-duplicate cluster. */
  clusterSize: number;
}

export interface AggregatedSignals {
  news: AggregatedSignal[];
  fed: AggregatedSignal[];
  macro: AggregatedSignal[];
  aggregatedAt: Date;
  signalCount: number;
}

// ─── Market generation types ───
export interface MarketProposal {
  market_question: string;
  initial_yes_probability: number;
  resolution_oracle: string;
  expiry_timestamp: number;
  settlement_currency: SettlementCurrency;
  minimum_liquidity_usdc: number;
  category: MarketCategory;
  confidence_interval: ConfidenceInterval;
  reasoning: string;
  /** Ids of the signals the question was grounded in (#70); not persisted. */
  grounding_signal_ids: string[];
  /** Optional structured price fields for Reflector-priced CRYPTO markets (#90). */
  price_asset?: string;
  price_threshold?: string;
  price_direction?: 'Above' | 'AtOrAbove' | 'Below' | 'AtOrBelow';
  price_close_timestamp?: number;
}

// ─── Probability types ───
export interface ConfidenceInterval extends Record<string, number> {
  lower: number;
  upper: number;
}

export interface ProbabilityEstimate {
  probability: number;
  confidenceInterval: ConfidenceInterval;
  sources: WeightedSignal[];
  computedAt: Date;
}

// ─── Forecast types (#75) ───

/**
 * What a forecaster may see. It deliberately has no price fields: no current
 * or initial YES probability and no creator confidence interval, so no model
 * can anchor on the number it is supposed to disagree with.
 */
export interface ForecastInput {
  marketId: string;
  question: string;
  category: MarketCategory | string;
  closeTime: Date;
  resolutionSource: string | null;
  /** The pinned question document, only after its hash verified; fields whitelisted. */
  questionDoc: Record<string, unknown> | null;
  signals: Array<{ id?: string; source: string; title: string; publishedAt: string }>;
  now: Date;
}

export interface ModelForecast {
  model: string;
  /** Probability of YES, clamped to [0.02, 0.98]. */
  p: number;
  /** Standard deviation of p (probability units), floored at 0.05. */
  sigma: number;
  rationale: string;
  /** sha256 of exactly what the model saw (inputs and, for an LLM, the prompt). */
  inputsDigest: string;
  /** Model-specific detail recorded in the trace (base rate, adjustments, samples…). */
  detail?: Record<string, unknown>;
}

export interface EnsembleForecast {
  p: number;
  /** 90% interval. */
  ci: ConfidenceInterval;
  /** Log-odds standard deviation of the combined estimate, before shrinkage. */
  sigmaLogit: number;
  shrink: number;
  members: Array<ModelForecast & { weight: number }>;
  /** sha256 of the ForecastInput (the cache key's input half). */
  inputsDigest: string;
}

export interface Forecaster {
  name: string;
  forecast(input: ForecastInput): Promise<ModelForecast | null>;
}

// ─── Trade types ───
export interface KellyResult {
  fraction: number;        // f* = (bp - q) / b
  halfKelly: number;       // 0.5 * f*
  betSize: number;         // halfKelly * bankroll
  edge: number;            // p_agent - p_market
  odds: number;            // b (net odds)
}

export interface TradePayload {
  marketId: string;
  direction: TradeDirection;
  /** Display USDC; amountRaw is authoritative when present. */
  amount: number;
  /** Collateral in base units (#76). Submitted as-is, never re-derived from `amount`. */
  amountRaw?: bigint;
  /** Treasury budget snapshot the size was clamped against, logged on a cap rejection (#76). */
  budget?: Record<string, string>;
  price: number;
  kellyFraction: number;
  edgeDetected: number;
  traceId?: string;
  /** Trace document to pin and publish once the trade is on-chain. */
  tracePayload?: Record<string, unknown>;
}

export interface CopyTradePayload {
  marketId: string;
  traceId: string;
  direction: TradeDirection;
  amount: number;
  userWallet: string;
}

export interface KellyInput {
  agentProbability: number;
  marketProbability: number;
  bankroll: number;
  netOdds: number;
}

// ─── Reasoning trace types ───
export interface TraceInput {
  marketId: string;
  agentType: AgentType;
  decisionType: string;
  sourcesUsed: WeightedSignal[];
  probabilityEstimate: number;
  marketProbability: number;
  edge: number;
  confidenceInterval: ConfidenceInterval;
  betFraction?: number;
  betSizeUsdc?: number;
  hedgeConditions?: string[];
  agentWallet?: string;
  /** Correlation inputs that sized the trade, so subscribers can see why a size was cut (#80). */
  correlation?: { pairs: CorrelationPair[]; method: 'snapshot' | 'matrix'; snapshotId: string | null };
  /** Seed policy record for market-creation traces (#82). */
  seedPolicy?: Record<string, unknown>;
  /**
   * Per-model forecasts, weights and input digests behind probabilityEstimate
   * (#75). When present, confidenceInterval is the ensemble's and is used as given.
   */
  forecast?: Record<string, unknown>;
  /** Treasury-aware sizing: Kelly/correlation/final sizes, binding constraint, budget snapshot (#76). */
  sizing?: Record<string, unknown>;
}

export interface TraceVerification {
  traceId: string;
  onChainTraceId: string;
  ipfsCid: string;
  onChainHash: string;
  computedHash: string;
  storedHash: string | null;
  verified: boolean;
  /** Where the verified bytes came from (#100). */
  contentSource?: 'cache' | 'gateway';
  verifiedAt: Date;
}

// ─── Portfolio types ───
export interface PortfolioSummary {
  /** Treasury free cash + deployed capital; null when the treasury could not be read (#76). */
  totalUsdc: number | null;
  deployedCapital: number;
  /** Treasury free cash (available_capital); null when it could not be read. */
  availableCapital: number | null;
  openPositions: number;
  totalPnl: number;
  dailyPnl: number;
  builderFeesEarned: number;
  /** On-chain capital and caps in 7-decimal base units, as decimal strings (#76). */
  treasury: {
    availableRaw: string;
    maxTradeRaw: string;
    maxMarketRaw: string;
    maxDailyRaw: string;
    dailyUsedRaw: string;
    dailyRemainingRaw: string;
    dailyResetsAt: string;
  } | null;
}

// ─── Correlation types ───
export interface CorrelationPair {
  marketIdA: string;
  marketIdB: string;
  correlationScore: number;   // -1 to +1
  relationship: 'POSITIVE' | 'NEGATIVE' | 'NONE';
  /** Where the score came from: an empirical snapshot estimate, the snapshot's prior fallback, or the category matrix. */
  method?: 'empirical' | 'prior' | 'matrix';
}

export interface CorrelationCheckResult {
  hasCorrelatedPositions: boolean;
  correlatedPairs: CorrelationPair[];
  adjustedPositionSize: number;
  totalCorrelatedExposure: number;
  /** 'snapshot' when at least one pair used a stored snapshot, otherwise 'matrix'. */
  method?: 'snapshot' | 'matrix';
  snapshotId?: string | null;
}

// ─── Hedge types ───
export interface HedgeRecommendation {
  originalMarketId: string;
  hedgeMarketId: string;
  hedgeDirection: TradeDirection;
  hedgeSize: number;
  rationale: string;
}

// ─── API response types ───
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T | null;
  error: ApiError | null;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ─── Subscription types ───
export interface SubscriptionAccess {
  hasAccess: boolean;
  accessType: 'FREE_PREVIEW' | 'PER_TRACE' | 'DAILY_PASS' | 'NO_ACCESS';
  expiresAt?: Date;
}

// ─── Jod types ───
export interface JobRecord {
  status: JobStatus;
  startedAt: Date;
  completedAt?: Date;
  marketId?: string;
  onChainMarketId?: string | null;
  question?: string;
  category?: MarketCategory;
  error?: string;
}