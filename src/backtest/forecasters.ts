/**
 * Deterministic stand-ins for the LLM-dependent estimate in backtests.
 *
 *   prior              the market's opening price
 *   oracle-noise:σ     the resolved outcome plus Gaussian noise: an upper bound
 *                      on skill, since it reads the future by construction
 *   recorded           the forecast the live agent stored at that time, if any
 *
 * Noise is seeded from (seed, market, time), so a draw does not depend on how
 * many other forecasts were requested before it.
 */
import { gaussian, hashSeed, mulberry32 } from './rng';
import type { RecordedForecast } from './types';

export interface ForecastQuery {
  /** On-chain market id as a decimal string. */
  marketId: string;
  initialYesProb: number;
  now: Date;
  /** What the market resolves to; read only by oracle-noise. */
  outcome: 'Yes' | 'No' | 'Void' | null;
}

export interface BacktestForecast {
  p: number;
  ci: { lower: number; upper: number };
}

export type Forecaster = (q: ForecastQuery) => BacktestForecast | null;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const HALF_WIDTH = 0.1;

function around(p: number): BacktestForecast {
  const centre = clamp(p, 0.01, 0.99);
  return { p: centre, ci: { lower: clamp(centre - HALF_WIDTH, 0.01, 0.99), upper: clamp(centre + HALF_WIDTH, 0.01, 0.99) } };
}

export function parseForecaster(spec: string, seed: number, recorded: RecordedForecast[] = []): Forecaster {
  if (spec === 'prior') return (q) => around(q.initialYesProb);

  const noise = /^oracle-noise:(\d+(?:\.\d+)?)$/.exec(spec);
  if (noise) {
    const sigma = Number(noise[1]);
    return (q) => {
      const truth = q.outcome === 'Yes' ? 1 : q.outcome === 'No' ? 0 : 0.5;
      const z = sigma === 0 ? 0 : gaussian(mulberry32(hashSeed(seed, q.marketId, q.now.getTime())));
      return around(truth + sigma * z);
    };
  }

  if (spec === 'recorded') {
    const byMarket = new Map<string, RecordedForecast[]>();
    for (const f of [...recorded].sort((a, b) => a.at.localeCompare(b.at))) {
      byMarket.set(f.marketId, [...(byMarket.get(f.marketId) ?? []), f]);
    }
    return (q) => {
      const known = (byMarket.get(q.marketId) ?? []).filter((f) => new Date(f.at).getTime() <= q.now.getTime());
      const last = known[known.length - 1];
      if (!last) return null;
      return { p: clamp(last.p, 0.01, 0.99), ci: last.ci ?? around(last.p).ci };
    };
  }

  throw new Error(`Unknown forecaster "${spec}" (use prior, oracle-noise:<sigma> or recorded)`);
}
