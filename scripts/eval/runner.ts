/**
 * Offline evaluation of generated market proposals (#67). The CLI
 * (scripts/eval-markets.ts) is a thin wrapper; the logic lives here so tests
 * can run it in-process.
 *
 * Replay (default) reads recorded model outputs and needs no keys, database or
 * network. --live calls the real providers and, with --record, writes new
 * recordings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from '../../src/utils/hash.util';
import { wilson, type Interval } from '../../src/lib/stats';
import { GRADER_NAMES, gradeCase, type EvalCase, type GradeResult, type GraderName } from './graders';
import { judgePromptV1, judgeSchema, judgeSpec, type JudgeVerdict } from './judge-prompt.v1';
import { loadRecording, promptKey, RecordingMissingError, saveRecording } from './recordings';

export interface EvalOptions {
  mode: 'replay' | 'live';
  record: boolean;
  /** Names the recording set (tests/eval/recordings/<model>/). */
  model: string;
  caseId?: string;
  judge: boolean;
  corpusDir: string;
  recordingsDir: string;
  thresholdsPath: string;
  outDir: string;
  /** Overrides the live transport (tests). */
  transport?: import('../../src/lib/llm').LlmTransport;
}

export interface GraderStats {
  passed: number;
  n: number;
  rate: number;
  wilson95: Interval;
  meanScore: number;
}

export interface CaseOutcome {
  id: string;
  category: string;
  question: string | null;
  grades: Record<GraderName, GradeResult>;
  passedAll: boolean;
  /** Worst-first sort key: failed applicable graders, then lowest mean score. */
  failures: GraderName[];
}

export interface Report {
  meta: {
    mode: 'replay' | 'live';
    model: string;
    provider: string | null;
    generationPrompt: { id: string; version: number; contentHash: string };
    judgePrompt: { id: string; version: number; contentHash: string } | null;
    corpusHash: string;
    caseCount: number;
    gitSha: string | null;
    asOfRange: [string, string];
  };
  graders: Record<GraderName, GraderStats>;
  byCategory: Record<string, Record<GraderName, GraderStats>>;
  overall: { casesPassingAll: number; n: number; rate: number; wilson95: Interval };
  /** Cases where the rule and the judge disagree, reported apart from pass/fail. */
  disagreements: Array<{ id: string; grader: 'binary' | 'resolutionSource'; ruleSaid: boolean; judgeSaid: boolean }>;
  duplicateRate: { flagged: number; n: number; rate: number };
  thresholds: { path: string; values: Partial<Record<GraderName, number>>; failures: Array<{ grader: GraderName; rate: number; threshold: number }> };
  cases: CaseOutcome[];
}

export interface EvalOutcome {
  exitCode: 0 | 1 | 2;
  report: Report | null;
  errors: string[];
  files: { json: string; md: string } | null;
}

const emptyStats = (): GraderStats => ({ passed: 0, n: 0, rate: 0, wilson95: wilson(0, 0), meanScore: 0 });

function aggregate(outcomes: CaseOutcome[]): Record<GraderName, GraderStats> {
  const out = {} as Record<GraderName, GraderStats>;
  for (const name of GRADER_NAMES) {
    const rows = outcomes.map((o) => o.grades[name]).filter((g) => g.applicable);
    if (rows.length === 0) { out[name] = emptyStats(); continue; }
    const passed = rows.filter((g) => g.pass).length;
    out[name] = {
      passed,
      n: rows.length,
      rate: passed / rows.length,
      wilson95: wilson(passed, rows.length),
      meanScore: rows.reduce((a, g) => a + g.score, 0) / rows.length,
    };
  }
  return out;
}

export function loadCorpus(dir: string, only?: string): { cases: EvalCase[]; hash: string } {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const texts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const all = texts.map((t) => JSON.parse(t) as EvalCase);
  const cases = only ? all.filter((c) => c.id === only) : all;
  return { cases, hash: sha256Hex(texts.join('\n')) };
}

