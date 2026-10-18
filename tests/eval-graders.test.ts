/**
 * Offline market-generation evaluation (#67): graders, the refactored pure
 * functions and the replay runner. No network, database or provider key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestEnv } from './helpers/env';

process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
setupTestEnv();

const ROOT = path.join(__dirname, '..', '..');
const EVAL = path.join(ROOT, 'tests', 'eval');
const ASOF = new Date('2026-09-10T12:00:00Z');
const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

// ─── dateSanity ──────────────────────────────────────────────────────────────
test('extractQuestionDates reads explicit dates in the supported forms', async () => {
  const { extractQuestionDates } = await import('../scripts/eval/dates');
  const iso = (q: string, asOf = ASOF) => extractQuestionDates(q, asOf).map((d) => d.toISOString().slice(0, 10));
  assert.deepEqual(iso('Will X happen by June 30, 2026?', new Date('2026-05-01Z')), ['2026-06-30']);
  assert.deepEqual(iso('Will X happen on 2026-10-01?'), ['2026-10-01']);
  assert.deepEqual(iso('Will X happen by 30 June 2027?'), ['2027-06-30']);
  assert.deepEqual(iso('Will X happen on Sept 17?'), ['2026-09-17']);
  assert.deepEqual(iso('Will X happen by the end of Q3 2026?'), ['2026-09-30']);
  assert.deepEqual(iso('Will X happen by the end of October?'), ['2026-10-31']);
  assert.deepEqual(iso('Will X open on October 23-25, 2026?'), ['2026-10-25'], 'a day range reads as its last day');
  assert.deepEqual(iso('Will X happen on the 22nd of nowhere?'), []);
  // a year-less date earlier than asOf rolls into the next year
  assert.deepEqual(iso('Will X happen on January 28?', new Date('2026-12-10Z')), ['2027-01-28']);
  // the modal verb "may" is not the month
  assert.deepEqual(iso('Will the Fed say it may 5 times raise rates?'), []);
});

test('dateSanity flags a mismatch with the expiry, a past expiry and one beyond 90 days', async () => {
  const { gradeDateSanity } = await import('../scripts/eval/graders');
  const q = 'Will the Fed hold rates on September 17, 2026?';
  assert.equal(gradeDateSanity(q, ts('2026-09-17T12:00:00Z'), ASOF).pass, true);
  assert.equal(gradeDateSanity(q, ts('2026-09-19T12:00:00Z'), ASOF).pass, true, 'within the 2-day tolerance');

  const mismatch = gradeDateSanity(q, ts('2026-10-17T12:00:00Z'), ASOF);
  assert.equal(mismatch.pass, false);
  assert.equal(mismatch.detail.deltaDays, 30);

  assert.equal(gradeDateSanity('Will X happen?', ts('2026-09-05T12:00:00Z'), ASOF).pass, false, 'expiry before asOf');
  assert.equal(gradeDateSanity('Will X happen?', ts('2026-09-10T18:00:00Z'), ASOF).pass, false, 'less than a day out');
  assert.equal(gradeDateSanity('Will X happen?', ts('2026-12-15T12:00:00Z'), ASOF).pass, false, 'beyond 90 days');
  assert.equal(gradeDateSanity('Will X happen?', ts('2026-12-08T12:00:00Z'), ASOF).pass, true, 'inside 90 days, no date in the text');
});

// ─── binary-ness ─────────────────────────────────────────────────────────────
test('the binary rule rejects multi-outcome phrasing and accepts thresholds', async () => {
  const { binaryRule } = await import('../scripts/eval/graders');
  const bad = [
    'Will the Fed hold or cut rates in September?',
    'How many jobs will be added in October?',
    'Which team will win the final?',
    'Will CPI end in the 3.0 to 3.5 percent range?',
    'Will CPI print between 3.0% and 3.5%?',
    'Will X happen? Will Y happen?',
    'The Fed will hold rates in September.',
  ];
  for (const q of bad) assert.equal(binaryRule(q).pass, false, q);
  const good = [
    'Will the unemployment rate be at or above 4.3%?',
    'Will a shutdown begin on or before October 1, 2026?',
    'Will the Federal Reserve lower the federal funds target range at its October meeting?',
    'Will the film open above $130 million on October 23-25, 2026?',
    'Will the 10-year yield close between now and December above 4.5%?',
  ];
  for (const q of good) assert.deepEqual(binaryRule(q).reasons, [], q);
});

test('the judge can fail a question but never rescue one the rule rejected', async () => {
  const { gradeBinary } = await import('../scripts/eval/graders');
  const yes = { binary: 1 as const, verifiable: 1 as const, ambiguity_notes: '' };
  const no = { binary: 0 as const, verifiable: 1 as const, ambiguity_notes: 'unclear' };
  assert.equal(gradeBinary('Will X happen?', yes).pass, true);
  assert.equal(gradeBinary('Will X happen?', no).pass, false);
  const overridden = gradeBinary('Will X or Y happen?', yes);
  assert.equal(overridden.pass, false);
  assert.equal(overridden.detail.disagreement, true);
});

// ─── resolutionSource / category / ci ────────────────────────────────────────
test('resolutionSource rejects oracles outside the allow-list', async () => {
  const { gradeResolutionSource } = await import('../scripts/eval/graders');
  for (const ok of ['FRED', 'CHAINLINK', 'OPEC', 'AP_ELECTIONS', 'BILLBOARD']) assert.equal(gradeResolutionSource(ok, null).pass, true, ok);
  for (const bad of ['Bloomberg', 'fred', 'https://example.com', '']) assert.equal(gradeResolutionSource(bad, null).pass, false, bad);
  const v = { binary: 1 as const, verifiable: 0 as const, ambiguity_notes: 'no metric' };
  assert.equal(gradeResolutionSource('FRED', v).pass, false, 'the judge can fail an allowed oracle');
});

test('category skips unlabelled cases, and ciConsistency checks order and width', async () => {
  const { gradeCategory, gradeCiConsistency } = await import('../scripts/eval/graders');
  assert.equal(gradeCategory('FED', 'FED').pass, true);
  assert.equal(gradeCategory('MACRO', 'FED').pass, false);
  assert.equal(gradeCategory('MACRO', null).applicable, false);
  assert.equal(gradeCiConsistency(0.5, { lower: 0.4, upper: 0.6 }).pass, true);
  assert.equal(gradeCiConsistency(0.5, { lower: 0.5, upper: 0.6 }).pass, false, 'p must be strictly inside');
  assert.equal(gradeCiConsistency(0.3, { lower: 0.05, upper: 0.6 }).pass, false, 'wider than 0.4');
});

// ─── refactored pure functions ───────────────────────────────────────────────
/** The pre-refactor body of isDuplicateMarket, kept verbatim as the reference. */
function legacyIsDuplicate(question: string, existing: string[], tokens: (t: string) => string[]): boolean {
  const newTokens = tokens(question);
  const newTokensSet = new Set(newTokens);
  for (const text of existing) {
    const existingTokens = tokens(text);
    const intersection = existingTokens.filter((w) => newTokensSet.has(w)).length;
    const union = new Set([...newTokens, ...existingTokens]).size;
    const jaccard = union === 0 ? 0 : intersection / union;
    if (jaccard > 0.55) return true;
    const bigrams = (t: string[]) => { const bg = new Set<string>(); for (let i = 0; i < t.length - 1; i++) bg.add(`${t[i]} ${t[i + 1]}`); return bg; };
    const a = bigrams(newTokens);
    const b = bigrams(existingTokens);
    if ([...a].filter((x) => b.has(x)).length >= 3) return true;
  }
  return false;
}

