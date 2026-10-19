import { prisma } from '../lib/prisma';
import { callLLMStructured } from '../lib/llm';
import { LlmBudgetExceeded, type CallContext } from '../lib/llm-budget';
import { traceReasoningSchema, traceReasoningSpec } from '../lib/llm-schema';
import { hedgeConditionsV1 } from '../lib/prompts';
import { buildTraceProvenance, type ProvenanceEntry } from '../lib/llm/provenance';
import { renderUntrustedBlock, sanitizeSignal } from './llm-guard.service';
import { logger } from '../lib/logger';
import { Prisma } from '@prisma/client';
import type {
  AggregatedSignal,
  TraceInput,
  WeightedSignal,
  ConfidenceInterval,
} from '../types';
import { now as clockNow } from '../lib/clock';
import { AppError } from '../middlewares/error.middleware';

// The hedge-condition schema lives in src/lib/llm-schema.ts; re-exported here.
export { traceReasoningSchema };

/**
 * Generates a full structured reasoning trace for an agent decision.
 *
 * Flow:
 * 1. Compute edge  (agent prob − market prob)
 * 2. 90% confidence interval: the forecaster's own interval when the input
 *    carries a forecast (#75), otherwise jackknife over the sources
 * 3. Call Claude/Gemini to generate hedge conditions and reasoning narrative
 * 4. Record provenance (#66): who produced the market proposal (when the
 *    caller passes it) and the hedge conditions, as `tracePayload.provenance`.
 *    It is part of the pinned bytes, so it is committed with the trace.
 * 5. Persist to DB. The hash is computed later, over the exact bytes pinned
 *    to IPFS (services/trace-publish.service.ts), never over this object.
 */
export async function generateReasoningTrace(
  input: TraceInput,
  ctx: CallContext = { purpose: 'trace_hedge', priority: 'cron' },
  opts: { upstreamProvenance?: ProvenanceEntry[] } = {},
) {
  const edge = calculateEdge(input.probabilityEstimate, input.marketProbability);
  // A forecast-driven decision (#75) already has a calibrated interval; the
  // jackknife over sourcesUsed would only echo the signals' rawValues.
  const ci   = input.forecast
    ? input.confidenceInterval
    : calculateConfidenceInterval(input.sourcesUsed, input.probabilityEstimate);

  const hedgeConditions = await generateHedgeConditions(input, edge, ci, ctx);

  // Upstream first (the proposal precedes the hedge call). Throws on anything
  // canonicalJson would encode differently from the contracts repo.
  const provenance = buildTraceProvenance([...(opts.upstreamProvenance ?? []), hedgeConditions.provenance]);

  const tracePayload: Record<string, unknown> = {
    agentType:           input.agentType,
    decisionType:        input.decisionType,
    marketId:            input.marketId,
    sourcesUsed:         input.sourcesUsed,
    probabilityEstimate: input.probabilityEstimate,
    marketProbability:   input.marketProbability,
    edge,
    confidenceInterval:  ci,
    betFraction:         input.betFraction,
    betSizeUsdc:         input.betSizeUsdc,
    correlation:         input.correlation,
    seedPolicy:          input.seedPolicy,
    forecast:            input.forecast,
    sizing:              input.sizing,
    hedgeConditions:     hedgeConditions.conditions,
    provenance,
    agentWallet:         input.agentWallet,
    timestamp:           clockNow().toISOString(),
  };

  // The free preview names the source and headline only; links and ids are
  // part of the paid trace (#73).
  const previewSources = input.sourcesUsed.slice(0, 2).map((s) => ({
    source: s.source,
    publisher: s.publisher ?? null,
    signal: s.signal,
  }));

  const trace = await prisma.reasoningTrace.create({
    data: {
      marketId:            input.marketId,
      agentType:           input.agentType,
      decisionType:        input.decisionType,
      sourcesUsed:         input.sourcesUsed as any,
      probabilityEstimate: input.probabilityEstimate,
      marketProbability:   input.marketProbability,
      edge,
      confidenceInterval:  ci as Prisma.InputJsonValue,
      betFraction:         input.betFraction,
      betSizeUsdc:         input.betSizeUsdc,
      hedgeConditions:     hedgeConditions.conditions as any,
      provenance:          provenance as unknown as Prisma.InputJsonValue,
      agentWallet:         input.agentWallet,
      previewSources:      previewSources as any,
      verified:            false,
      isPublic:            false,
    },
  });

  logger.info({ traceId: trace.id, edge, marketId: input.marketId }, 'Reasoning trace generated');
  return { trace, tracePayload: { ...tracePayload, traceId: trace.id } };
}

/**
 * Trace evidence from store-backed signals (#73): each entry carries the
 * signal's id, link, publisher and publication time, and its weight is the
 * aggregator's relevance score. Readers must treat these fields as optional:
 * traces written before the signal store have only {source, weight, signal}.
 */
export function evidenceFromSignals(signals: AggregatedSignal[]): WeightedSignal[] {
  return signals.map((s) => ({
    source: s.source,
    weight: s.relevanceScore,
    signal: s.title,
    ...(s.signalId ? { signalId: s.signalId } : {}),
    ...(s.url ? { url: s.url } : {}),
    publisher: s.publisher ?? null,
    publishedAt: s.publishedAt,
  }));
}

