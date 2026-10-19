/**
 * The treasury's on-chain capital and risk caps as a sizing input (#76).
 *
 * The treasury contract enforces three caps on every agent spend
 * (reserve_capacity): `max_trade` per call, `max_market` cumulative per market
 * and `max_daily` per rolling day. The trader reads them once per cycle, sizes
 * from the free cash (`available_capital`) and clamps every order to the
 * remaining headroom in base units before a trace is generated, so a size the
 * chain would reject is never proposed.
 *
 * "Bankroll" means free cash: available_capital() is the treasury's USDC
 * balance. It includes subscription revenue (PAYMENTS_RECIPIENT defaults to
 * the treasury) and excludes capital locked in markets.
 */
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { now as clockNow } from '../lib/clock';
import { usdcFromNumber } from '../lib/amounts';
import { treasuryAvailableCapital, treasuryDailyUsage, treasuryRiskConfig } from './chain.service';

const DAY_SECONDS = 86_400n;

export interface TreasuryBudget {
  availableRaw: bigint;
  maxTradeRaw: bigint;
  maxMarketRaw: bigint;
  maxDailyRaw: bigint;
  dailyUsedRaw: bigint;
  dailyRemainingRaw: bigint;
  dailyWindowStart: Date;
  dailyResetsAt: Date;
  readAt: Date;
}

/** The three treasury views; injectable for tests and the backtester. */
export interface TreasuryReader {
  availableCapital(): Promise<bigint>;
  getConfig(): Promise<{ max_trade: bigint; max_market: bigint; max_daily: bigint }>;
  dailyUsage(): Promise<{ amount: bigint; day_start: bigint | number }>;
}

export const chainTreasuryReader: TreasuryReader = {
  availableCapital: () => treasuryAvailableCapital(),
  getConfig: () => treasuryRiskConfig(),
  dailyUsage: () => treasuryDailyUsage(),
};

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Reads available_capital, get_config and daily_usage in parallel. The
 * daily_usage view already applies the contract's rollover (a window expired
 * at ledger time shows amount 0 starting now), so the remaining daily
 * capacity is simply max_daily − amount, and the window resets at
 * day_start + 86 400 s. It is a rolling window anchored at the first spend
 * after expiry, not UTC midnight.
 */
export async function readTreasuryBudget(reader: TreasuryReader = chainTreasuryReader, now: Date = clockNow()): Promise<TreasuryBudget> {
  const [availableRaw, cfg, usage] = await Promise.all([reader.availableCapital(), reader.getConfig(), reader.dailyUsage()]);
  const dayStart = BigInt(usage.day_start);
  return {
    availableRaw: maxBig(0n, availableRaw),
    maxTradeRaw: cfg.max_trade,
    maxMarketRaw: cfg.max_market,
    maxDailyRaw: cfg.max_daily,
    dailyUsedRaw: usage.amount,
    dailyRemainingRaw: maxBig(0n, cfg.max_daily - usage.amount),
    dailyWindowStart: new Date(Number(dayStart) * 1000),
    dailyResetsAt: new Date(Number(dayStart + DAY_SECONDS) * 1000),
    readAt: now,
  };
}

/** The budget with bigints as decimal strings, for traces, logs and the API. */
export function budgetSnapshot(b: TreasuryBudget): Record<string, string> {
  return {
    availableRaw: b.availableRaw.toString(),
    maxTradeRaw: b.maxTradeRaw.toString(),
    maxMarketRaw: b.maxMarketRaw.toString(),
    maxDailyRaw: b.maxDailyRaw.toString(),
    dailyUsedRaw: b.dailyUsedRaw.toString(),
    dailyRemainingRaw: b.dailyRemainingRaw.toString(),
    dailyWindowStart: b.dailyWindowStart.toISOString(),
    dailyResetsAt: b.dailyResetsAt.toISOString(),
    readAt: b.readAt.toISOString(),
  };
}

/** A spend the trader just made, applied to its copy of the budget so later orders in the cycle see it. */
export function spend(b: TreasuryBudget, amountRaw: bigint): TreasuryBudget {
  return {
    ...b,
    availableRaw: maxBig(0n, b.availableRaw - amountRaw),
    dailyUsedRaw: b.dailyUsedRaw + amountRaw,
    dailyRemainingRaw: maxBig(0n, b.dailyRemainingRaw - amountRaw),
  };
}

