/**
 * YES-price series per on-chain market, rebuilt from stored market-core
 * events (#80). Every Trade carries the pool reserves after the trade, so the
 * price path is `priceYesBps(reserve_yes, reserve_no)` at ledgerClosedAt;
 * MarketCreated gives the opening price and MarketResolved ends the series.
 *
 * Only internal series live here; a public candle endpoint is a separate
 * issue and should reuse `seriesFromRows`.
 */
import { prisma } from '../lib/prisma';
import { CONTRACTS } from '../config/contracts';
import { priceYesBps } from '../generated/fpmm';

export interface PricePoint {
  /** Ledger close time, epoch seconds. */
  t: number;
  yesBps: number;
  ledger: number;
  /**
   * True when an external (non-treasury) trade is part of this point. Only
   * those points count as activity when estimating correlations: the agent's
   * own trades move prices too, and two markets it bought at the same time
   * would otherwise look correlated.
   */
  active: boolean;
  kind: 'created' | 'trade' | 'resolved';
}

export interface EventRow {
  id: string;
  eventName: string;
  ledger: number;
  ledgerClosedAt: Date | string;
  params: Record<string, any>;
}

const secs = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Builds the series from event rows (any order). Several events in one ledger
 * collapse to the last one by event id; `active` survives the collapse if any
 * of them was an external trade. Params are decimal strings, so they go
 * through BigInt, never Number.
 */
export function seriesFromRows(rows: EventRow[], treasury: string = CONTRACTS.treasury): PricePoint[] {
  const sorted = [...rows].sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const points: PricePoint[] = [];

  for (const row of sorted) {
    const p = row.params ?? {};
    let point: PricePoint;
    if (row.eventName === 'MarketCreated') {
      point = { t: secs(row.ledgerClosedAt), yesBps: Number(BigInt(p.initial_yes_bps)), ledger: row.ledger, active: false, kind: 'created' };
    } else if (row.eventName === 'Trade') {
      const yesBps = Number(priceYesBps(BigInt(p.reserve_yes), BigInt(p.reserve_no)));
      point = { t: secs(row.ledgerClosedAt), yesBps, ledger: row.ledger, active: p.trader !== treasury, kind: 'trade' };
    } else if (row.eventName === 'MarketResolved') {
      // Voided markets (outcome: null) end the series the same way.
      point = { t: secs(row.ledgerClosedAt), yesBps: 0, ledger: row.ledger, active: false, kind: 'resolved' };
    } else {
      continue;
    }

    const last = points[points.length - 1];
    if (last && last.ledger === point.ledger && last.kind !== 'resolved' && point.kind !== 'resolved') {
      point.active = point.active || last.active;
      points[points.length - 1] = point;
    } else {
      points.push(point);
    }
  }
  return points;
}

/**
 * Loads one market's series: its MarketCreated and MarketResolved events, the
 * trades since `since`, and the last trade before it (so the level at the
 * start of the window is the real one, not the opening price). Backed by the
 * partial expression index chain_events_trade_market_ledger.
 */
export async function loadPriceSeries(onChainMarketId: bigint, since: Date): Promise<PricePoint[]> {
  const id = onChainMarketId.toString();
  const rows = await prisma.$queryRaw<EventRow[]>`
    (SELECT "id", "eventName", "ledger", "ledgerClosedAt", "params" FROM chain_events
      WHERE "contractName" = 'marketCore' AND "eventName" IN ('MarketCreated', 'MarketResolved')
        AND (params->>'market_id')::numeric = ${id}::numeric)
    UNION ALL
    (SELECT "id", "eventName", "ledger", "ledgerClosedAt", "params" FROM chain_events
      WHERE "contractName" = 'marketCore' AND "eventName" = 'Trade'
        AND (params->>'market_id')::numeric = ${id}::numeric AND "ledgerClosedAt" >= ${since})
    UNION ALL
    (SELECT "id", "eventName", "ledger", "ledgerClosedAt", "params" FROM chain_events
      WHERE "contractName" = 'marketCore' AND "eventName" = 'Trade'
        AND (params->>'market_id')::numeric = ${id}::numeric AND "ledgerClosedAt" < ${since}
      ORDER BY "ledger" DESC, "id" DESC LIMIT 1)
  `;
  return seriesFromRows(rows);
}

function resolutionTime(points: PricePoint[]): number {
  return points.find((p) => p.kind === 'resolved')?.t ?? Infinity;
}

/**
 * Last-observation-carried-forward values at the grid times start,
 * start+step, … ≤ end. `null` before the first point and from the
 * resolution on, so the jump to 0/10 000 never enters a window.
 */
export function resample(points: PricePoint[], start: number, end: number, stepSecs: number): Array<number | null> {
  const resolvedAt = resolutionTime(points);
  const levels = points.filter((p) => p.kind !== 'resolved');
  const out: Array<number | null> = [];
  let i = 0;
  let current: number | null = null;
  for (let g = start; g <= end; g += stepSecs) {
    while (i < levels.length && levels[i].t <= g) current = levels[i++].yesBps;
    out.push(g >= resolvedAt ? null : current);
  }
  return out;
}

/**
 * For each interval (g[k-1], g[k]] of the grid, whether an external trade
 * happened in it. Carried-forward values give zero returns that would bias
 * correlations toward 0, so only active intervals are used.
 */
export function activeIntervals(points: PricePoint[], start: number, end: number, stepSecs: number): boolean[] {
  const resolvedAt = resolutionTime(points);
  const out: boolean[] = [];
  for (let g = start + stepSecs; g <= end; g += stepSecs) {
    const lo = g - stepSecs;
    out.push(g < resolvedAt && points.some((p) => p.active && p.t > lo && p.t <= g));
  }
  return out;
}
