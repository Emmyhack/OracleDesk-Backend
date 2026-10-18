import { AgentPausedError, gateCycle } from '../services/agent-controls.service';
import { writeAgentLog } from '../lib/agent-log';
import { logger } from '../lib/logger';
import { config } from '../config';
import { deadline } from '../lib/resilience';
import { shutdownController } from '../lib/shutdown';
import { prodTraderEnv } from './trader-env';
import { DEFAULT_PARAMS, runTraderPolicy } from './trader-policy';

/**
 * Trader Agent — main execution loop.
 *
 * Called by the monitor cron every 15 minutes. The decisions live in
 * trader-policy.ts and run against the production env (Prisma, chain
 * service, wall clock); the backtester runs the same policy against replayed
 * history. This function only adds the cycle deadline and failure logging.
 */
export async function runTraderCycle(opts?: { signal?: AbortSignal }): Promise<void> {
  logger.info('Trader Agent: starting cycle');

  // Persistent kill switch / pause (#79): a paused agent is an expected state.
  try {
    await gateCycle('TRADER');
  } catch (err) {
    if (err instanceof AgentPausedError) {
      logger.info({ ...err.details }, 'Trader Agent: paused — skipping cycle');
      return;
    }
    throw err;
  }

  const parentSignal = opts?.signal
    ? opts.signal
    : shutdownController.signal;

  const handle = deadline('rpc-write', parentSignal, config.CYCLE_DEADLINE_MS);
  const signal = handle.signal;

  try {
    signal.throwIfAborted();
    await runTraderPolicy(prodTraderEnv(), DEFAULT_PARAMS, { signal });
  } catch (err) {
    logger.error({ err }, 'Trader Agent: unhandled cycle error');
    await writeAgentLog({ agentType: 'TRADER', level: 'ERROR', action: 'CYCLE_FAILED', error: String(err) });
  } finally {
    handle.cleanup?.();
  }
}
