import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { newId, runWithContext } from '../lib/context';
import { recordCronRun } from './registry';
import { revealPriceSpec, runPriceResolutionTick } from '../services/price-resolution.service';
import { resolverState } from '../services/chain.service';
import type { ResolutionSpecJson } from '../lib/resolution-spec';

let isRunning = false;

/**
 * Price-mode markets (#90): every five minutes, reveal any price spec the
 * resolver still reports Unconfigured, then try `resolve_price` for markets
 * past close. The retry/escalation policy lives in runPriceResolutionTick.
 */
export function startPriceResolutionCron(): void {
  cron.schedule('*/5 * * * *', () => {
    const cycleId = newId('cyc');
    return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job: 'price-resolution' }, async () => {
      if (isRunning) {
        logger.warn('Price resolution cron: previous run still active — skipping');
        return;
      }
      isRunning = true;
      const startedAt = new Date();
      try {
        await revealPendingSpecs();
        const candidates = await prisma.market.findMany({
          where: {
            status: { in: ['ACTIVE', 'RESOLVING'] },
            onChainMarketId: { not: null },
            expiryTimestamp: { lte: new Date() },
            resolutionSpec: { path: ['kind'], equals: 'price' },
          },
          select: { id: true, onChainMarketId: true, expiryTimestamp: true, createdAt: true },
        });
        const { resolved, escalated } = await runPriceResolutionTick({ markets: candidates });
        recordCronRun('price-resolution', 'success', startedAt, new Date());
        if (resolved.length || escalated.length) {
          logger.info({ resolved: resolved.map(String), escalated: escalated.map(String) }, 'Price resolution cron: tick complete');
        }
      } catch (err) {
        recordCronRun('price-resolution', 'failure', startedAt, new Date(), err);
        logger.error({ err }, 'Price resolution cron: run failed');
      } finally {
        isRunning = false;
      }
    });
  });

  logger.info('Price resolution cron scheduled');
}

/** Reveals any live price market whose resolver state is still Unconfigured. */
async function revealPendingSpecs(): Promise<void> {
  const markets = await prisma.market.findMany({
    where: {
      status: 'ACTIVE',
      onChainMarketId: { not: null },
      resolutionSpec: { path: ['kind'], equals: 'price' },
    },
    select: { id: true, onChainMarketId: true, resolutionSpec: true },
  });
  for (const market of markets) {
    if (market.onChainMarketId === null) continue;
    try {
      if ((await resolverState(market.onChainMarketId)).tag !== 'Unconfigured') continue;
      await revealPriceSpec(market.onChainMarketId, market.resolutionSpec as Extract<ResolutionSpecJson, { kind: 'price' }>);
    } catch (err) {
      logger.warn({ marketId: market.id, err }, 'Price resolution cron: reveal failed; will retry next tick');
    }
  }
}
