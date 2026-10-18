/**
 * npm run eval:markets [-- --replay | --live] [--record] [--model <name>] [--case <id>] [--no-judge]
 *
 * Exit codes: 0 all thresholds met, 1 a threshold regressed, 2 the run itself
 * failed (for example a recording is missing). --live calls real providers
 * and is never run in CI.
 */
import path from 'node:path';
import { ensureEvalEnv } from './eval/env';

const ROOT = path.join(__dirname, '..');

function parse(argv: string[]) {
  const flag = (n: string) => argv.includes(`--${n}`);
  const value = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (flag('live') && flag('replay')) throw new Error('--live and --replay are mutually exclusive');
  if (flag('record') && !flag('live')) throw new Error('--record needs --live');
  return {
    mode: flag('live') ? ('live' as const) : ('replay' as const),
    record: flag('record'),
    model: value('model') ?? 'synthetic-baseline',
    caseId: value('case'),
    judge: !flag('no-judge'),
  };
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  ensureEvalEnv();
  if (args.mode === 'live') {
    // Live runs use the real keys from the environment and an in-process budget store.
    const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
    setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, process.env[n] ?? ''])) as any);
    const budget = await import('../src/lib/llm-budget');
    budget.setLlmGuardStore(new budget.MemoryGuardStore());
    if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
      console.error('--live needs ANTHROPIC_API_KEY or GEMINI_API_KEY');
      process.exit(2);
    }
  }
  const { runEval } = await import('./eval/runner');
  const outcome = await runEval({
    ...args,
    corpusDir: path.join(ROOT, 'tests/eval/corpus'),
    recordingsDir: path.join(ROOT, 'tests/eval/recordings'),
    thresholdsPath: path.join(ROOT, 'tests/eval/thresholds.json'),
    outDir: path.join(ROOT, 'eval-results'),
  });
  for (const e of outcome.errors) console.error(e);
  if (outcome.report) {
    const { graders } = outcome.report;
    for (const [name, g] of Object.entries(graders)) {
      console.log(`${name.padEnd(18)} ${(g.rate * 100).toFixed(1).padStart(5)}%  (${g.passed}/${g.n})`);
    }
    for (const f of outcome.report.thresholds.failures) {
      console.error(`REGRESSION ${f.grader}: ${(f.rate * 100).toFixed(1)}% < ${(f.threshold * 100).toFixed(1)}%`);
    }
    if (outcome.files) console.log(`\nreport: ${path.relative(ROOT, outcome.files.md)}`);
  }
  process.exit(outcome.exitCode);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(2); });
