import cron from 'node-cron';
import { runTraderCycle } from '../agents/trader.agent';
import { expireStaleSubscriptions } from '../services/subscription.service';
import { logger } from '../lib/logger';
import { config } from '../config';
import { postgresContentStore } from '../services/content-store.service';
import { correlation, newId, runWithContext } from '../lib/context';
import { purgeExpiredIdempotencyKeys } from '../middlewares/idempotency.middleware';
import { computeAndStoreSnapshots } from '../services/calibration.service';
import { recordCronRun } from './registry';

let runningTraderCycleId: string | null = null;

/** One correlated context per cron tick. */
function tick(job: string, fn: () => Promise<void>): Promise<void> {
  const cycleId = newId('cyc');
  return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job }, fn);
}

/**
 * Position Monitor Cron — runs every 15 minutes.
 *
 * Responsibilities:
 * 1. Run the Trader Agent cycle (scan markets, update positions, hedge)
 * 2. Expire stale subscriptions
 *
 * Separate guard flags prevent the Trader Agent from overlapping with itself.
 */
export function startMonitorCron(): void {
  // Trader Agent — every 15 minutes
  cron.schedule('5,20,35,50 * * * *', () => tick('trader', async () => {
    if (runningTraderCycleId) {
      logger.warn({ skippedJob: 'trader', runningCycleId: runningTraderCycleId }, 'Monitor cron: trader cycle still running — skipping');
      return;
    }

    runningTraderCycleId = correlation().cycleId ?? 'trader';
    const startedAt = new Date();
    try {
      await runTraderCycle();
      recordCronRun('trader', 'success', startedAt, new Date());
    } catch (err) {
      recordCronRun('trader', 'failure', startedAt, new Date(), err);
      logger.error({ err }, 'Monitor cron: trader cycle failed');
    } finally {
      runningTraderCycleId = null;
    }
  }));

  // Calibration snapshots (#68) — daily at 03:10. The computation takes a
  // Postgres advisory lock, so with several instances only one does the work.
  cron.schedule('10 3 * * *', () => tick('calibration', async () => {
    const startedAt = new Date();
    try {
      await computeAndStoreSnapshots();
      recordCronRun('calibration', 'success', startedAt, new Date());
    } catch (err) {
      recordCronRun('calibration', 'failure', startedAt, new Date(), err);
      logger.error({ err }, 'Monitor cron: calibration snapshots failed');
    }
  }));

  // Subscription expiry — every hour
  cron.schedule('0 * * * *', async () => {
    const startedAt = new Date();
    try {
      await expireStaleSubscriptions();
      recordCronRun('subscription-expiry', 'success', startedAt, new Date());
    } catch (err) {
      recordCronRun('subscription-expiry', 'failure', startedAt, new Date(), err);
      logger.error({ err }, 'Monitor cron: subscription expiry failed');
    }
  });

  // Expired Idempotency-Key rows (24h TTL, #123) — hourly at :10, in batches of 5 000
  cron.schedule('10 * * * *', async () => {
    const startedAt = new Date();
    try {
      const deleted = await purgeExpiredIdempotencyKeys();
      recordCronRun('idempotency-purge', 'success', startedAt, new Date());
      if (deleted > 0) logger.info({ deleted }, 'Monitor cron: purged expired idempotency keys');
    } catch (err) {
      recordCronRun('idempotency-purge', 'failure', startedAt, new Date(), err);
      logger.error({ err }, 'Monitor cron: idempotency key purge failed');
    }
  });

  // Copy trade sweep — every 5 minutes
  cron.schedule('*/5 * * * *', () => tick('copy_trade_sweep', sweepCopyTrades));

  // IPFS content eviction (#100) — hourly at :30, bounded batches.
  cron.schedule('30 * * * *', async () => {
    try {
      const result = await postgresContentStore.evict(config.IPFS_CACHE_BUDGET_BYTES);
      if (result.removed > 0) logger.info(result, 'Monitor cron: evicted IPFS content');
    } catch (err) {
      logger.error({ err }, 'Monitor cron: IPFS content eviction failed');
    }
  });

  logger.info('Monitor cron started');
}

