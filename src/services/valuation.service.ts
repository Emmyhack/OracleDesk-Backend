/**
 * Position valuation on the FPMM (#78).
 *
 * A position is a number of outcome shares, each redeemable for 1 collateral
 * unit if its outcome wins. Before resolution it is worth, in order of
 * realism:
 *   - mid value:         shares × price      (what the quoted price implies)
 *   - liquidation value: what selling all shares into the pool returns now
 *     (`collateralOutForShares`, rounded down, fee included)
 * Risk controls use liquidation value; the API reports both. Several positions
 * in one market are each valued by their own shares: selling them together
 * returns less than the sum, because each sale moves the pool.
 *
 * All arithmetic is bigint. Reserves come from the newest indexed market-core
 * `Trade` event (which carries the post-trade reserves) and fall back to
 * `get_market`; `fee_bps` is fixed at market creation and cached.
 */
import { now as clockNow } from '../lib/clock';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { bigintToDecimalString, decimalToBigint, toDisplayUsdc } from '../lib/amounts';
import { BPS, MathError, collateralOutForShares, priceYesBps, settleValue } from '../generated/fpmm';
import { getOnChainMarket } from './chain.service';
import { indexerStatus } from './indexer.service';

export type OutcomeName = 'YES' | 'NO';
export type ValuationSource = 'indexed' | 'rpc';

export interface MarketReserves {
  reserveYes: bigint;
  reserveNo: bigint;
  feeBps: bigint;
  asOfLedger: number;
  source: ValuationSource;
}

export interface PositionValue {
  /** Price of the held outcome in basis points. */
  priceBps: bigint;
  midValueRaw: bigint;
  /** What selling every share now returns; 0 when the pool can't absorb it. */
  liquidationValueRaw: bigint;
  /** liquidationValueRaw − costBasisRaw. */
  unrealisedPnlRaw: bigint;
  /** True when the pool cannot absorb a sale of all shares (liquidation is then 0). */
  illiquid: boolean;
  /** Value of the shares if the market resolved yes / no / void. */
  settlementValueRaw: { yes: bigint; no: bigint; void: bigint };
}

export function valuePosition(
  outcome: OutcomeName,
  sharesRaw: bigint,
  costBasisRaw: bigint,
  r: MarketReserves,
): PositionValue {
  const yesBps = priceYesBps(r.reserveYes, r.reserveNo);
  const priceBps = outcome === 'YES' ? yesBps : BPS - yesBps;
  const midValueRaw = (sharesRaw * priceBps) / BPS;

  // The sold side's reserve first: swapping these is the classic bug.
  const [rSold, rOther] = outcome === 'YES' ? [r.reserveYes, r.reserveNo] : [r.reserveNo, r.reserveYes];
  let liquidationValueRaw = 0n;
  let illiquid = false;
  if (sharesRaw > 0n) {
    try {
      liquidationValueRaw = collateralOutForShares(rSold, rOther, sharesRaw, r.feeBps);
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
      illiquid = true;
    }
  }

  const [yesShares, noShares] = outcome === 'YES' ? [sharesRaw, 0n] : [0n, sharesRaw];
  return {
    priceBps,
    midValueRaw,
    liquidationValueRaw,
    unrealisedPnlRaw: liquidationValueRaw - costBasisRaw,
    illiquid,
    settlementValueRaw: {
      yes: settleValue('yes', yesShares, noShares),
      no: settleValue('no', yesShares, noShares),
      void: settleValue('void', yesShares, noShares),
    },
  };
}

// ─── Reserves ────────────────────────────────────────────────────────────────

export interface ReserveDeps {
  /** Newest indexed Trade event of a market, or null. */
  newestTradeEvent(onChainMarketId: bigint): Promise<{ ledger: number; params: Record<string, any> } | null>;
  getMarket(onChainMarketId: bigint): Promise<{ reserve_yes: bigint; reserve_no: bigint; fee_bps: number | bigint }>;
  /** Whether the indexer is demonstrably keeping up (so the newest event is current). */
  indexerFresh(maxAgeLedgers: number): boolean;
}

/** Seconds per ledger on Stellar, to turn "ledgers behind" into a wall-clock age. */
const LEDGER_SECS = 5;
export const DEFAULT_MAX_AGE_LEDGERS = 120;

export const defaultReserveDeps: ReserveDeps = {
  async newestTradeEvent(onChainMarketId) {
    // Raw SQL so the planner can use the (params->>'market_id') expression index.
    const rows = await prisma.$queryRaw<Array<{ ledger: number; params: Record<string, any> }>>`
      SELECT "ledger", "params" FROM chain_events
      WHERE "eventName" = 'Trade' AND "contractName" = 'marketCore'
        AND params->>'market_id' = ${onChainMarketId.toString()}
      ORDER BY "ledger" DESC, "id" DESC
      LIMIT 1`;
    return rows[0] ?? null;
  },
  getMarket: (id) => getOnChainMarket(id),
  indexerFresh(maxAgeLedgers) {
    const status = indexerStatus();
    if (!status.enabled || status.lastLedger === null || !status.updatedAt) return false;
    return Date.now() - Date.parse(status.updatedAt) <= maxAgeLedgers * LEDGER_SECS * 1000;
  },
};

