import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { escalateOpenReviews, pollProposals } from '../services/dispute-monitor.service';
import { recordCronRun } from './registry';

let escalating = false;
let polling = false;

/**
 * Dispute monitor crons (#92).
 *  - every 5 minutes: review pending proposals and escalate (INSUFFICIENT → CRITICAL
 *    as the window shrinks, unless acknowledged);
 *  - every 30 minutes: find proposals whose event was missed and close reviews
 *    whose proposal is gone.
 */
export function startDisputeCron(): void {
  if (!config.DISPUTE_MONITOR_ENABLED) {
    logger.info('Dispute monitor is disabled by config (DISPUTE_MONITOR_ENABLED=false)');
    return;
  }

  cron.schedule('*/5 * * * *', async () => {
    if (escalating) return;
    escalating = true;
    const startedAt = new Date();
    try {
      await escalateOpenReviews();
      recordCronRun('dispute-escalation', 'success', startedAt, new Date());
    } catch (err) {
      recordCronRun('dispute-escalation', 'failure', startedAt, new Date(), err);
      logger.error({ err: err instanceof Error ? err.message : err }, 'Dispute cron: escalation failed');
    } finally {
      escalating = false;
    }
  });

  cron.schedule('*/30 * * * *', async () => {
    if (polling) return;
    polling = true;
    const startedAt = new Date();
    try {
      const result = await pollProposals();
      recordCronRun('dispute-polling', 'success', startedAt, new Date());
      if (result.created > 0 || result.closed > 0) logger.info(result, 'Dispute cron: polling pass');
    } catch (err) {
      recordCronRun('dispute-polling', 'failure', startedAt, new Date(), err);
      logger.error({ err: err instanceof Error ? err.message : err }, 'Dispute cron: polling failed');
    } finally {
      polling = false;
    }
  });

  logger.info('Dispute monitor cron started');
}