let sweepRunning = false;
async function sweepCopyTrades(): Promise<void> {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const { prisma } = await import('../lib/prisma');
    const { CopyTradeStatus, expireStaleCopyTrades, verifyCopyTradeTx, CopyTradePendingError } = await import('../services/copy-trade.service');
    const { toDisplayUsdc } = await import('../lib/amounts');
    const { AppError } = await import('../middlewares/error.middleware');

    await expireStaleCopyTrades();

    const confirming = await prisma.copyTrade.findMany({
      where: {
        status: CopyTradeStatus.CONFIRMING,
        verificationAttempts: { lt: 20 },
        txHash: { not: null },
      },
      include: { market: { select: { onChainMarketId: true } } },
      take: 20,
    });

    for (const ct of confirming) {
      if (!ct.txHash || !ct.market?.onChainMarketId) continue;
      try {
        // Check chain_events first for stored Trade events
        const storedEvent = await prisma.chainEvent.findFirst({
          where: {
            txHash: ct.txHash,
            eventName: 'Trade',
            contractName: 'marketCore',
          },
        });
        if (storedEvent) {
          const params = storedEvent.params as any;
          const rawOutcome = params?.outcome;
          const outcomeTag = rawOutcome && typeof rawOutcome === 'object' && 'tag' in rawOutcome ? rawOutcome.tag : rawOutcome;
          const trader = params?.trader;
          const isBuy = Boolean(params?.is_buy);
          const marketId = BigInt(params?.market_id ?? -1);

          if (
            isBuy &&
            marketId === ct.market.onChainMarketId &&
            trader?.toLowerCase() === (ct as any).followerWallet.toLowerCase() &&
            (((ct as any).outcome === 'YES' && outcomeTag === 'Yes') || ((ct as any).outcome === 'NO' && outcomeTag === 'No'))
          ) {
            const collateral = BigInt(params?.collateral ?? 0);
            await prisma.copyTrade.update({
              where: { id: ct.id },
              data: {
                status: CopyTradeStatus.EXECUTED,
                collateralRaw: collateral.toString(),
                sharesRaw: params?.shares ? String(params.shares) : null,
                feeRaw: params?.fee ? String(params.fee) : '0',
                ledger: storedEvent.ledger,
                chainEventId: storedEvent.id,
                confirmedAt: new Date(storedEvent.ledgerClosedAt),
                amount: toDisplayUsdc(collateral),
                failureCode: null,
              },
            });
            continue;
          }
        }

        // Otherwise verify via RPC
        const outcome = (ct as any).outcome === 'YES' ? 'Yes' : 'No';
        const maxCollateral = BigInt(ct.amountRaw ?? '0');
        const verified = await verifyCopyTradeTx({
          txHash: ct.txHash,
          trader: (ct as any).followerWallet,
          onChainMarketId: ct.market.onChainMarketId,
          outcome,
          maxCollateral,
        });

        await prisma.copyTrade.update({
          where: { id: ct.id },
          data: {
            status: CopyTradeStatus.EXECUTED,
            collateralRaw: verified.collateral.toString(),
            sharesRaw: verified.shares.toString(),
            feeRaw: verified.fee.toString(),
            ledger: verified.ledger,
            chainEventId: verified.eventId,
            confirmedAt: new Date(),
            amount: toDisplayUsdc(verified.collateral),
            failureCode: null,
          },
        });
      } catch (err: any) {
        if (err instanceof CopyTradePendingError) {
          await prisma.copyTrade.update({
            where: { id: ct.id },
            data: { verificationAttempts: { increment: 1 } },
          });
        } else if (err instanceof AppError && err.statusCode === 422) {
          await prisma.copyTrade.update({
            where: { id: ct.id },
            data: { status: CopyTradeStatus.FAILED, failureCode: err.code },
          });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Copy trade sweep failed');
  } finally {
    sweepRunning = false;
  }
}