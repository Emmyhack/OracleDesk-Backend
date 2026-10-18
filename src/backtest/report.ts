import { formatUsdc } from '../lib/amounts';
import { canonicalJson } from '../utils/hash.util';
import type { BacktestReport, RunReport } from './types';

/** Byte-stable JSON: canonical key order, bigints already strings. */
export function reportJson(report: BacktestReport): string {
  return `${canonicalJson(report)}\n`;
}

const usdc = (raw: string) => formatUsdc(BigInt(raw));
const pct = (x: number) => `${x.toFixed(2)}%`;
const num = (x: number | null, digits = 3) => (x === null ? 'n/a' : x.toFixed(digits));

function runSection(run: RunReport): string {
  const s = run.summary;
  const caps = Object.entries(s.capHits).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const lines = [
    `## Impact model: \`${run.impact}\``,
    '',
    run.impact === 'reset'
      ? '_Optimistic upper bound: after each external trade the pool snaps back to the historical reserves, so the agent\'s impact decays instantly._'
      : '_External trades are re-executed on the simulated pool, so the agent\'s own impact persists._',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| PnL | ${usdc(s.pnlRaw)} USDC (${pct(s.returnPct)}) |`,
    `| Start / end equity | ${usdc(s.startEquityRaw)} / ${usdc(s.endEquityRaw)} USDC |`,
    `| Max drawdown | ${usdc(s.maxDrawdownRaw)} USDC (${pct(s.maxDrawdownPct)}) |`,
    `| Sharpe-like (daily, annualised) | ${num(s.sharpeLike, 2)} |`,
    `| Turnover | ${usdc(s.turnoverRaw)} USDC (${num(s.turnoverMultiple, 2)}× starting equity) |`,
    `| Entries / hedges | ${s.buys} / ${s.hedges} |`,
    `| Closed / still open | ${s.closedPositions} / ${s.openAtEnd} |`,
    `| Win rate (closed) | ${s.winRate === null ? 'n/a' : pct(s.winRate * 100)} |`,
    `| Stop-losses | ${s.stopLossCount} |`,
    `| Daily-drawdown pause cycles | ${s.drawdownPauses} |`,
    `| Cap hits | ${caps} |`,
    `| Avg edge at entry | ${num(s.avgEdgeAtEntry)} |`,
    `| Forecast vs realised edge (resolved) | ${num(s.avgForecastEdgeResolved)} vs ${num(s.avgRealisedEdgeResolved)} |`,
    `| Impact cost (fill vs mid, fees included) | ${usdc(s.impactCostRaw)} USDC |`,
    `| External trades the pool could not fill | ${s.externalTradesSkipped} |`,
    '',
  ];
  if (run.perMarket.length > 0) {
    lines.push('### Per-market attribution', '', '| Market | Positions | PnL (USDC) | Impact cost (USDC) |', '| --- | --- | --- | --- |');
    for (const m of run.perMarket) lines.push(`| ${m.marketId} | ${m.trades} | ${usdc(m.pnlRaw)} | ${usdc(m.impactCostRaw)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderMarkdown(report: BacktestReport): string {
  const c = report.config as Record<string, any>;
  const header = [
    '# Backtest report',
    '',
    `Range: ${c.from} → ${c.to} (UTC, every ${c.stepMinutes} min) · forecaster \`${c.forecaster}\` · seed ${c.seed} · pool fee ${c.feeBps} bps`,
    `Treasury caps: max trade ${usdc(String(c.maxTradeRaw))}, max per market ${usdc(String(c.maxMarketRaw))}, max daily ${usdc(String(c.maxDailyRaw))} USDC · bankroll ${usdc(String(c.bankrollRaw))} USDC`,
    '',
    `configHash \`${report.configHash}\``,
    `inputsHash \`${report.inputsHash}\``,
    '',
  ].join('\n');
  return `${header}\n${Object.values(report.runs).map((r) => runSection(r!)).join('\n')}`;
}
