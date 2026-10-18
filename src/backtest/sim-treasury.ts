/**
 * The treasury's risk caps as the contract enforces them
 * (contracts/treasury reserve_capacity): a per-call max_trade, a cumulative
 * per-market max_market and a rolling max_daily whose window starts at the
 * first spend after the previous window expired. agent_sell is uncapped.
 */
export type CapError = 'InvalidAmount' | 'TradeCapExceeded' | 'MarketCapExceeded' | 'DailyCapExceeded' | 'InsufficientBalance';

const DAY_SECS = 24 * 60 * 60;

export interface TreasuryLimits {
  cash: bigint;
  maxTrade: bigint;
  maxMarket: bigint;
  maxDaily: bigint;
}

export class SimTreasury {
  cash: bigint;
  readonly maxTrade: bigint;
  readonly maxMarket: bigint;
  readonly maxDaily: bigint;
  readonly marketTotals = new Map<string, bigint>();
  dailyUsage = { amount: 0n, dayStart: 0 };

  constructor(limits: TreasuryLimits) {
    this.cash = limits.cash;
    this.maxTrade = limits.maxTrade;
    this.maxMarket = limits.maxMarket;
    this.maxDaily = limits.maxDaily;
  }

  /** The daily window as of `nowSecs`: a fresh one when the last has expired. */
  rolledDailyUsage(nowSecs: number): { amount: bigint; dayStart: number } {
    const { amount, dayStart } = this.dailyUsage;
    if (dayStart === 0 || nowSecs >= dayStart + DAY_SECS) return { amount: 0n, dayStart: nowSecs };
    return { amount, dayStart };
  }

  /**
   * Reserves capacity for a spend and takes the cash. Checks run in the
   * contract's order of concern: amount, per-trade, per-market, daily, then
   * balance. Returns the cap error, or null when the spend went through.
   */
  reserve(marketId: string, amount: bigint, nowSecs: number): CapError | null {
    if (amount <= 0n) return 'InvalidAmount';
    if (amount > this.maxTrade) return 'TradeCapExceeded';
    const marketTotal = (this.marketTotals.get(marketId) ?? 0n) + amount;
    if (marketTotal > this.maxMarket) return 'MarketCapExceeded';
    const rolled = this.rolledDailyUsage(nowSecs);
    if (rolled.amount + amount > this.maxDaily) return 'DailyCapExceeded';
    if (amount > this.cash) return 'InsufficientBalance';

    this.marketTotals.set(marketId, marketTotal);
    this.dailyUsage = { amount: rolled.amount + amount, dayStart: rolled.dayStart };
    this.cash -= amount;
    return null;
  }

  /** Proceeds of a sell or a settlement. Never capped. */
  credit(amount: bigint): void {
    this.cash += amount;
  }
}