test('isDuplicateOf matches the previous isDuplicateMarket behaviour', async () => {
  const { isDuplicateOf, isDuplicateMarket } = await import('../src/services/market.service');
  const { meaningfulTokens } = await import('../src/services/market-policy');
  const { prisma } = await import('../src/lib/prisma');
  const existing = [
    'Will the Federal Reserve keep the federal funds rate unchanged at its September meeting?',
    'Will Bitcoin trade above $100,000 before year end?',
    'Will the Lakers win the 2026 NBA championship?',
  ];
  const probes = [
    'Will the Federal Reserve keep the federal funds rate unchanged at its September 17, 2026 meeting?',
    'Will the FOMC leave the federal funds target unchanged on Sept 17?',
    'Will Bitcoin trade above $120,000 before year end?',
    'Will the ECB cut its deposit rate in December?',
    'Will the Celtics win the 2026 NBA championship?',
    '',
  ];
  for (const q of probes) assert.equal(isDuplicateOf(q, existing), legacyIsDuplicate(q, existing, meaningfulTokens), q);
  assert.equal(isDuplicateOf('anything', []), false);

  // and the Prisma wrapper reads PENDING/ACTIVE questions into the same rule
  const orig = prisma.market.findMany;
  (prisma.market.findMany as any) = async () => existing.map((question) => ({ question }));
  try {
    assert.equal(await isDuplicateMarket(probes[0]), true);
    assert.equal(await isDuplicateMarket(probes[3]), false);
  } finally {
    (prisma.market.findMany as any) = orig;
  }
});