/**
 * Edge = agent probability − market implied probability.
 *
 * edge > 0.08  → market under-prices YES → agent bets YES
 * edge < -0.08 → market over-prices YES  → agent bets NO
 * |edge| < 0.08 → no actionable mispricing
 */
export function calculateEdge(agentProb: number, marketProb: number): number {
  return parseFloat((agentProb - marketProb).toFixed(4));
}

/**
 * Jackknife 90% confidence interval.
 */
export function calculateConfidenceInterval(
  signals: WeightedSignal[],
  centralEstimate: number,
): ConfidenceInterval {
  if (signals.length < 2) {
    return {
      lower: Math.max(0.01, centralEstimate - 0.10),
      upper: Math.min(0.99, centralEstimate + 0.10),
    };
  }

  const jackknife: number[] = [];

  for (let i = 0; i < signals.length; i++) {
    const subset = signals.filter((_, idx) => idx !== i);
    const totalW = subset.reduce((acc, s) => acc + s.weight, 0);
    if (totalW === 0) continue;

    const signal      = signals[i];
    const leaveOneOut =
      (centralEstimate * (totalW + signal.weight) -
        (signal.rawValue ?? centralEstimate) * signal.weight) /
      totalW;
    jackknife.push(Math.min(0.99, Math.max(0.01, leaveOneOut)));
  }

  if (jackknife.length === 0) {
    return {
      lower: Math.max(0.01, centralEstimate - 0.10),
      upper: Math.min(0.99, centralEstimate + 0.10),
    };
  }

  jackknife.sort((a, b) => a - b);

  const lowerIdx = Math.floor(0.05 * jackknife.length);
  const upperIdx = Math.ceil(0.95  * jackknife.length) - 1;

  return {
    lower: jackknife[lowerIdx] ?? centralEstimate - 0.08,
    upper: jackknife[upperIdx] ?? centralEstimate + 0.08,
  };
}

/**
 * Uses Claude/Gemini to generate specific, measurable hedge conditions.
 *
 * This is a secondary LLM call after market creation. It is intentionally
 * non-blocking: if the LLM call fails for any reason (quota, timeout, etc.)
 * we return safe defaults so the market creation cycle always completes.
 */
async function generateHedgeConditions(
  input: TraceInput,
  edge:  number,
  ci:    ConfidenceInterval,
  ctx:   CallContext,
): Promise<{
  conditions: string[];
  reasoning: string;
  provenance: ProvenanceEntry;
}> {
  // Signal text comes from headlines: sanitise it and send it as delimited data.
  const topSignals = input.sourcesUsed.slice(0, 3).map((s, i) => ({
    ...sanitizeSignal({
      source: String(s.source), title: String(s.signal), content: '',
      publishedAt: '', relevanceScore: Number(s.weight) || 0, category: '',
    }),
    id: `s${i + 1}`,
  }));

  const { system, user } = hedgeConditionsV1.render({
    marketId: input.marketId,
    agentType: input.agentType,
    decisionType: input.decisionType,
    probabilityEstimate: input.probabilityEstimate,
    marketProbability: input.marketProbability,
    edge,
    ci: `${ci.lower.toFixed(3)} – ${ci.upper.toFixed(3)}`,
    betFraction: String(input.betFraction ?? 'N/A'),
    signalsBlock: renderUntrustedBlock(topSignals, 'untrusted_signals'),
  });

  const fallback = (reason: 'LLM_FAILED' | 'LLM_BUDGET_EXCEEDED') => ({
    conditions: [
      `Close if market probability rises above ${(input.probabilityEstimate + 0.10).toFixed(2)}`,
      `Close if primary signal source reverses direction`,
      `Hard stop-loss at 15% adverse market move`,
    ],
    reasoning: 'Default hedge conditions applied — LLM call failed',
    // No model produced these: marked as such, with no model fields (#66).
    provenance: {
      source: 'default' as const,
      promptId: hedgeConditionsV1.id,
      promptVersion: hedgeConditionsV1.version,
      reason,
    },
  });

  try {
    const result = await callLLMStructured(
      traceReasoningSpec,
      { system, user },
      {
        maxTokens: 1024,
        ctx,
        task: 'hedge_conditions',
        prompt: { id: hedgeConditionsV1.id, version: hedgeConditionsV1.version, hash: hedgeConditionsV1.contentHash },
      },
    );
    const validated = result.value;
    return {
      conditions: validated.hedge_conditions,
      reasoning: validated.reasoning_summary,
      provenance: result.provenance,
    };
  } catch (err) {
    // Non-fatal: log a warning but never fail the whole market creation cycle
    // A spent budget is expected, not an error: defaults keep the cycle going.
    if (err instanceof LlmBudgetExceeded) {
      logger.warn('LLM budget exhausted — applying default hedge conditions');
      return fallback('LLM_BUDGET_EXCEEDED');
    }
    logger.warn({ err }, 'LLM hedge condition generation failed — applying safe defaults');
    return fallback('LLM_FAILED');
  }
}
