import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { newId, runWithContext } from '../lib/context';
import { confirmPendingPaymentIntents } from '../services/payment-intent.service';
import { recordCronRun } from './registry';

let isRunning = false;

/**
 * Confirms submitted payment intents and expires abandoned ones (#52). The
 * per-hash advisory lock inside submitPaymentIntent makes this safe to run on
 * every instance; the in-process guard only avoids duplicate work per process.
 */
export function startPaymentIntentCron(): void {
  if (!config.PAYMENT_INTENT_CONFIRM_ENABLED) {
    logger.info('Payment intent confirmer is disabled by config');
    return;
  }

  cron.schedule(config.PAYMENT_INTENT_CONFIRM_CRON, () => {
    const cycleId = newId('cyc');
    return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job: 'payment-intent-confirmer' }, async () => {
      if (isRunning) return;
      isRunning = true;
      const startedAt = new Date();
      try {
        await confirmPendingPaymentIntents();
        recordCronRun('payment-intent-confirmer', 'success', startedAt, new Date());
      } catch (err) {
        recordCronRun('payment-intent-confirmer', 'failure', startedAt, new Date(), err);
        logger.error({ err }, 'Payment intent confirmer failed');
      } finally {
        isRunning = false;
      }
    });
  });

  logger.info({ cron: config.PAYMENT_INTENT_CONFIRM_CRON }, 'Payment intent confirmer scheduled');
}
