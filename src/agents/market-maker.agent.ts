import { aggregateSignals } from '../services/ingestion.service';
import {
  generateMarketQuestion,
  checkDuplicate,
  createMarketFromProposal,
  normalizeCategory,
  prepareResolvableProposal,
} from '../services/market.service';
import { seedPolicyRecord } from '../services/seed-policy.service';
import { toDisplayUsdc } from '../lib/amounts';
import { prisma } from '../lib/prisma';
import { evidenceFromSignals, generateReasoningTrace } from '../services/reasoning.service';
import { createMarketOnChain, planMarketCreation } from '../services/market-chain.service';
import { planPriceMarket } from '../services/price-resolution.service';
import type { ResolutionSpecJson } from '../lib/resolution-spec';
import { enqueueTracePublication } from '../services/trace-publish.service';
import { TRACE_ACTIONS } from '../lib/trace-actions';
import { writeAgentLog } from '../lib/agent-log';
import { LlmBudgetExceeded, claimDailyOnce, getLlmUsage, type CallContext, type Priority } from '../lib/llm-budget';
import { logger } from '../lib/logger';
import { config } from '../config';
import { AgentPausedError, gateCycle } from '../services/agent-controls.service';
import { TransactionError } from '../services/stellar/errors';
import { deadline } from '../lib/resilience';
import { shutdownController } from '../lib/shutdown';

// Return shape used by the job tracker
export interface MarketCycleResult {
  marketId: string;
  question: string;
  category: string;
  onChainMarketId: string | null;
}

/**
 * Market Maker Agent — main execution loop.
 *
 * Called by the ingestion cron every 15 minutes AND manually via
 * POST /markets/generate. Returns market details on success so the
 * job tracker can surface them in GET /markets/generation-status/:jobId.
 *
 * Returns null when the cycle is intentionally skipped (no signals,
 * duplicate detected, etc.) — not an error condition.
 */
