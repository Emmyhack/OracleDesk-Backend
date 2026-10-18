/**
 * npm run calibrate:dedup [-- --provider fake|gemini|openai] [--vectors <file>] [--record] [--min-precision 0.95]
 *
 * Picks DEDUP_SIM_THRESHOLD from labelled pairs (tests/fixtures/dedup-pairs.json,
 * #69). For every threshold it scores three detectors against the labels:
 *   semantic        sim ≥ t
 *   semantic+stage2 sim ≥ t, then the entity / date / figures confirmation
 *   lexical         the old Jaccard / bigram rule (threshold-free)
 * and recommends the threshold that maximises recall at precision ≥ 0.95.
 *
 * --provider fake (default) needs nothing and runs in CI; it checks the harness,
 * NOT a real model: its vectors come from a hashing embedder with a synonym
 * map. Run it with --provider gemini|openai (keys in the environment) and
 * --record to write tests/fixtures/dedup-vectors.<model>.json; replay that file
 * later with --vectors. Exit 1 if no threshold reaches the precision target.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureEvalEnv } from './eval/env';

const ROOT = path.join(__dirname, '..');

interface Pair { a: string; b: string; duplicate: boolean; family: string; dueA: string; dueB: string }
interface Score { threshold: number; tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number }

function parse(argv: string[]) {
  const value = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    provider: (value('provider') ?? 'fake') as 'fake' | 'gemini' | 'openai',
    vectors: value('vectors'),
    record: argv.includes('--record'),
    minPrecision: Number(value('min-precision') ?? 0.95),
  };
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
function score(threshold: number, predicted: boolean[], labels: boolean[]): Score {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  predicted.forEach((p, i) => {
    if (p && labels[i]) tp++; else if (p) fp++; else if (labels[i]) fn++; else tn++;
  });
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { threshold, tp, fp, fn, tn, precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

/** Highest recall among thresholds meeting the precision target (ties: the higher threshold). */
function pick(scores: Score[], minPrecision: number): Score | null {
  const ok = scores.filter((s) => s.precision >= minPrecision && s.tp > 0);
  if (ok.length === 0) return null;
  return ok.reduce((best, s) => (s.recall > best.recall || (s.recall === best.recall && s.threshold > best.threshold) ? s : best));
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  ensureEvalEnv();
  const emb = await import('../src/services/embeddings.service');
  const { confirmDuplicate, isDuplicateOf } = await import('../src/services/market.service');
  const { config } = await import('../src/config');

  const pairs: Pair[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/dedup-pairs.json'), 'utf8'));
  const questions = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const normalized = questions.map((q) => emb.normalizeQuestion(q));

  // ── vectors
  let model: string;
  let vectors: number[][];
  if (args.vectors) {
    const file = JSON.parse(fs.readFileSync(path.resolve(args.vectors), 'utf8')) as { model: string; vectors: Record<string, number[]> };
    model = file.model;
    vectors = normalized.map((n) => {
      const v = file.vectors[crypto.createHash('sha256').update(n).digest('hex')];
      if (!v) throw new Error(`no recorded vector for "${n}"; re-run with --provider <p> --record`);
      return v;
    });
  } else {
    let provider: import('../src/services/embeddings.service').EmbeddingProvider;
    if (args.provider === 'fake') provider = emb.fakeEmbeddingProvider();
    else {
      const { setSecretsForTest, SECRET_NAMES } = await import('../src/config/secrets');
      setSecretsForTest(Object.fromEntries(SECRET_NAMES.map((n) => [n, process.env[n] ?? ''])) as any);
      const budget = await import('../src/lib/llm-budget');
      budget.setLlmGuardStore(new budget.MemoryGuardStore());
      const model0 = process.env.EMBEDDING_MODEL || (args.provider === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small');
      provider = args.provider === 'gemini' ? emb.geminiEmbeddingProvider(model0, emb.EMBEDDING_COLUMN_DIM) : emb.openaiEmbeddingProvider(model0, emb.EMBEDDING_COLUMN_DIM);
    }
    model = provider.model;
    vectors = [];
    for (let i = 0; i < normalized.length; i += 64) vectors.push(...(await provider.embed(normalized.slice(i, i + 64))));
    if (args.record) {
      const file = path.join(ROOT, `tests/fixtures/dedup-vectors.${model.replace(/[^\w.-]/g, '_')}.json`);
      const map: Record<string, number[]> = {};
      normalized.forEach((n, i) => { map[crypto.createHash('sha256').update(n).digest('hex')] = vectors[i].map((x) => Number(x.toFixed(6))); });
      fs.writeFileSync(file, JSON.stringify({ model, dim: vectors[0].length, vectors: map }));
      console.log(`recorded ${normalized.length} vectors to ${path.relative(ROOT, file)}`);
    }
  }
  const vec = new Map(questions.map((q, i) => [q, vectors[i]]));

  // ── similarities and verdicts
  const labels = pairs.map((p) => p.duplicate);
  const sims = pairs.map((p) => emb.cosine(vec.get(p.a)!, vec.get(p.b)!));
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const stage2 = pairs.map((p, i) => confirmDuplicate(
    { question: p.a, expiry: day(p.dueA) },
    { question: p.b, expiry: day(p.dueB), similarity: sims[i] },
    config.DEDUP_DATE_WINDOW_DAYS,
  ).duplicate);

  const thresholds = Array.from({ length: 50 }, (_, i) => Number((0.5 + i * 0.01).toFixed(2)));
  const semantic = thresholds.map((t) => score(t, sims.map((s) => s >= t), labels));
  const confirmed = thresholds.map((t) => score(t, sims.map((s, i) => s >= t && stage2[i]), labels));
  const lexical = score(NaN, pairs.map((p) => isDuplicateOf(p.a, [p.b])), labels);

  const bestSemantic = pick(semantic, args.minPrecision);
  const bestConfirmed = pick(confirmed, args.minPrecision);

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const row = (name: string, s: Score | null) =>
    s ? `${name.padEnd(18)} t=${Number.isNaN(s.threshold) ? '  –  ' : s.threshold.toFixed(2)}  precision ${pct(s.precision).padStart(6)}  recall ${pct(s.recall).padStart(6)}  F1 ${s.f1.toFixed(3)}  (tp ${s.tp} fp ${s.fp} fn ${s.fn} tn ${s.tn})`
      : `${name.padEnd(18)} no threshold reaches precision ${pct(args.minPrecision)}`;
  console.log(`provider: ${args.vectors ? `recorded vectors (${model})` : args.provider}, model: ${model}, pairs: ${pairs.length} (${labels.filter(Boolean).length} duplicates)`);
  console.log(row('lexical', lexical));
  console.log(row('semantic', bestSemantic));
  console.log(row('semantic + stage 2', bestConfirmed));

  const families = [...new Set(pairs.map((p) => p.family))];
  const at = bestConfirmed?.threshold;
  if (at !== undefined) {
    console.log('\nerrors at the recommended threshold (semantic + stage 2):');
    pairs.forEach((p, i) => {
      const predicted = sims[i] >= at && stage2[i];
      if (predicted !== p.duplicate) console.log(`  ${predicted ? 'FALSE POSITIVE' : 'MISSED DUPLICATE'} [${p.family}] sim ${sims[i].toFixed(3)}: "${p.a}" / "${p.b}"`);
    });
    console.log('\nper family at that threshold:');
    for (const f of families) {
      const idx = pairs.map((p, i) => (p.family === f ? i : -1)).filter((i) => i >= 0);
      const right = idx.filter((i) => (sims[i] >= at && stage2[i]) === labels[i]).length;
      console.log(`  ${f.padEnd(20)} ${right}/${idx.length} correct`);
    }
  }

  const outDir = path.join(ROOT, 'eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `dedup-calibration-${args.vectors ? 'recorded' : args.provider}.json`), JSON.stringify({
    provider: args.provider, model, pairs: pairs.length, minPrecision: args.minPrecision,
    lexical, semantic: bestSemantic, semanticStage2: bestConfirmed, recommendedThreshold: bestConfirmed?.threshold ?? null,
    sweep: { semantic, semanticStage2: confirmed },
  }, null, 2));

  if (!bestConfirmed) process.exit(1);
  console.log(`\nrecommended DEDUP_SIM_THRESHOLD=${bestConfirmed.threshold.toFixed(2)}${args.provider === 'fake' && !args.vectors ? '  (fake provider: harness check only, not a model threshold)' : ''}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