// ─── Per-market exposure ──────────────────────────────────────────────────────

export interface MarketExposure {
  /** Cumulative amount the treasury has reserved against this market (never reduced by sells). */
  totalRaw: bigint;
  /** True when derived from DB trades + seed rather than the TradeAuthorized event. */
  estimated: boolean;
}

/**
 * The treasury's cumulative spend on a market, as `max_market` sees it.
 *
 * Preferred: the latest indexed `TradeAuthorized` event for the market, whose
 * `market_total` is exactly the contract's counter. Otherwise an estimate:
 * executed trades plus the market's seed when the agent created it (the seed
 * counts against both caps). Neither agent_sell nor close_trade reduces it.
 */
export async function marketExposureRaw(marketId: string, onChainMarketId: bigint | null): Promise<MarketExposure> {
  if (onChainMarketId !== null) {
    const event = await prisma.chainEvent.findFirst({
      where: {
        contractName: 'treasury',
        eventName: 'TradeAuthorized',
        params: { path: ['market_id'], equals: onChainMarketId.toString() },
      },
      orderBy: [{ ledger: 'desc' }, { id: 'desc' }],
      select: { params: true },
    });
    const total = (event?.params as { market_total?: unknown } | undefined)?.market_total;
    if (typeof total === 'string' && /^\d+$/.test(total)) return { totalRaw: BigInt(total), estimated: false };
  }

  const [trades, market] = await Promise.all([
    prisma.trade.findMany({ where: { marketId, status: 'EXECUTED' }, select: { amount: true } }),
    prisma.market.findUnique({ where: { id: marketId }, select: { seedAmountRaw: true } }),
  ]);
  const traded = trades.reduce((acc, t) => acc + usdcFromNumber(t.amount), 0n);
  const seed = market?.seedAmountRaw && /^\d+$/.test(market.seedAmountRaw) ? BigInt(market.seedAmountRaw) : 0n;
  return { totalRaw: traded + seed, estimated: true };
}

// ─── Clamp ────────────────────────────────────────────────────────────────────

export type SizingBinding = 'KELLY' | 'CORRELATION' | 'MAX_TRADE' | 'MAX_MARKET' | 'DAILY' | 'AVAILABLE';

/** Smallest order worth sending: 1 USDC. */
export const MIN_TRADE_RAW = 10_000_000n;

/** `x` less `bps` basis points, rounded down. */
export function withSafetyMargin(x: bigint, bps: number): bigint {
  return x <= 0n ? 0n : (x * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * The largest order not above `desiredRaw` that no cap would reject:
 * min(desired, max_trade, market headroom, daily remaining, available), with
 * the safety margin taken off the market and daily headroom. Never negative.
 * `binding` names the constraint that set the size ('KELLY' when the desired
 * size fit); on a tie the first of MAX_TRADE, MAX_MARKET, DAILY, AVAILABLE.
 */
export function clampSize(
  desiredRaw: bigint,
  b: TreasuryBudget,
  marketHeadroomRaw: bigint,
  safetyBps: number = config.TREASURY_HEADROOM_SAFETY_BPS,
): { sizeRaw: bigint; binding: Exclude<SizingBinding, 'CORRELATION'> } {
  const limits: Array<[Exclude<SizingBinding, 'KELLY' | 'CORRELATION'>, bigint]> = [
    ['MAX_TRADE', b.maxTradeRaw],
    ['MAX_MARKET', withSafetyMargin(marketHeadroomRaw, safetyBps)],
    ['DAILY', withSafetyMargin(b.dailyRemainingRaw, safetyBps)],
    ['AVAILABLE', b.availableRaw],
  ];
  let sizeRaw = maxBig(0n, desiredRaw);
  let binding: Exclude<SizingBinding, 'CORRELATION'> = 'KELLY';
  for (const [name, limit] of limits) {
    const cap = maxBig(0n, limit);
    if (cap < sizeRaw) {
      sizeRaw = cap;
      binding = name;
    }
  }
  return { sizeRaw, binding };
}

/** Contract errors that mean the treasury refused a spend on a cap. */
export const TREASURY_CAP_ERRORS = new Set(['TradeCapExceeded', 'MarketCapExceeded', 'DailyCapExceeded']);