export async function runMarketMakerCycle(
  opts?: { signal?: AbortSignal; priority?: Priority },
): Promise<MarketCycleResult | null> {
  logger.info('Market Maker Agent: starting cycle');

  // Persistent kill switch / pause (#79): a paused agent is an expected state.
  try {
    await gateCycle('MARKET_MAKER');
  } catch (err) {
    if (err instanceof AgentPausedError) {
      logger.info({ ...err.details }, 'Market Maker Agent: paused — skipping cycle');
      return null;
    }
    throw err;
  }

  // Cron work stops at the budget minus the admin reserve; admin triggers run
  // up to the full budget (#71).
  const priority: Priority = opts?.priority ?? 'cron';
  const genCtx: CallContext = {
    purpose: priority === 'admin' ? 'admin_generation' : 'market_generation',
    priority,
  };

  const parentSignal = opts?.signal
    ? opts.signal
    : shutdownController.signal;

  const handle = deadline('rpc-write', parentSignal, config.CYCLE_DEADLINE_MS);
  const signal = handle.signal;

  try {
    signal.throwIfAborted();

    // Step 1: Aggregate signals from all sources
    const signals = await aggregateSignals(signal);
    if (signals.signalCount === 0) {
      logger.warn('Market Maker Agent: no signals available — skipping cycle');
      return null;
    }

    signal.throwIfAborted();

    // Step 2: Generate market proposal via the LLM
    let proposal;
    let proposalProvenance;
    let groundingSignals;
    try {
      ({ proposal, provenance: proposalProvenance, groundingSignals } = await generateMarketQuestion(signals, genCtx));
    } catch (err) {
      if (err instanceof LlmBudgetExceeded) {
        // One agent log per day, not one per 15-minute cycle.
        if (await claimDailyOnce('budget-exceeded')) {
          await writeAgentLog({
            agentType: 'MARKET_MAKER',
            level:     'WARN',
            action:    'LLM_BUDGET_EXCEEDED',
            data:      { priority, ...(err.details ?? {}) },
          }).catch(() => {});
        }
        logger.warn({ priority }, 'Market Maker Agent: LLM budget exhausted — skipping cycle');
        return null;
      }
      logger.error({ err }, 'Market Maker Agent: market generation failed');
      return null;
    }

    signal.throwIfAborted();

    // Step 2b: Reject proposals the committed source can't resolve in time, or
    // repair the close time (#74). Nothing is persisted or pinned before this.
    const prepared = await prepareResolvableProposal(proposal);
    if (!prepared) {
      logger.info({ question: proposal.market_question }, 'Market Maker Agent: proposal not resolvable — skipping');
      return null;
    }
    proposal = prepared.proposal;
    const resolutionDetails = prepared.resolution;

    signal.throwIfAborted();

    // Step 2c: price mode (#90). A CRYPTO proposal that names a registered
    // Reflector asset becomes a price spec, and its question is re-rendered from
    // the structured fields so text and the committed spec agree. Any problem
    // (parse, unregistered asset, dead feed, excess precision) falls back to the
    // signer spec, logged as PRICE_SPEC_FALLBACK.
    let marketSpec: ResolutionSpecJson | undefined;
    if (
      normalizeCategory(proposal.category) === 'CRYPTO' &&
      proposal.price_asset && proposal.price_threshold && proposal.price_direction && proposal.price_close_timestamp
    ) {
      const plan = await planPriceMarket({
        category: 'CRYPTO',
        proposal: {
          asset: proposal.price_asset,
          threshold: proposal.price_threshold,
          direction: proposal.price_direction,
          close_timestamp: proposal.price_close_timestamp,
        },
        network: config.STELLAR_NETWORK_PASSPHRASE,
      });
      if (plan.spec && plan.question) {
        marketSpec = plan.spec;
        proposal = { ...proposal, market_question: plan.question };
      }
    }

    // Step 3: Deduplicate
    const dedup = await checkDuplicate(proposal);
    await writeAgentLog({
      agentType: 'MARKET_MAKER',
      level:     dedup.duplicate ? 'WARN' : 'INFO',
      action:    dedup.duplicate ? 'DUPLICATE_SKIPPED' : 'DEDUP_CHECK',
      marketId:  dedup.match?.marketId,
      data:      { method: dedup.method, duplicate: dedup.duplicate, match: dedup.match },
    }).catch(() => {});
    if (dedup.duplicate) {
      logger.info({ method: dedup.method, similarity: dedup.match?.similarity, matchedMarketId: dedup.match?.marketId },
        'Market Maker Agent: duplicate market — skipping');
      return null;
    }

    signal.throwIfAborted();

    // Step 4: Seed policy. Decided before anything is written, pinned or sent:
    // when the budget does not allow a minimum seed there is no DB row, no
    // IPFS pin and no chain call.
    const decision = await planMarketCreation({
      category:             normalizeCategory(proposal.category),
      closeTime:            new Date(proposal.expiry_timestamp * 1000),
      p:                    proposal.initial_yes_probability,
      ci:                   proposal.confidence_interval,
      llmSuggestedSeedUsdc: proposal.minimum_liquidity_usdc,
    });
    if (decision.action === 'skip') {
      logger.warn({ reason: decision.reason, question: proposal.market_question }, 'Market Maker Agent: seed policy skipped creation');
      await writeAgentLog({
        agentType: 'MARKET_MAKER',
        level:     'WARN',
        action:    'SEED_SKIPPED',
        data:      { reason: decision.reason, question: proposal.market_question, inputs: decision.inputs },
      }).catch(() => {});
      return null;
    }
    const seedPolicy = seedPolicyRecord(decision);

    signal.throwIfAborted();

    // Step 5: Persist market to DB (PENDING until it exists on-chain). It opens
    // at the adjusted price, and minimumLiquidity records the decided seed.
    const created = await createMarketFromProposal({
      ...proposal,
      initial_yes_probability: decision.pAdj,
      minimum_liquidity_usdc:  toDisplayUsdc(decision.seedRaw),
    }, proposalProvenance, resolutionDetails);
    const market = await prisma.market.update({ where: { id: created.id }, data: { seedPolicy: seedPolicy as object } });
    logger.info({ marketId: market.id, category: market.category }, 'Market Maker Agent: market created in DB');

    // Step 6: Commit the resolution spec and create the market through the
    // treasury. dry-run simulates; the market then stays PENDING.
    // Note: Do not abort between a chain submission and its DB write.
    let onChainMarketId: bigint | null = null;
    try {
      const result = await createMarketOnChain(market, marketSpec, { seedRaw: decision.seedRaw, initialYesBps: decision.initialYesBps });
      if (result.mode === 'live') onChainMarketId = result.value;
    } catch (err) {
      // #40: a transient/ambiguous failure leaves the market PENDING rather than
      // FAILED; only a permanent classification would need operator repair.
      const failureClass = err instanceof TransactionError ? (err.details as { failureClass?: string } | undefined)?.failureClass : undefined;
      logger.error({ err, marketId: market.id, failureClass }, 'Market Maker Agent: on-chain creation failed; market stays PENDING');
    }

    signal.throwIfAborted();

    // Step 7: Reasoning trace for the creation decision
    const { trace, tracePayload } = await generateReasoningTrace({
      marketId:            market.id,
      agentType:           'MARKET_MAKER',
      decisionType:        'MARKET_CREATION',
      // The evidence the proposal cites (#73), each with its signal id and link;
      // the top news items when it cited none we can resolve.
      sourcesUsed:         evidenceFromSignals(groundingSignals.length > 0 ? groundingSignals : signals.news.slice(0, 3)),
      probabilityEstimate: proposal.initial_yes_probability,
      marketProbability:   decision.pAdj,
      edge:                proposal.initial_yes_probability - decision.pAdj,
      confidenceInterval:  proposal.confidence_interval,
      seedPolicy,
    }, { purpose: priority === 'admin' ? 'admin_trace_hedge' : 'trace_hedge', priority }, {
      // Who proposed the market comes first in the trace's provenance (#66).
      upstreamProvenance: [proposalProvenance],
    });

    signal.throwIfAborted();

    // Step 8: Queue the trace for pinning + publication to reasoning-registry.
    // The queue publishes it once the market is on-chain (#131). The payload is
    // fixed now: re-pinning later with a new onChainMarketId would change traceHash.
    try {
      await enqueueTracePublication({
        traceId: trace.id,
        payload: { ...tracePayload, onChainMarketId: onChainMarketId?.toString() ?? null },
        action: TRACE_ACTIONS.createMarket,
      });
    } catch (err) {
      logger.error({ err, traceId: trace.id }, 'Market Maker Agent: failed to queue trace publication');
    }

    logger.info({ marketId: market.id, traceId: trace.id }, 'Market Maker Agent: cycle complete');
    await getLlmUsage()
      .then((usage) => logger.info({ usage }, 'LLM usage after cycle'))
      .catch(() => undefined);

    return {
      marketId: market.id,
      question: market.question,
      category: String(market.category),
      onChainMarketId: onChainMarketId?.toString() ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'Market Maker Agent: unhandled cycle error');

    await writeAgentLog({
      agentType: 'MARKET_MAKER',
      level:     'ERROR',
      action:    'CYCLE_FAILED',
      error:     String(err),
    }).catch(() => {});

    throw err; // Re-throw so the job tracker records FAILED status
  } finally {
    handle.cleanup?.();
  }
}