test('the registered market prompt renders byte-identically to the pre-refactor inline prompt', async () => {
  const { marketProposalV1 } = await import('../src/lib/prompts');
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'market-prompts.legacy.json'), 'utf8'));
  const rendered = marketProposalV1.render(legacy.vars);
  assert.equal(rendered.user, legacy.user);
  // the legacy fixture was rendered with a 3-oracle list; compare around that line
  const oracleLine = /resolution_oracle must be exactly one of: .*/;
  assert.equal(rendered.system.replace(oracleLine, '<oracles>'), legacy.system.replace(oracleLine, '<oracles>'));
});

test('buildMarketPrompts is pure: same input gives the same bytes, and nonces are random only without a seed', async () => {
  const { buildMarketPrompts } = await import('../src/services/market.service');
  const c = JSON.parse(fs.readFileSync(path.join(EVAL, 'corpus', 'fed-hold-2026-09.json'), 'utf8'));
  const a = buildMarketPrompts(c.signals, c.existing, new Date(c.asOf), { nonceSeed: c.id });
  const b = buildMarketPrompts(c.signals, c.existing, new Date(c.asOf), { nonceSeed: c.id });
  assert.equal(a.system, b.system);
  assert.equal(a.user, b.user);
  assert.match(a.user, /Current date: 2026-09-10T12:00:00\.000Z/);
  assert.match(a.user, /ALREADY EXISTING MARKETS/);
  const unseeded = buildMarketPrompts(c.signals, c.existing, new Date(c.asOf));
  assert.notEqual(unseeded.user, a.user);
  assert.match(unseeded.user, /<untrusted_signals nonce="[0-9a-f]{12}">/);
});

// ─── runner ──────────────────────────────────────────────────────────────────
function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
}

function opts(over: Record<string, unknown> = {}) {
  return {
    mode: 'replay' as const,
    record: false,
    model: 'synthetic-baseline',
    judge: true,
    corpusDir: path.join(EVAL, 'corpus'),
    recordingsDir: path.join(EVAL, 'recordings'),
    thresholdsPath: path.join(EVAL, 'thresholds.json'),
    outDir: tmp(),
    ...over,
  };
}

test('the corpus has at least 40 cases, each with a recording', () => {
  const ids = fs.readdirSync(path.join(EVAL, 'corpus')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  assert.ok(ids.length >= 40, `${ids.length} cases`);
  for (const id of ids) {
    assert.ok(fs.existsSync(path.join(EVAL, 'recordings', 'synthetic-baseline', `${id}.json`)), id);
  }
});

test('replay is deterministic and writes JSON and Markdown reports', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  const a = await runEval(opts());
  const b = await runEval(opts());
  assert.equal(a.exitCode, 0, a.errors.join('\n'));
  assert.ok(a.report && a.files);
  assert.deepEqual(a.report!.graders, b.report!.graders);
  assert.deepEqual(a.report!.cases, b.report!.cases);
  const json = JSON.parse(fs.readFileSync(a.files!.json, 'utf8'));
  assert.equal(json.meta.mode, 'replay');
  assert.match(json.meta.generationPrompt.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(json.meta.judgePrompt.id, 'market-judge');
  assert.match(json.meta.corpusHash, /^[0-9a-f]{64}$/);
  const md = fs.readFileSync(a.files!.md, 'utf8');
  assert.match(md, /Wilson 95%/);
  assert.match(md, /Worst 10 cases/);
});

test('rule/judge disagreements are reported apart, and a hard rule failure stays a failure', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  const out = await runEval(opts());
  const unknownOracle = out.report!.cases.find((c) => c.id === 'election-unknown-oracle')!;
  assert.equal(unknownOracle.grades.resolutionSource.pass, false, 'the judge said "verifiable" but the allow-list rejects Bloomberg');
  assert.ok(out.report!.disagreements.some((d) => d.id === 'election-unknown-oracle' && d.ruleSaid === false && d.judgeSaid === true));
});