function gitSha(): string | null {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function toMarkdown(r: Report): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`# Market generation evaluation`, '');
  lines.push(`- mode: **${r.meta.mode}**, model set: \`${r.meta.model}\`${r.meta.provider ? ` (${r.meta.provider})` : ''}`);
  lines.push(`- generation prompt: \`${r.meta.generationPrompt.id}@${r.meta.generationPrompt.version}\` \`${r.meta.generationPrompt.contentHash.slice(0, 12)}\``);
  lines.push(`- judge prompt: ${r.meta.judgePrompt ? `\`${r.meta.judgePrompt.id}@${r.meta.judgePrompt.version}\` \`${r.meta.judgePrompt.contentHash.slice(0, 12)}\`` : 'not used'}`);
  lines.push(`- corpus: ${r.meta.caseCount} cases, hash \`${r.meta.corpusHash.slice(0, 12)}\`, git \`${r.meta.gitSha ?? 'n/a'}\``, '');
  lines.push('| grader | passed | n | rate | Wilson 95% | threshold | status |', '|---|---|---|---|---|---|---|');
  for (const name of GRADER_NAMES) {
    const g = r.graders[name];
    const t = r.thresholds.values[name];
    const failed = r.thresholds.failures.some((f) => f.grader === name);
    lines.push(`| ${name} | ${g.passed} | ${g.n} | ${pct(g.rate)} | ${pct(g.wilson95.lower)}–${pct(g.wilson95.upper)} | ${t === undefined ? '–' : pct(t)} | ${t === undefined ? '' : failed ? 'FAIL' : 'ok'} |`);
  }
  lines.push('', `Cases passing every grader: ${r.overall.casesPassingAll}/${r.overall.n} (${pct(r.overall.rate)}, Wilson ${pct(r.overall.wilson95.lower)}–${pct(r.overall.wilson95.upper)}).`);
  lines.push(`Proposals flagged as duplicates: ${r.duplicateRate.flagged}/${r.duplicateRate.n}.`);
  lines.push('', '> Small corpora give noisy rates: read the Wilson interval, not just the point estimate.', '');
  lines.push('## By category', '', '| category | cases | ' + GRADER_NAMES.join(' | ') + ' |', '|---|---|' + GRADER_NAMES.map(() => '---').join('|') + '|');
  for (const [cat, stats] of Object.entries(r.byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const n = Math.max(...GRADER_NAMES.map((g) => stats[g].n));
    lines.push(`| ${cat} | ${n} | ${GRADER_NAMES.map((g) => (stats[g].n ? pct(stats[g].rate) : '–')).join(' | ')} |`);
  }
  lines.push('', '## Rule / judge disagreements', '');
  if (r.disagreements.length === 0) lines.push('None.');
  else for (const d of r.disagreements) lines.push(`- \`${d.id}\` ${d.grader}: rule ${d.ruleSaid ? 'pass' : 'fail'}, judge ${d.judgeSaid ? 'pass' : 'fail'}`);
  lines.push('', '## Worst 10 cases', '');
  const worst = [...r.cases]
    .sort((a, b) => b.failures.length - a.failures.length || a.id.localeCompare(b.id))
    .filter((c) => c.failures.length > 0)
    .slice(0, 10);
  if (worst.length === 0) lines.push('Every case passed every grader.');
  for (const c of worst) {
    lines.push(`- \`${c.id}\` (${c.category}): ${c.failures.join(', ')}${c.question ? ` — "${c.question}"` : ''}`);
  }
  if (r.thresholds.failures.length > 0) {
    lines.push('', '## Regressions', '');
    for (const f of r.thresholds.failures) lines.push(`- **${f.grader}**: ${pct(f.rate)} < ${pct(f.threshold)}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runEval(opts: EvalOptions): Promise<EvalOutcome> {
  const errors: string[] = [];
  // Application modules are imported lazily, after the caller has prepared the environment.
  const { buildMarketPrompts, validateMarketQuestion } = await import('../../src/services/market.service');
  const llm = await import('../../src/lib/llm');
  const { marketProposalV1 } = await import('../../src/lib/prompts');
  const { marketProposalSpec } = await import('../../src/lib/llm-schema');

  const { cases, hash: corpusHash } = loadCorpus(opts.corpusDir, opts.caseId);
  if (cases.length === 0) {
    return { exitCode: 2, report: null, errors: [opts.caseId ? `no case "${opts.caseId}"` : 'the corpus is empty'], files: null };
  }
  const thresholds = JSON.parse(fs.readFileSync(opts.thresholdsPath, 'utf8')) as Partial<Record<GraderName, number>>;

  // Time-dependent rules (expiry in the future) belong to the graders, which
  // judge against asOf; the model-facing spec keeps only the shape.
  const generationSpec = { ...marketProposalSpec, postValidate: undefined };
  const live = opts.transport ?? llm.getLlmTransport();
  let provider: string | null = null;

  /** One model call: replayed from a recording, or live (and optionally recorded). */
  const complete = async (
    caseId: string,
    kind: 'proposal' | 'judge',
    system: string,
    user: string,
    spec: typeof generationSpec | typeof judgeSpec,
  ): Promise<string> => {
    const key = promptKey(system, user);
    if (opts.mode === 'replay') {
      const rec = loadRecording(opts.recordingsDir, opts.model, caseId, kind, key);
      provider = provider ?? rec.provider;
      return rec.output;
    }
    const out = await live.json(system, user, kind === 'proposal' ? 4096 : 512, { spec });
    provider = provider ?? out.provider;
    if (opts.record) {
      saveRecording(opts.recordingsDir, opts.model, { caseId, kind, promptKey: key, provider: out.provider, model: out.model, output: out.text });
    }
    return out.text;
  };

  const outcomes: CaseOutcome[] = [];
  const disagreements: Report['disagreements'] = [];
  let duplicatesFlagged = 0;

  for (const c of cases) {
    const asOf = new Date(c.asOf);
    // Fixed clock and fixed nonces: the prompt, and so its recording key, is a pure function of the case.
    const { system, user } = buildMarketPrompts(c.signals as any, c.existing, asOf, { nonceSeed: c.id });

    let parsed: { proposal: ReturnType<typeof validateMarketQuestion> } | { error: string };
    try {
      const raw = await complete(c.id, 'proposal', system, user, generationSpec);
      try {
        parsed = { proposal: validateMarketQuestion(raw) };
      } catch (err) {
        // A schema failure is a result, not a crash.
        parsed = { error: (err as { code?: string }).code ?? 'SCHEMA_VALIDATION_FAILED' };
      }
    } catch (err) {
      if (err instanceof RecordingMissingError) { errors.push(err.message); continue; }
      parsed = { error: (err as { code?: string }).code ?? 'LLM_CALL_FAILED' };
    }

    let verdict: JudgeVerdict | null = null;
    if (opts.judge && 'proposal' in parsed) {
      const p = parsed.proposal;
      const prompts = judgePromptV1.render({
        proposalJson: JSON.stringify({
          market_question: p.market_question,
          resolution_oracle: p.resolution_oracle,
          expiry: new Date(p.expiry_timestamp * 1000).toISOString().slice(0, 10),
        }),
      });
      try {
        const raw = await complete(c.id, 'judge', prompts.system, prompts.user, judgeSpec);
        const v = judgeSchema.safeParse(JSON.parse(raw));
        verdict = v.success ? v.data : null;
      } catch (err) {
        if (err instanceof RecordingMissingError) { errors.push(err.message); continue; }
        verdict = null; // an unusable judge is no verdict; the rules still apply
      }
    }

    const grades = gradeCase(c, parsed, verdict);
    for (const g of ['binary', 'resolutionSource'] as const) {
      const d = grades[g].detail as { disagreement?: boolean; rule?: { pass: boolean }; inAllowList?: boolean };
      if (d.disagreement && verdict) {
        disagreements.push({
          id: c.id,
          grader: g,
          ruleSaid: g === 'binary' ? !!d.rule?.pass : !!d.inAllowList,
          judgeSaid: g === 'binary' ? verdict.binary === 1 : verdict.verifiable === 1,
        });
      }
    }
    if ('proposal' in parsed && (grades.duplicateAccuracy.detail as { flaggedDuplicate?: boolean }).flaggedDuplicate) duplicatesFlagged++;
    const failures = GRADER_NAMES.filter((n) => grades[n].applicable && !grades[n].pass);
    outcomes.push({
      id: c.id,
      category: c.labels.category ?? 'UNLABELLED',
      question: 'proposal' in parsed ? parsed.proposal.market_question : null,
      grades,
      passedAll: failures.length === 0,
      failures,
    });
  }

  if (errors.length > 0) return { exitCode: 2, report: null, errors, files: null };

  const byCategory: Report['byCategory'] = {};
  for (const cat of new Set(outcomes.map((o) => o.category))) {
    byCategory[cat] = aggregate(outcomes.filter((o) => o.category === cat));
  }
  const graders = aggregate(outcomes);
  const passingAll = outcomes.filter((o) => o.passedAll).length;
  const failures: Report['thresholds']['failures'] = [];
  for (const name of GRADER_NAMES) {
    const t = thresholds[name];
    if (t !== undefined && graders[name].n > 0 && graders[name].rate < t) failures.push({ grader: name, rate: graders[name].rate, threshold: t });
  }

  const asOfs = cases.map((c) => c.asOf).sort();
  const report: Report = {
    meta: {
      mode: opts.mode,
      model: opts.model,
      provider,
      generationPrompt: { id: marketProposalV1.id, version: marketProposalV1.version, contentHash: marketProposalV1.contentHash },
      judgePrompt: opts.judge ? { id: judgePromptV1.id, version: judgePromptV1.version, contentHash: judgePromptV1.contentHash } : null,
      corpusHash,
      caseCount: cases.length,
      gitSha: gitSha(),
      asOfRange: [asOfs[0], asOfs[asOfs.length - 1]],
    },
    graders,
    byCategory,
    overall: { casesPassingAll: passingAll, n: outcomes.length, rate: passingAll / outcomes.length, wilson95: wilson(passingAll, outcomes.length) },
    disagreements,
    duplicateRate: { flagged: duplicatesFlagged, n: outcomes.length, rate: duplicatesFlagged / outcomes.length },
    thresholds: { path: path.relative(process.cwd(), opts.thresholdsPath), values: thresholds, failures },
    cases: outcomes,
  };

  fs.mkdirSync(opts.outDir, { recursive: true });
  const base = path.join(opts.outDir, `${opts.mode}-${opts.model}${opts.caseId ? `-${opts.caseId}` : ''}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, toMarkdown(report));
  return { exitCode: failures.length > 0 ? 1 : 0, report, errors, files: { json: `${base}.json`, md: `${base}.md` } };
}
