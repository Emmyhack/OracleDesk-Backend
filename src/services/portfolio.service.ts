import { prisma } from '../lib/prisma';
import type { PortfolioSummary } from '../types';
import dayjs from 'dayjs';
import { decimalToBigint, toDisplayUsdc, usdcFromNumber } from '../lib/amounts';

/**
 * Compute a full portfolio summary for the agent.
 * Used by GET /portfolio endpoint.
 */
export async function getPortfolioSummary(bankroll = 10_000): Promise<PortfolioSummary> {
  const [openPositions, closedPositions, builderFees] = await Promise.all([
    prisma.position.findMany({ where: { status: 'OPEN' } }),
    prisma.position.findMany({ where: { status: { in: ['CLOSED', 'STOP_LOSS'] } } }),
    prisma.trade.aggregate({ _sum: { builderFee: true }, where: { status: 'EXECUTED' } }),
  ]);

  // Share-denominated rows (#78) sum exactly in base units: deployed capital is
  // the cost of the shares still held, PnL is realised plus liquidation-based
  // unrealised. Legacy rows without shares still contribute their float size/pnl.
  let deployedRaw = 0n;
  let openPnlRaw = 0n;
  let legacyPnl = 0;
  for (const p of openPositions) {
    if (p.costBasisRaw == null) {
      deployedRaw += usdcFromNumber(p.size);
      legacyPnl += p.pnl;
      continue;
    }
    deployedRaw += decimalToBigint(p.costBasisRaw);
    openPnlRaw += decimalToBigint(p.realisedPnlRaw) + (p.unrealisedPnlRaw == null ? 0n : decimalToBigint(p.unrealisedPnlRaw));
  }
  const deployedCapital = toDisplayUsdc(deployedRaw);
  const totalPnl = toDisplayUsdc(openPnlRaw) + legacyPnl + closedPositions.reduce((acc, p) => acc + p.pnl, 0);

  // Daily PnL: positions closed or updated today
  const todayStart = dayjs().startOf('day').toDate();
  const dailyPnl = closedPositions
    .filter(p => p.closedAt && p.closedAt >= todayStart)
    .reduce((acc, p) => acc + p.pnl, 0);

  return {
    totalUsdc:         bankroll,
    deployedCapital:   parseFloat(deployedCapital.toFixed(2)),
    availableCapital:  parseFloat((bankroll - deployedCapital).toFixed(2)),
    openPositions:     openPositions.length,
    totalPnl:          parseFloat(totalPnl.toFixed(2)),
    dailyPnl:          parseFloat(dailyPnl.toFixed(2)),
    builderFeesEarned: parseFloat((builderFees._sum.builderFee ?? 0).toFixed(2)),
  };
}