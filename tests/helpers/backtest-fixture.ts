/**
 * Builds tests/fixtures/backtest/events.json: a small synthetic market-core
 * history for the backtester, constructed with the contract's own math
 * (seedReserves, calcBuy) so every Trade's reserves follow from the previous
 * pool state. See tests/fixtures/backtest/README.md.
 */
import { calcBuy, priceYesBps, seedReserves } from '../../src/generated/fpmm';

const USDC = 10_000_000n;
export const FIXTURE_FEE_BPS = 100n;
export const FIXTURE_T0 = Date.UTC(2026, 9, 1); // 2026-10-01T00:00:00Z

export interface FixtureEvent {
  id: string;
  eventName: string;
  ledger: number;
  ledgerClosedAt: string;
  params: Record<string, any>;
}

const ledgerAt = (ms: number) => 1_000_000 + Math.floor((ms - FIXTURE_T0) / 5_000);

export class History {
  readonly events: FixtureEvent[] = [];
  private pools = new Map<number, { yes: bigint; no: bigint }>();
  private seq = 0;

  private push(eventName: string, ms: number, params: Record<string, any>) {
    this.events.push({
      id: `${String(ledgerAt(ms)).padStart(10, '0')}-${String(++this.seq).padStart(10, '0')}`,
      eventName, ledger: ledgerAt(ms), ledgerClosedAt: new Date(ms).toISOString(), params,
    });
  }

  create(marketId: number, ms: number, opts: { seedUsdc: bigint; yesBps: number; category: string; closeMs: number }): this {
    const r = seedReserves(opts.seedUsdc * USDC, BigInt(opts.yesBps));
    this.pools.set(marketId, { yes: r.reserveYes, no: r.reserveNo });
    this.push('MarketCreated', ms, {
      market_id: String(marketId), creator: 'GCREATOR', category: { tag: opts.category },
      close_time: String(Math.floor(opts.closeMs / 1000)), seed_amount: (opts.seedUsdc * USDC).toString(), initial_yes_bps: String(opts.yesBps),
    });
    return this;
  }

  price(marketId: number): number {
    const p = this.pools.get(marketId)!;
    return Number(priceYesBps(p.yes, p.no));
  }

  /** An external buy of `collateralUsdc` of `outcome`; reserves come from calcBuy. */
  buy(marketId: number, ms: number, outcome: 'Yes' | 'No', collateralUsdc: bigint): this {
    const p = this.pools.get(marketId)!;
    const collateral = collateralUsdc * USDC;
    const q = outcome === 'Yes'
      ? calcBuy(p.yes, p.no, collateral, FIXTURE_FEE_BPS)
      : calcBuy(p.no, p.yes, collateral, FIXTURE_FEE_BPS);
    const next = outcome === 'Yes' ? { yes: q.newReserveBought, no: q.newReserveOther } : { yes: q.newReserveOther, no: q.newReserveBought };
    this.pools.set(marketId, next);
    this.push('Trade', ms, {
      market_id: String(marketId), trader: 'GEXTERNAL', outcome: { tag: outcome }, is_buy: true,
      collateral: collateral.toString(), shares: q.sharesOut.toString(), fee: q.fee.toString(),
      reserve_yes: next.yes.toString(), reserve_no: next.no.toString(),
    });
    return this;
  }

  resolve(marketId: number, ms: number, outcome: 'Yes' | 'No' | null): this {
    this.push('MarketResolved', ms, { market_id: String(marketId), outcome: outcome ? { tag: outcome } : null });
    return this;
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * Two markets, each seeded with 50 000 USDC: deep enough that one 250 USDC entry
 * moves a ~25% price by ~1.5% relative, well inside the 15% stop-loss band. (In a
 * 5 000 USDC pool the same entry moves it ~15% relative and trips the policy's
 * stop-loss on the agent's own impact.) Each sees one burst of external trades just before a 15-minute
 * step (so the agent reads the final price in one go) and a little later
 * noise well inside the 15% stop-loss band, then resolves:
 *   1 (Crypto): opens 55% YES, a burst of NO buys takes it to ~25%; resolves Yes.
 *   2 (Macro):  opens 20% YES, a burst of YES buys takes it to ~50%; resolves No.
 * The market's opening price is the "prior" forecaster's estimate, so the prior
 * says YES on market 1 and NO on market 2, and both end up right.
 */
export function buildFixture(): { events: FixtureEvent[]; signals: []; forecasts: [] } {
  const h = new History();
  const close = FIXTURE_T0 + 8 * DAY;

  h.create(1, FIXTURE_T0 + 5 * MIN, { seedUsdc: 50_000n, yesBps: 5500, category: 'Crypto', closeMs: close });
  h.create(2, FIXTURE_T0 + 6 * MIN, { seedUsdc: 50_000n, yesBps: 2000, category: 'Macro', closeMs: close });

  // Burst before the 01:00 step on day 1.
  for (let i = 0; h.price(1) > 2500 && i < 60; i++) h.buy(1, FIXTURE_T0 + DAY + 20 * MIN + i * 5_000, 'No', 4000n);
  for (let i = 0; h.price(2) < 5000 && i < 60; i++) h.buy(2, FIXTURE_T0 + DAY + 25 * MIN + i * 5_000, 'Yes', 4000n);

  // Small noise trades during days 2–5.
  for (let d = 2; d <= 5; d++) {
    h.buy(1, FIXTURE_T0 + d * DAY + 3 * 60 * MIN, d % 2 ? 'No' : 'Yes', 500n);
    h.buy(2, FIXTURE_T0 + d * DAY + 5 * 60 * MIN, d % 2 ? 'Yes' : 'No', 500n);
  }

  h.resolve(1, FIXTURE_T0 + 6 * DAY, 'Yes');
  h.resolve(2, FIXTURE_T0 + 6 * DAY + 12 * 60 * MIN, 'No');
  return { events: h.events, signals: [], forecasts: [] };
}