test('a schema-invalid output is a schema failure, not a crash', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  const out = await runEval(opts({ caseId: 'crypto-schema-bad' }));
  assert.equal(out.report!.cases[0].grades.schemaValid.pass, false);
  assert.equal(out.report!.cases[0].grades.schemaValid.detail.reason, 'no valid proposal');
  assert.equal(out.report!.cases[0].grades.schemaValid.detail.error, 'SCHEMA_VALIDATION_FAILED');
  assert.equal(out.report!.cases[0].grades.binary.pass, false, 'every grader fails, so a bad prompt cannot hide');
});

test('replay fails with "recording missing" when a recording is absent or the prompt changed', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  // absent: an empty recording set
  const empty = tmp();
  const missing = await runEval(opts({ recordingsDir: empty }));
  assert.equal(missing.exitCode, 2);
  assert.ok(missing.errors.length > 0);
  assert.match(missing.errors[0], /recording missing.*re-run with --live --record/);

  // stale: a recording whose key no longer matches the prompt
  const stale = tmp();
  fs.cpSync(path.join(EVAL, 'recordings'), stale, { recursive: true });
  const f = path.join(stale, 'synthetic-baseline', 'fed-hold-2026-09.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.promptKey = '0'.repeat(64);
  fs.writeFileSync(f, JSON.stringify(rec));
  const changed = await runEval(opts({ recordingsDir: stale, caseId: 'fed-hold-2026-09' }));
  assert.equal(changed.exitCode, 2);
  assert.match(changed.errors[0], /prompt changed since it was recorded/);
});

test('thresholds above the measured rate exit non-zero, and ones below it exit zero', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  const strict = path.join(tmp(), 'thresholds.json');
  fs.writeFileSync(strict, JSON.stringify({ binary: 0.999, dateSanity: 0.5 }));
  const failing = await runEval(opts({ thresholdsPath: strict }));
  assert.equal(failing.exitCode, 1);
  assert.deepEqual(failing.report!.thresholds.failures.map((f) => f.grader), ['binary']);
  assert.match(fs.readFileSync(failing.files!.md, 'utf8'), /## Regressions/);

  const lax = path.join(tmp(), 'thresholds.json');
  fs.writeFileSync(lax, JSON.stringify({ binary: 0.1 }));
  assert.equal((await runEval(opts({ thresholdsPath: lax }))).exitCode, 0);
});

test('live mode records outputs, and a recording is refused if it contains a key', async () => {
  const { runEval } = await import('../scripts/eval/runner');
  const { assertNoKeys } = await import('../scripts/eval/recordings');
  assert.throws(() => assertNoKeys('{"output":"sk-ant-api03-abcdefghijklmnopqrstuv"}'), /key-looking/);
  assert.throws(() => assertNoKeys('apiKey: "AbCdEfGhIjKlMnOp12345"'), /key-looking/);
  assert.doesNotThrow(() => assertNoKeys('Will the Fed hold rates at its September 17, 2026 meeting?'));

  // a fake live transport that returns the recorded proposal and judge verdict
  const src = path.join(EVAL, 'recordings', 'synthetic-baseline');
  const id = 'fed-hold-2026-09';
  const proposal = JSON.parse(fs.readFileSync(path.join(src, `${id}.json`), 'utf8')).output;
  const judge = JSON.parse(fs.readFileSync(path.join(src, `${id}.judge.json`), 'utf8')).output;
  const dir = tmp();
  const live = await runEval(opts({
    mode: 'live', record: true, model: 'fake-live', caseId: id, recordingsDir: dir,
    transport: { json: async (_s: string, _u: string, _m: number, o?: { spec?: { name: string } }) => ({
      text: o?.spec?.name === 'submit_market_judgement' ? judge : proposal, provider: 'fake', model: 'fake-live',
    }) },
  }));
  assert.equal(live.exitCode, 0, live.errors.join('\n'));
  assert.ok(fs.existsSync(path.join(dir, 'fake-live', `${id}.json`)));
  assert.ok(fs.existsSync(path.join(dir, 'fake-live', `${id}.judge.json`)));

  // what was recorded replays
  const again = await runEval(opts({ model: 'fake-live', caseId: id, recordingsDir: dir }));
  assert.equal(again.exitCode, 0, again.errors.join('\n'));
  assert.deepEqual(again.report!.cases, live.report!.cases);
});

test('committed recordings contain no key-looking strings', async () => {
  const { assertNoKeys } = await import('../scripts/eval/recordings');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(path.join(EVAL, 'recordings')), ...walk(path.join(EVAL, 'corpus'))]) {
    assert.doesNotThrow(() => assertNoKeys(fs.readFileSync(f, 'utf8')), f);
  }
});
