/**
 * One market's FPMM pool, simulated with the contract's own math
 * (src/generated/fpmm.ts) so the agent's price impact matches on-chain.
 */
import {
  MathError, calcBuy, calcSell, collateralOutForShares, priceYesBps, seedReserves, settleValue,
  type Settlement,
} from '../generated/fpmm';

export type Outcome = 'Yes' | 'No';
export type PoolStatus = 'open' | 'resolved' | 'void';

/** Mirrors the market-core errors the simulation can hit. */
export class SimError extends Error {
  constructor(public readonly code: 'MarketClosed' | 'MarketNotOpen') {
    super(code);
    this.name = 'SimError';
  }
}

export interface Fill {
  sharesOut: bigint;
  fee: bigint;
  newReserveYes: bigint;
  newReserveNo: bigint;
}

export class SimPool {
  status: PoolStatus = 'open';

  constructor(
    public reserveYes: bigint,
    public reserveNo: bigint,
    public readonly feeBps: bigint,
    /** Unix seconds; trading stops at this time (market-core MarketClosed). */
    public readonly closeTime: number,
  ) {}

  static seeded(seed: bigint, initialYesBps: number, feeBps: number, closeTime: number): SimPool {
    const r = seedReserves(seed, BigInt(initialYesBps));
    return new SimPool(r.reserveYes, r.reserveNo, BigInt(feeBps), closeTime);
  }

  priceYesBps(): number {
    return Number(priceYesBps(this.reserveYes, this.reserveNo));
  }

  /** Probability of an outcome, in bps. */
  priceBps(outcome: Outcome): number {
    const yes = this.priceYesBps();
    return outcome === 'Yes' ? yes : 10_000 - yes;
  }

  private assertTradable(nowSecs: number): void {
    if (this.status !== 'open') throw new SimError('MarketNotOpen');
    if (nowSecs >= this.closeTime) throw new SimError('MarketClosed');
  }

  /** What buying `collateral` of `outcome` would do, without changing the pool. Throws SimError/MathError. */
  quoteBuy(outcome: Outcome, collateral: bigint, nowSecs: number): Fill {
    this.assertTradable(nowSecs);
    return outcome === 'Yes'
      ? this.fillBuy(this.reserveYes, this.reserveNo, collateral, true)
      : this.fillBuy(this.reserveNo, this.reserveYes, collateral, false);
  }

  private fillBuy(rBought: bigint, rOther: bigint, collateral: bigint, yes: boolean): Fill {
    const q = calcBuy(rBought, rOther, collateral, this.feeBps);
    return yes
      ? { sharesOut: q.sharesOut, fee: q.fee, newReserveYes: q.newReserveBought, newReserveNo: q.newReserveOther }
      : { sharesOut: q.sharesOut, fee: q.fee, newReserveYes: q.newReserveOther, newReserveNo: q.newReserveBought };
  }

  commit(fill: Fill): void {
    this.reserveYes = fill.newReserveYes;
    this.reserveNo = fill.newReserveNo;
  }

  /** Buys at the current pool state with calcBuy and moves the price. */
  agentBuy(outcome: Outcome, collateral: bigint, nowSecs: number): Fill {
    const fill = this.quoteBuy(outcome, collateral, nowSecs);
    this.commit(fill);
    return fill;
  }

  /**
   * Sells `shares` of `outcome`. Selling is exact-collateral in the contract,
   * so the collateral comes from collateralOutForShares and is trimmed until
   * the pool takes no more shares than are held. Returns the proceeds and the
   * shares actually sold (any remainder is dust).
   */
  agentSell(outcome: Outcome, shares: bigint, nowSecs: number): { collateralOut: bigint; sharesSold: bigint } {
    this.assertTradable(nowSecs);
    const [rSold, rOther] = outcome === 'Yes' ? [this.reserveYes, this.reserveNo] : [this.reserveNo, this.reserveYes];
    let out = collateralOutForShares(rSold, rOther, shares, this.feeBps);
    for (let i = 0; i < 8 && out > 0n; i++, out -= 1n) {
      try {
        const q = calcSell(rSold, rOther, out, this.feeBps);
        if (q.sharesIn > shares) continue;
        if (outcome === 'Yes') { this.reserveYes = q.newReserveSold; this.reserveNo = q.newReserveOther; }
        else { this.reserveNo = q.newReserveSold; this.reserveYes = q.newReserveOther; }
        return { collateralOut: out, sharesSold: q.sharesIn };
      } catch (err) {
        if (!(err instanceof MathError)) throw err;
      }
    }
    throw new MathError('position too small to sell');
  }

  /**
   * Collateral a position of `shares` would fetch if sold now; shares × mid
   * when the pool cannot absorb it.
   */
  liquidationValue(outcome: Outcome, shares: bigint): bigint {
    if (shares <= 0n) return 0n;
    const [rSold, rOther] = outcome === 'Yes' ? [this.reserveYes, this.reserveNo] : [this.reserveNo, this.reserveYes];
    try {
      return collateralOutForShares(rSold, rOther, shares, this.feeBps);
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
      return (shares * BigInt(this.priceBps(outcome))) / 10_000n;
    }
  }

  /** Reset mode: snap to the reserves a historical Trade left behind. */
  setReserves(reserveYes: bigint, reserveNo: bigint): void {
    this.reserveYes = reserveYes;
    this.reserveNo = reserveNo;
  }

  /**
   * Propagate mode: re-execute a historical trade's collateral against the
   * simulated pool, so the agent's earlier impact stays in the price. Returns
   * false when the pool cannot fill it (the trade is skipped).
   */
  applyExternalTrade(outcome: Outcome, isBuy: boolean, collateral: bigint): boolean {
    try {
      if (isBuy) {
        this.commit(outcome === 'Yes'
          ? this.fillBuy(this.reserveYes, this.reserveNo, collateral, true)
          : this.fillBuy(this.reserveNo, this.reserveYes, collateral, false));
      } else if (outcome === 'Yes') {
        const q = calcSell(this.reserveYes, this.reserveNo, collateral, this.feeBps);
        this.reserveYes = q.newReserveSold;
        this.reserveNo = q.newReserveOther;
      } else {
        const q = calcSell(this.reserveNo, this.reserveYes, collateral, this.feeBps);
        this.reserveNo = q.newReserveSold;
        this.reserveYes = q.newReserveOther;
      }
      return true;
    } catch (err) {
      if (err instanceof MathError) return false;
      throw err;
    }
  }

  resolve(outcome: Outcome | null): void {
    this.status = outcome === null ? 'void' : 'resolved';
  }
}

/** Payout of a position holding only one side, at settlement. */
export function settlePosition(kind: Settlement, outcome: Outcome, shares: bigint): bigint {
  return outcome === 'Yes' ? settleValue(kind, shares, 0n) : settleValue(kind, 0n, shares);
}
