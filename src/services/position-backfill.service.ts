/**
 * Fills sharesRaw / costBasisRaw / feesPaidRaw on positions created before
 * shares were recorded (#78). Idempotent: only rows with sharesRaw = NULL are
 * touched.
 *
 *   1. The indexed market-core Trade event of the position's tx gives the exact
 *      shares, collateral and fee.
 *   2. Otherwise the buy is re-quoted with calcBuy on the reserves of the
 *      closest earlier indexed trade (or the market's seed reserves) and the row
 *      is marked valuationSource = 'estimated'.
 *   3. Positions with no on-chain trade (dry-run leftovers) are skipped and
 *      reported.
 */
import { prisma } from '../lib/prisma';
import { bigintToDecimalString, usdcFromNumber } from '../lib/amounts';
import { calcBuy, seedReserves } from '../generated/fpmm';
import { initialYesBps } from './market-chain.service';

export interface TradeFill {
  shares: bigint;
  collateral: bigint;
  fee: bigint;
}

export interface BackfillDeps {
  /** Exact fill from the indexed Trade event of a transaction, or null. */
  findTradeEvent(txHash: string, onChainMarketId: bigint): Promise<TradeFill | null>;
  /** Reserves after the newest indexed trade of the market before `before`, or null. */
  previousReserves(onChainMarketId: bigint, before: Date): Promise<{ reserveYes: bigint; reserveNo: bigint } | null>;
  feeBps(onChainMarketId: bigint): Promise<bigint>;
}

export interface BackfillReport {
  scanned: number;
  exact: number;
  estimated: number;
  skipped: Array<{ positionId: string; reason: string }>;
}

export const defaultBackfillDeps: BackfillDeps = {
  async findTradeEvent(txHash, onChainMarketId) {
    const rows = await prisma.$queryRaw<Array<{ params: Record<string, any> }>>`
      SELECT "params" FROM chain_events
      WHERE "eventName" = 'Trade' AND "contractName" = 'marketCore'
        AND "txHash" = ${txHash} AND params->>'market_id' = ${onChainMarketId.toString()}
        AND params->>'is_buy' = 'true'
      LIMIT 1`;
    const p = rows[0]?.params;
    return p ? { shares: BigInt(p.shares), collateral: BigInt(p.collateral), fee: BigInt(p.fee) } : null;
  },
  async previousReserves(onChainMarketId, before) {
    const rows = await prisma.$queryRaw<Array<{ params: Record<string, any> }>>`
      SELECT "params" FROM chain_events
      WHERE "eventName" = 'Trade' AND "contractName" = 'marketCore'
        AND params->>'market_id' = ${onChainMarketId.toString()}
        AND "ledgerClosedAt" < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "ledger" DESC LIMIT 1`;
    const p = rows[0]?.params;
    return p ? { reserveYes: BigInt(p.reserve_yes), reserveNo: BigInt(p.reserve_no) } : null;
  },
  async feeBps(onChainMarketId) {
    const { getOnChainMarket } = await import('./chain.service');
    return BigInt((await getOnChainMarket(onChainMarketId)).fee_bps);
  },
};

export async function backfillPositionShares(deps: BackfillDeps = defaultBackfillDeps): Promise<BackfillReport> {
  const positions = await prisma.position.findMany({
    where: { sharesRaw: null },
    include: {
      trade: { select: { txHash: true, status: true, amount: true, executedAt: true, createdAt: true } },
      market: { select: { onChainMarketId: true, seedAmountRaw: true, initialYesProb: true } },
    },
  });
  const report: BackfillReport = { scanned: positions.length, exact: 0, estimated: 0, skipped: [] };

  for (const p of positions) {
    const skip = (reason: string) => report.skipped.push({ positionId: p.id, reason });
    const marketId = p.market.onChainMarketId;
    if (marketId === null || !p.trade.txHash || p.trade.status !== 'EXECUTED') {
      skip('no on-chain trade (dry-run leftover or market never went on-chain)');
      continue;
    }

    let fill = await deps.findTradeEvent(p.trade.txHash, marketId);
    let source: 'indexed' | 'estimated' = 'indexed';
    if (!fill) {
      const collateral = usdcFromNumber(p.trade.amount);
      const at = p.trade.executedAt ?? p.trade.createdAt;
      let reserves = await deps.previousReserves(marketId, at);
      if (!reserves && p.market.seedAmountRaw) {
        const seed = seedReserves(BigInt(p.market.seedAmountRaw), BigInt(initialYesBps(p.market.initialYesProb)));
        reserves = { reserveYes: seed.reserveYes, reserveNo: seed.reserveNo };
      }
      if (!reserves) {
        skip('no indexed trade event and no reserves to estimate from');
        continue;
      }
      const feeBps = await deps.feeBps(marketId);
      const [bought, other] = p.direction === 'YES' ? [reserves.reserveYes, reserves.reserveNo] : [reserves.reserveNo, reserves.reserveYes];
      const quote = calcBuy(bought, other, collateral, feeBps);
      fill = { shares: quote.sharesOut, collateral, fee: quote.fee };
      source = 'estimated';
    }

    await prisma.position.update({
      where: { id: p.id },
      data: {
        sharesRaw: bigintToDecimalString(fill.shares),
        costBasisRaw: bigintToDecimalString(fill.collateral),
        feesPaidRaw: bigintToDecimalString(fill.fee),
        valuationSource: source,
      },
    });
    if (source === 'indexed') report.exact++;
    else report.estimated++;
  }
  return report;
}
