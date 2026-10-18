import type { KellyResult, KellyInput } from '../types';

// ─── Risk constants ───
const MAX_SINGLE_POSITION_PCT  = 0.025;  // 2.5% of bankroll per position
const MIN_EDGE_THRESHOLD       = 0.08;   // 8 percentage points minimum edge

/**
 * Implements the Half-Kelly Criterion for position sizing.
 *
 * Kelly Formula: f* = (b × p − q) / b
 *   b = net odds (e.g. bet $1 to win $0.67 → b = 0.67)
 *   p = agent's estimated probability of winning
 *   q = 1 - p (probability of losing)
 *
 * Half-Kelly: bet_size = 0.5 × f* × bankroll
 *
 * Why Half-Kelly?
 *   Full Kelly assumes perfect probability estimates. Our estimates have
 *   uncertainty, so we halve the bet size to account for model error.
 *   This cuts expected growth slightly but dramatically reduces ruin risk.
 *
 * Risk caps applied:
 *   - If f* > MAX_SINGLE_POSITION_PCT, cap at MAX_SINGLE_POSITION_PCT
 *   - If edge < MIN_EDGE_THRESHOLD, return 0 (no trade)
 */
export function calculateKellySize(input: KellyInput): KellyResult {
  const { agentProbability: p, marketProbability, bankroll, netOdds: b } = input;
  const q = 1 - p;
  const edge = p - marketProbability;

  // Guard: No trade if edge is below threshold
  if (edge < MIN_EDGE_THRESHOLD) {
    return { fraction: 0, halfKelly: 0, betSize: 0, edge, odds: b };
  }

  // Kelly formula
  const rawFraction = (b * p - q) / b;

  // Negative Kelly = no edge — never bet
  if (rawFraction <= 0) {
    return { fraction: 0, halfKelly: 0, betSize: 0, edge, odds: b };
  }

  // Apply Half-Kelly and cap at max single position size
  const halfKelly = Math.min(rawFraction * 0.5, MAX_SINGLE_POSITION_PCT);
  const betSize   = halfKelly * bankroll;

  return {
    fraction:  parseFloat(rawFraction.toFixed(4)),
    halfKelly: parseFloat(halfKelly.toFixed(4)),
    betSize:   parseFloat(betSize.toFixed(2)),
    edge:      parseFloat(edge.toFixed(4)),
    odds:      b,
  };
}
