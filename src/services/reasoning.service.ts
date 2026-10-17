import { prisma } from '../lib/prisma';
import { completeLLM } from '../lib/llm';
import { logger } from '../lib/logger';
import { Prisma } from '@prisma/client';
import type {
  TraceInput,
  WeightedSignal,
  ConfidenceInterval,
} from '../types';
import { AppError } from '../middlewares/error.middleware';
import { z } from 'zod';

// ─── Zod schema for LLM hedge condition output ───────────────────────────────
const traceReasoningSchema = z.object({
  hedge_conditions:  z.array(z.string()),
  reasoning_summary: z.string().min(10),
  key_signals:       z.array(z.string()),
  risk_factors:      z.array(z.string()),
});

/**
 * Generates a full structured reasoning trace for an agent decision.
 *
 * Flow:
 * 1. Compute edge  (agent prob − market prob)
 * 2. Compute 90% confidence interval via jackknife sampling
 * 3. Call Claude/Gemini to generate hedge conditions and reasoning narrative
 * 4. Persist to DB. The hash is computed later, over the exact bytes pinned
 *    to IPFS (services/trace-publish.service.ts), never over this object.
 */
export async function generateReasoningTrace(input: TraceInput) {
  const edge = calculateEdge(input.probabilityEstimate, input.marketProbability);
  const ci   = calculateConfidenceInterval(input.sourcesUsed, input.probabilityEstimate);

  const hedgeConditions = await generateHedgeConditions(input, edge, ci);

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
    hedgeConditions:     hedgeConditions.conditions,
    // Optional, explicitly null-able provenance so payload hashing is stable.
    llm:                 hedgeConditions.provenance,
    agentWallet:         input.agentWallet,
    timestamp:           new Date().toISOString(),
  };

  const previewSources = input.sourcesUsed.slice(0, 2);

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
): Promise<{
  conditions: string[];
  reasoning: string;
  provenance: { provider: string; model: string } | null;
}> {
  const systemPrompt = `You are a quantitative prediction market risk manager.
Generate specific, measurable hedge conditions for a trading position.
Return ONLY a valid JSON object matching this schema exactly. No markdown, no preamble.
{
  "hedge_conditions": ["string"],
  "reasoning_summary": "string",
  "key_signals": ["string"],
  "risk_factors": ["string"]
}`;

  const userPrompt = `
Market ID:          ${input.marketId}
Agent Type:         ${input.agentType}
Decision:           ${input.decisionType}
Agent Probability:  ${input.probabilityEstimate}
Market Probability: ${input.marketProbability}
Edge:               ${edge}
CI:                 ${ci.lower.toFixed(3)} – ${ci.upper.toFixed(3)}
Bet Fraction:       ${input.betFraction ?? 'N/A'}

Top signals driving this decision:
${input.sourcesUsed
  .slice(0, 3)
  .map(s => `  - ${s.source} (weight ${s.weight}): ${s.signal}`)
  .join('\n')}

Write 3–5 specific, measurable conditions that would invalidate this trade thesis
and trigger an early close. Focus on data changes, not price changes.
`;

  try {
    const result = await completeLLM({
      task: 'hedge_conditions',
      system: systemPrompt,
      user: userPrompt,
      mode: 'json',
      maxTokens: 1024,
    });
    const parsed    = JSON.parse(result.text);
    const validated = traceReasoningSchema.parse(parsed);
    return {
      conditions: validated.hedge_conditions,
      reasoning: validated.reasoning_summary,
      provenance: { provider: result.provenance.provider, model: result.provenance.model },
    };
  } catch (err) {
    // Non-fatal: log a warning but never fail the whole market creation cycle
    logger.warn({ err }, 'LLM hedge condition generation failed — applying safe defaults');
    return {
      conditions: [
        `Close if market probability rises above ${(input.probabilityEstimate + 0.10).toFixed(2)}`,
        `Close if primary signal source reverses direction`,
        `Hard stop-loss at 15% adverse market move`,
      ],
      reasoning: 'Default hedge conditions applied — LLM call failed',
      provenance: null,
    };
  }
}