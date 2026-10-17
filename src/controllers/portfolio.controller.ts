import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { getPortfolioSummary } from '../services/portfolio.service';
import { getPortfolioCorrelations } from '../services/correlation.service';
import { treasuryAvailableCapital } from '../services/chain.service';
import { logger } from '../lib/logger';

/**
 * GET /portfolio
 * Returns the agent's portfolio summary:
 *   totalUsdc, deployedCapital, availableCapital,
 *   openPositions count, totalPnl, dailyPnl, builderFeesEarned
 */
export async function getPortfolio(req: Request, res: Response): Promise<void> {
  const [summary, correlations, availableCapitalRaw] = await Promise.all([
    getPortfolioSummary(),
    getPortfolioCorrelations(10_000),
    treasuryAvailableCapital(req.signal)
      .then((v) => v.toString())
      .catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : err }, 'treasury.available_capital read failed');
        return null;
      }),
  ]);

  const latestReport = await prisma.transparencyReport
    .findFirst({ orderBy: { date: 'desc' }, select: { date: true, anchorLedger: true, cid: true, hash: true, onChainTraceId: true, mode: true, consistency: true } })
    .catch(() => null);
  sendSuccess(res, { ...summary, correlationRisk: correlations, availableCapitalRaw, latestReport });
}

/**
 * GET /positions
 * Returns paginated positions (open + closed).
 * Query params: status (OPEN|CLOSED|STOP_LOSS|HEDGED), page, limit
 */
export async function getPositions(req: Request, res: Response): Promise<void> {
  const { page, limit, skip } = parsePagination(req.query as any);
  const status = req.query.status as string | undefined;

  const where = { ...(status ? { status: status as any } : {}) };

  const [positions, total] = await Promise.all([
    prisma.position.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        market: {
          select: { question: true, category: true, settlementCurrency: true, expiryTimestamp: true, onChainMarketId: true },
        },
        trade: {
          select: { direction: true, amount: true, edgeDetected: true, kellyFraction: true, txHash: true },
        },
      },
    }),
    prisma.position.count({ where }),
  ]);

  sendSuccess(res, positions, 200, buildPaginationMeta(page, limit, total) as any);
}

/**
 * GET /portfolio/stats
 * Platform counts straight from the database. (The unpushed draft of this
 * endpoint, commit 207464d, padded them with constants; this one doesn't.)
 */
export async function getPlatformStats(_req: Request, res: Response): Promise<void> {
  const [subscriberCount, copyVolume, rawSumResult, marketCount, onChainMarketCount, traceCount] = await Promise.all([
    prisma.user.count(),
    prisma.copyTrade.aggregate({ _sum: { amount: true }, where: { status: 'EXECUTED' } }),
    prisma.$queryRawUnsafe<Array<{ sum: string | null }>>(
      `SELECT COALESCE(SUM("collateralRaw"::numeric), 0)::text as sum FROM copy_trades WHERE status = 'EXECUTED' AND "collateralRaw" IS NOT NULL`
    ).catch(() => [{ sum: '0' }]),
    prisma.market.count(),
    prisma.market.count({ where: { onChainMarketId: { not: null } } }),
    prisma.reasoningTrace.count(),
  ]);
  const totalCopyVolume = copyVolume._sum.amount ?? 0;
  const totalCopyVolumeRaw = rawSumResult[0]?.sum ?? '0';
  sendSuccess(res, {
    subscriberCount,
    totalCopyVolume,
    totalCopyVolumeRaw,
    builderFees: 0,
    marketCount,
    onChainMarketCount,
    traceCount,
  });
}
