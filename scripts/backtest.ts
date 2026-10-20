/**
 * Replays indexed history through the trader policy and writes a report.
 *
 *   npm run backtest -- --from 2026-10-01 --to 2026-10-15 --out ./bt
 *   npm run backtest -- --events-file tests/fixtures/backtest/events.json --out /tmp/bt
 *
 * Read-only against the database: it only issues findMany. See
 * docs/architecture.md ("Backtesting") for the options and how to read the report.
 */
// The policy modules read config at import time; a backtest must never reach a chain or a real database.
process.env.CHAIN_EXECUTION_MODE = 'dry-run';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://backtest:backtest@127.0.0.1:5432/backtest';

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { USDC_UNIT } from '../src/lib/amounts';
import { logger } from '../src/lib/logger';
import { DEFAULT_PARAMS } from '../src/agents/trader-policy';
import { runBacktest } from '../src/backtest/engine';
import { renderMarkdown, reportJson } from '../src/backtest/report';
import type { BacktestConfig, BacktestInputs, HistoryEvent, ImpactMode, RecordedForecast, SignalRecord } from '../src/backtest/types';

const HELP = `Usage: backtest [options]
  --from <iso|date>         start of the evaluated range (UTC)            required; with --events-file
  --to <iso|date>           end of the range (UTC)                        defaults to the file's span
  --bankroll-raw <n>        treasury cash, 7-decimal base units           default 10000 USDC
  --max-trade-raw <n>       treasury max_trade                            default 500 USDC
  --max-market-raw <n>      treasury max_market                           default 1000 USDC
  --max-daily-raw <n>       treasury max_daily (rolling 24 h)             default 2000 USDC
  --impact <mode>           reset | propagate | both                      default both
  --forecaster <spec>       prior | oracle-noise:<sigma> | recorded       default prior
  --seed <n>                PRNG seed                                     default 1
  --fee-bps <n>             pool fee (default: inferred from history)
  --events-file <path>      offline JSON input instead of the database
  --out <dir>               where report.json and report.md go            default ./backtest-out
`;

function parseTime(label: string, value: string | undefined): string {
  if (!value) throw new Error(`--${label} is required`);
  const t = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(t.getTime())) throw new Error(`--${label}: not a date: ${value}`);
  return t.toISOString();
}

/** The day the first event falls on, through the first 15-minute step after the last one. */
function eventSpan(events: HistoryEvent[]): { from: string; to: string } | null {
  if (events.length === 0) return null;
  const times = events.map((e) => new Date(e.ledgerClosedAt).getTime());
  const day = 24 * 60 * 60 * 1000;
  const step = 15 * 60 * 1000;
  return {
    from: new Date(Math.floor(Math.min(...times) / day) * day).toISOString(),
    to: new Date((Math.floor(Math.max(...times) / step) + 1) * step).toISOString(),
  };
}

function raw(value: string | undefined, fallbackUsdc: number): bigint {
  if (value === undefined) return BigInt(fallbackUsdc) * USDC_UNIT;
  if (!/^\d+$/.test(value)) throw new Error(`expected an integer in base units, got "${value}"`);
  return BigInt(value);
}

function loadFile(file: string): BacktestInputs {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(json)) return { events: json, signals: [], forecasts: [] };
  return { events: json.events ?? [], signals: json.signals ?? [], forecasts: json.forecasts ?? [] };
}

/** Everything up to `to`: pools must be rebuilt from MarketCreated and earlier trades. Read-only. */
async function loadDatabase(to: Date): Promise<BacktestInputs> {
  const { prisma } = await import('../src/lib/prisma');
  try {
    const rows = await prisma.chainEvent.findMany({
      where: { contractName: 'marketCore', eventName: { in: ['MarketCreated', 'Trade', 'MarketResolved'] }, ledgerClosedAt: { lte: to } },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });
    const events: HistoryEvent[] = rows.map((r) => ({
      id: r.id, eventName: r.eventName, ledger: r.ledger, ledgerClosedAt: r.ledgerClosedAt.toISOString(), params: r.params as Record<string, any>,
    }));
    const cached = await prisma.signalCache.findMany({ where: { fetchedAt: { lte: to } }, orderBy: { fetchedAt: 'asc' } });
    const signals: SignalRecord[] = cached.map((s) => ({
      source: s.source, fetchedAt: s.fetchedAt.toISOString(), payload: Array.isArray(s.payload) ? (s.payload as any[]) : [],
    }));
    const traces = await prisma.reasoningTrace.findMany({
      where: { agentType: 'TRADER', createdAt: { lte: to }, market: { onChainMarketId: { not: null } } },
      select: { probabilityEstimate: true, confidenceInterval: true, createdAt: true, market: { select: { onChainMarketId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const forecasts: RecordedForecast[] = traces.map((t) => ({
      marketId: String(t.market.onChainMarketId), at: t.createdAt.toISOString(), p: t.probabilityEstimate,
      ci: t.confidenceInterval as { lower: number; upper: number },
    }));
    return { events, signals, forecasts };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  logger.level = 'warn'; // the policy logs every cycle; a replay runs hundreds
  const { values } = parseArgs({
    options: {
      from: { type: 'string' }, to: { type: 'string' }, 'bankroll-raw': { type: 'string' }, 'max-trade-raw': { type: 'string' },
      'max-market-raw': { type: 'string' }, 'max-daily-raw': { type: 'string' }, impact: { type: 'string' }, forecaster: { type: 'string' },
      seed: { type: 'string' }, 'fee-bps': { type: 'string' }, 'events-file': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help) { process.stdout.write(HELP); return; }

  const file = values['events-file'] ? loadFile(values['events-file']) : null;
  const span = file ? eventSpan(file.events) : null;
  const from = values.from || !span ? parseTime('from', values.from) : span.from;
  const to = values.to || !span ? parseTime('to', values.to) : span.to;
  if (new Date(from) >= new Date(to)) throw new Error('--from must be before --to');

  const impactArg = values.impact ?? 'both';
  if (!['reset', 'propagate', 'both'].includes(impactArg)) throw new Error('--impact must be reset, propagate or both');
  const impacts: ImpactMode[] = impactArg === 'both' ? ['reset', 'propagate'] : [impactArg as ImpactMode];

  const bankrollRaw = raw(values['bankroll-raw'], 10_000);
  const cfg: BacktestConfig = {
    from, to, stepMinutes: 15, bankrollRaw,
    maxTradeRaw: raw(values['max-trade-raw'], 500),
    maxMarketRaw: raw(values['max-market-raw'], 1_000),
    maxDailyRaw: raw(values['max-daily-raw'], 2_000),
    forecaster: values.forecaster ?? 'prior',
    seed: Number(values.seed ?? 1),
    feeBps: values['fee-bps'] === undefined ? undefined : Number(values['fee-bps']),
    // The policy sizes from the simulated treasury's cash and caps (#76).
    params: DEFAULT_PARAMS,
  };
  if (!Number.isInteger(cfg.seed)) throw new Error('--seed must be an integer');

  const inputs = file ?? await loadDatabase(new Date(to));
  if (inputs.events.length === 0) throw new Error('no market-core events in the input: nothing to replay');

  const report = await runBacktest(inputs, cfg, { impacts });
  const out = values.out ?? './backtest-out';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), reportJson(report));
  fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(report));
  process.stdout.write(`${renderMarkdown(report)}\nWrote ${path.join(out, 'report.json')} and report.md\n`);
}

main().then(() => process.exit(0)).catch((err) => {
  process.stderr.write(`backtest: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
