import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../lib/logger';
import { runReportJob } from '../services/transparency-report.service';

let running = false;

/** Daily transparency report (#159), at REPORT_CRON (default 00:10 UTC). */
export function startReportCron(): void {
  if (!config.REPORTS_ENABLED) {
    logger.info('REPORTS_ENABLED=false; transparency report cron disabled');
    return;
  }
  cron.schedule(
    config.REPORT_CRON,
    async () => {
      if (running) {
        logger.warn('Report cron: previous run still in progress — skipping');
        return;
      }
      running = true;
      try {
        const row = await runReportJob();
        logger.info({ date: row.date, cid: row.cid, mode: row.mode }, 'Transparency report published');
      } catch (err) {
        logger.error({ err }, 'Report cron: transparency report failed');
      } finally {
        running = false;
      }
    },
    { timezone: 'Etc/UTC' },
  );
  logger.info({ cron: config.REPORT_CRON }, 'Transparency report cron started');
}