const feeCache = new Map<string, bigint>();
export function clearFeeCacheForTest(): void {
  feeCache.clear();
}

async function cachedFeeBps(id: bigint, deps: ReserveDeps): Promise<bigint> {
  const cached = feeCache.get(id.toString());
  if (cached !== undefined) return cached;
  const feeBps = BigInt((await deps.getMarket(id)).fee_bps);
  feeCache.set(id.toString(), feeBps);
  return feeBps;
}

/**
 * Current reserves of a market: the newest indexed Trade event when the
 * indexer is keeping up, otherwise `get_market`.
 */
export async function latestReserves(
  onChainMarketId: bigint,
  maxAgeLedgers = DEFAULT_MAX_AGE_LEDGERS,
  deps: ReserveDeps = defaultReserveDeps,
): Promise<MarketReserves> {
  if (deps.indexerFresh(maxAgeLedgers)) {
    try {
      const event = await deps.newestTradeEvent(onChainMarketId);
      if (event && event.params.reserve_yes !== undefined && event.params.reserve_no !== undefined) {
        return {
          reserveYes: BigInt(event.params.reserve_yes),
          reserveNo: BigInt(event.params.reserve_no),
          feeBps: await cachedFeeBps(onChainMarketId, deps),
          asOfLedger: event.ledger,
          source: 'indexed',
        };
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, onChainMarketId: onChainMarketId.toString() },
        'Indexed reserves unavailable; falling back to get_market',
      );
    }
  }
  const market = await deps.getMarket(onChainMarketId);
  const feeBps = BigInt(market.fee_bps);
  feeCache.set(onChainMarketId.toString(), feeBps);
  return {
    reserveYes: BigInt(market.reserve_yes),
    reserveNo: BigInt(market.reserve_no),
    feeBps,
    asOfLedger: 0,
    source: 'rpc',
  };
}

// ─── Mark to market ──────────────────────────────────────────────────────────

/**
 * Marks every OPEN position that has shares and an on-chain market. Reserves
 * are read once per market. A market that can't be read is skipped (its
 * positions keep their last mark) so one bad market never aborts the cycle.
 * Float `currentPrice` and `pnl` are derived from the raw values for API
 * compatibility.
 */
export async function markOpenPositions(
  deps: ReserveDeps = defaultReserveDeps,
  now = clockNow(),
): Promise<{ marked: number; skippedMarkets: number }> {
  const positions = await prisma.position.findMany({
    where: { status: 'OPEN', sharesRaw: { not: null } },
    include: { market: { select: { id: true, onChainMarketId: true, status: true } } },
  });

  const byMarket = new Map<string, typeof positions>();
  for (const p of positions) {
    if (p.market.onChainMarketId === null) continue;
    // Resolved or voided markets are closed by the indexer side effect.
    if (p.market.status === 'RESOLVED' || p.market.status === 'CANCELLED') continue;
    const key = p.market.onChainMarketId.toString();
    byMarket.set(key, [...(byMarket.get(key) ?? []), p]);
  }

  let marked = 0;
  let skippedMarkets = 0;
  for (const [key, group] of byMarket) {
    let reserves: MarketReserves;
    try {
      reserves = await latestReserves(BigInt(key), DEFAULT_MAX_AGE_LEDGERS, deps);
    } catch (err) {
      skippedMarkets++;
      logger.warn(
        { err: err instanceof Error ? err.message : err, onChainMarketId: key },
        'Could not read reserves; positions keep their last mark',
      );
      continue;
    }
    for (const p of group) {
      const shares = decimalToBigint(p.sharesRaw!);
      const cost = p.costBasisRaw == null ? 0n : decimalToBigint(p.costBasisRaw);
      const v = valuePosition(p.direction, shares, cost, reserves);
      const realised = decimalToBigint(p.realisedPnlRaw);
      await prisma.position.update({
        where: { id: p.id },
        data: {
          markPriceBps: Number(v.priceBps),
          markValueRaw: bigintToDecimalString(v.midValueRaw),
          liquidationValueRaw: bigintToDecimalString(v.liquidationValueRaw),
          unrealisedPnlRaw: bigintToDecimalString(v.unrealisedPnlRaw),
          markedAt: now,
          valuationSource: reserves.source,
          illiquid: v.illiquid,
          // Display floats only.
          currentPrice: Number(v.priceBps) / 10_000,
          pnl: toDisplayUsdc(realised + v.unrealisedPnlRaw),
        },
      });
      marked++;
    }
  }
  return { marked, skippedMarkets };
}
