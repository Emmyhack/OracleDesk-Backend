/** Small statistics helpers shared by the evaluation harness (#67) and calibration (#68). */

export interface Interval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion. `n` may be fractional (an
 * effective sample size). Returns [0, 1] when there is no data.
 * https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
 */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (!(n > 0)) return { lower: 0, upper: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}
