import cron from 'node-cron';
import { runReconciliation, defaultDeps } from '../services/market-reconciler.service';
import { logger } from '../lib/logger';
import { config } from '../config';
import { newId, runWithContext } from '../lib/context';
import { recordCronRun } from './registry';

let isRunning = false;

/**
 * Market lifecycle reconciler (#83): every ten minutes, offset from the other
 * jobs. Every instance schedules it; the advisory lock inside
 * runReconciliation lets only one of them run.
 */
export function startReconcileCron(emit?: (event: string, payload: unknown) => void): void {
  if (!config.RECONCILE_ENABLED) {
    logger.info('Reconcile cron is disabled by config (RECONCILE_ENABLED=false)');
    return;
  }

  cron.schedule('3,13,23,33,43,53 * * * *', () => {
    const cycleId = newId('cyc');
    return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job: 'market-reconciler' }, async () => {
      if (isRunning) {
        logger.warn('Reconcile cron: previous run still active — skipping');
        return;
      }
      isRunning = true;
      const startedAt = new Date();
      try {
        const summary = await runReconciliation({}, { ...defaultDeps, emit });
        recordCronRun('market-reconciler', 'success', startedAt, new Date());
        if (!summary) logger.debug('Reconcile cron: another instance holds the lock');
      } catch (err) {
        recordCronRun('market-reconciler', 'failure', startedAt, new Date(), err);
        logger.error({ err }, 'Reconcile cron: run failed');
      } finally {
        isRunning = false;
      }
    });
  });

  logger.info('Reconcile cron scheduled');
}
