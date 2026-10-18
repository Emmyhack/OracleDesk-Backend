/**
 * Question embeddings for semantic dedup (#69).
 *
 * A provider-agnostic interface (Gemini, OpenAI-compatible, or an in-memory
 * fake for tests), the normalisation applied before embedding, and the raw-SQL
 * access to markets.questionEmbedding. Prisma cannot read or write
 * `Unsupported("vector(768)")`, so every statement here is $queryRaw /
 * $executeRaw with the vector bound as a parameter (`$1::vector` with a
 * '[0.1,…]' string), never interpolated.
 */
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { Prisma } from '@prisma/client';
import { TaskType } from '@google/generative-ai';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getGenAI } from '../lib/gemini';
import { secret } from '../config/secrets';
import { AppError } from '../middlewares/error.middleware';
import { bulkheads, deadline } from '../lib/resilience';

/** The dimension of markets.questionEmbedding, fixed by the migration. */
export const EMBEDDING_COLUMN_DIM = 768;
/** Question text is capped before embedding: LLM-generated text can be long. */
export const MAX_EMBED_CHARS = 512;

export interface EmbeddingProvider {
  id: 'gemini' | 'openai' | 'fake';
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

/**
 * Canonical text for embedding: lowercase; dates collapsed to `<date>` (the
 * second dedup stage compares dates explicitly, so they must not drive the
 * vector); numbers written as plain digits ($70,000 / 70k → 70000); punctuation
 * dropped; capped at {@link MAX_EMBED_CHARS}. Stable: normalising twice is a no-op.
 */
export function normalizeQuestion(question: string): string {
  let q = question.toLowerCase().replace(/\bu\.s\.(?!\w)/g, 'us');
  q = q.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' <date> ');
  q = q.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?(?:\\s+\\d{4})?\\b`, 'g'), ' <date> ');
  q = q.replace(new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*[-–]\\s*\\d{1,2})?(?:,?\\s+\\d{4})?\\b`, 'g'), ' <date> ');
  q = q.replace(new RegExp(`\\b(?:end of |the end of )?${MONTH}(?:\\s+\\d{4})?\\b`, 'g'), ' <date> ');
  q = q.replace(/\bend of q[1-4](?:\s+\d{4})?\b/g, ' <date> ');
  // 70k / 1.5m / 2b → plain numbers, then drop separators and currency signs
  q = q.replace(/\b(\d+(?:\.\d+)?)\s?(thousand|million|billion|trillion)\b/g, (_m, n: string, u: string) => String(Number(n) * ({ thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 } as Record<string, number>)[u]));
  q = q.replace(/\b(\d+(?:\.\d+)?)\s?([kmb])\b/g, (_m, n: string, u: string) => String(Number(n) * ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[u]));
  q = q.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d),(\d{3})/g, '$1$2');
  q = q.replace(/<date>/g, ' datetoken ');
  q = q.replace(/[^a-z0-9.%\s]/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  q = q.replace(/datetoken/g, '<date>');
  q = q.replace(/\s+/g, ' ').trim();
  return q.slice(0, MAX_EMBED_CHARS);
}

// ─── Providers ───────────────────────────────────────────────────────────────

function checkDims(vectors: number[][], expected: number, count: number, who: string): number[][] {
  if (vectors.length !== count) throw new Error(`${who} returned ${vectors.length} embeddings for ${count} texts`);
  for (const v of vectors) {
    if (v.length !== expected) throw new Error(`${who} returned a ${v.length}-dimensional vector; expected ${expected}`);
  }
  return vectors;
}

export function geminiEmbeddingProvider(model: string, dim: number): EmbeddingProvider {
  return {
    id: 'gemini',
    model,
    dim,
    async embed(texts) {
      if (!secret('GEMINI_API_KEY')) throw new AppError(503, 'EMBEDDING_UNAVAILABLE', 'GEMINI_API_KEY is not set');
      return bulkheads.llm.run(async () => {
        const handle = deadline('llm');
        try {
          const m = getGenAI().getGenerativeModel({ model });
          const res = await m.batchEmbedContents({
            requests: texts.map((text) => ({
              content: { role: 'user', parts: [{ text }] },
              taskType: TaskType.SEMANTIC_SIMILARITY,
              // Not in the SDK's types, accepted by the API: keeps newer models at 768.
              outputDimensionality: dim,
            } as any)),
          }, { signal: handle.signal });
          return checkDims(res.embeddings.map((e) => e.values), dim, texts.length, `Gemini ${model}`);
        } finally {
          handle.cleanup?.();
        }
      });
    },
  };
}

export function openaiEmbeddingProvider(model: string, dim: number): EmbeddingProvider {
  return {
    id: 'openai',
    model,
    dim,
    async embed(texts) {
      if (!config.OPENAI_API_KEY) throw new AppError(503, 'EMBEDDING_UNAVAILABLE', 'OPENAI_API_KEY is not set');
      return bulkheads.llm.run(async () => {
        const handle = deadline('llm');
        try {
          const client = new OpenAI({
            apiKey: config.OPENAI_API_KEY,
            ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
          });
          const res = await client.embeddings.create({ model, input: texts, dimensions: dim }, { signal: handle.signal });
          return checkDims([...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding), dim, texts.length, `OpenAI ${model}`);
        } finally {
          handle.cleanup?.();
        }
      });
    },
  };
}

/**
 * Deterministic offline embedder for tests and CI. Words go through a small
 * synonym map (so "fomc" and "fed", "unchanged" and "hold" land together), then
 * word unigrams and bigrams are hashed into `dim` buckets and L2-normalised. It
 * is a stand-in with the right interface, NOT a semantic model: thresholds
 * tuned on it say nothing about Gemini or OpenAI.
 */
const SYNONYMS: Record<string, string> = {
  fomc: 'fed', 'federal': 'fed', reserve: 'fed', powell: 'fed',
  unchanged: 'hold', steady: 'hold', maintain: 'hold', keep: 'hold', leave: 'hold', hold: 'hold', remain: 'hold',
  lower: 'cut', reduce: 'cut', cut: 'cut', ease: 'cut', slash: 'cut', trim: 'cut',
  raise: 'hike', increase: 'hike', hike: 'hike', boost: 'hike',
  bitcoin: 'btc', ether: 'eth', ethereum: 'eth',
  exceed: 'above', exceeds: 'above', surpass: 'above', top: 'above', over: 'above', higher: 'above',
  below: 'under', beneath: 'under', fall: 'under', drop: 'under',
  win: 'win', wins: 'win', clinch: 'win', defeat: 'win', beat: 'win',
  approve: 'pass', pass: 'pass', passes: 'pass', adopt: 'pass', enact: 'pass',
  inflation: 'cpi', unemployment: 'jobs', payrolls: 'jobs',
  rate: 'rate', rates: 'rate',
  meeting: 'meeting', decision: 'meeting', announcement: 'meeting',
};
const FAKE_STOP = new Set(['will', 'the', 'a', 'an', 'at', 'its', 'on', 'of', 'to', 'be', 'in', 'by', 'for', 'is', 'and', 'next', 'target', 'range']);

export function fakeEmbeddingProvider(dim = EMBEDDING_COLUMN_DIM, model = 'fake-hash-v1'): EmbeddingProvider {
  const bucket = (token: string) => {
    const h = crypto.createHash('sha256').update(token).digest();
    return { index: h.readUInt32BE(0) % dim, sign: h[4] & 1 ? 1 : -1 };
  };
  return {
    id: 'fake',
    model,
    dim,
    async embed(texts) {
      return texts.map((text) => {
        const words = normalizeQuestion(text)
          .split(' ')
          .filter((w) => w && !FAKE_STOP.has(w))
          .map((w) => SYNONYMS[w] ?? w);
        const v = new Array<number>(dim).fill(0);
        const add = (token: string, weight: number) => { const { index, sign } = bucket(token); v[index] += sign * weight; };
        words.forEach((w, i) => {
          add(`u:${w}`, 1);
          if (i + 1 < words.length) add(`b:${w}|${words[i + 1]}`, 0.5);
        });
        const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

// ─── Provider selection ──────────────────────────────────────────────────────

let override: EmbeddingProvider | null | undefined;
let cached: { key: string; provider: EmbeddingProvider } | null = null;

const DEFAULT_MODELS = { gemini: 'text-embedding-004', openai: 'text-embedding-3-small' } as const;

/**
 * Throws when the configured dimension cannot be stored. Called at boot (and
 * whenever a provider is built), so a mismatch fails fast, not on first insert.
 */
export function assertEmbeddingConfig(): void {
  if (config.EMBEDDING_PROVIDER === 'none') return;
  if (config.EMBEDDING_DIM !== EMBEDDING_COLUMN_DIM) {
    throw new Error(
      `EMBEDDING_DIM=${config.EMBEDDING_DIM} does not match markets.questionEmbedding, which is vector(${EMBEDDING_COLUMN_DIM}); change the column in a migration first`,
    );
  }
}

/** The configured provider, or null (EMBEDDING_PROVIDER=none): callers fall back to the lexical check. */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (override !== undefined) return override;
  const kind = config.EMBEDDING_PROVIDER;
  if (kind === 'none') return null;
  assertEmbeddingConfig();
  const model = config.EMBEDDING_MODEL || DEFAULT_MODELS[kind];
  const key = `${kind}|${model}|${config.EMBEDDING_DIM}`;
  if (!cached || cached.key !== key) {
    cached = { key, provider: kind === 'gemini' ? geminiEmbeddingProvider(model, config.EMBEDDING_DIM) : openaiEmbeddingProvider(model, config.EMBEDDING_DIM) };
  }
  return cached.provider;
}

/**
 * Test seam. `null` forces "no provider" (lexical fallback); a provider
 * replaces the configured one. Pass `undefined` via {@link resetEmbeddingProvider}
 * to return to configuration. A dimension the column cannot hold is rejected.
 */
export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  if (p && p.dim !== EMBEDDING_COLUMN_DIM) {
    throw new Error(`Embedding provider dimension ${p.dim} does not match vector(${EMBEDDING_COLUMN_DIM})`);
  }
  override = p;
}

export function resetEmbeddingProvider(): void {
  override = undefined;
}

// ─── Vector storage and search ───────────────────────────────────────────────

/** pgvector text form. Validated numerically, then bound as a parameter. */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_COLUMN_DIM || v.some((x) => !Number.isFinite(x))) {
    throw new Error(`Embedding must be ${EMBEDDING_COLUMN_DIM} finite numbers`);
  }
  return `[${v.join(',')}]`;
}

export interface Neighbour {
  marketId: string;
  question: string;
  category: string;
  expiryTimestamp: Date;
  /** Cosine similarity, 1 − cosine distance. */
  similarity: number;
}

export interface UnembeddedMarket {
  id: string;
  question: string;
  category: string;
  expiryTimestamp: Date;
}

/** What dedup needs from the vector store; the Postgres version is below, tests use memory. */
export interface VectorIndex {
  /** Nearest PENDING/ACTIVE markets embedded with `model`, best first. */
  nearest(vector: number[], model: string, k: number): Promise<Neighbour[]>;
  /** PENDING/ACTIVE markets the vector search cannot see (no embedding, or another model's). */
  unembedded(model: string): Promise<UnembeddedMarket[]>;
}

export const postgresVectorIndex: VectorIndex = {
  async nearest(vector, model, k) {
    const literal = toVectorLiteral(vector);
    const rows = await prisma.$queryRaw<Array<{ id: string; question: string; category: string; expiryTimestamp: Date; sim: number }>>(Prisma.sql`
      SELECT id, question, category::text AS category, "expiryTimestamp",
             1 - ("questionEmbedding" <=> ${literal}::vector) AS sim
      FROM markets
      WHERE status IN ('PENDING', 'ACTIVE')
        AND "questionEmbedding" IS NOT NULL
        AND "embeddingModel" = ${model}
      ORDER BY "questionEmbedding" <=> ${literal}::vector
      LIMIT ${k}`);
    return rows.map((r) => ({ marketId: r.id, question: r.question, category: r.category, expiryTimestamp: r.expiryTimestamp, similarity: Number(r.sim) }));
  },
  async unembedded(model) {
    return prisma.$queryRaw<UnembeddedMarket[]>(Prisma.sql`
      SELECT id, question, category::text AS category, "expiryTimestamp"
      FROM markets
      WHERE status IN ('PENDING', 'ACTIVE')
        AND ("questionEmbedding" IS NULL OR "embeddingModel" IS DISTINCT FROM ${model})`);
  },
};

let vectorIndex: VectorIndex = postgresVectorIndex;

/** Test seam (an in-memory index). Pass null to restore Postgres. */
export function setVectorIndex(next: VectorIndex | null): VectorIndex {
  const prev = vectorIndex;
  vectorIndex = next ?? postgresVectorIndex;
  return prev;
}

export function getVectorIndex(): VectorIndex {
  return vectorIndex;
}

/** Embeds one market's question and stores the vector and model. */
export async function embedMarket(marketId: string): Promise<void> {
  const provider = getEmbeddingProvider();
  if (!provider) return;
  const market = await prisma.market.findUnique({ where: { id: marketId }, select: { question: true } });
  if (!market) return;
  const [vector] = await provider.embed([normalizeQuestion(market.question)]);
  await storeEmbedding(marketId, vector, provider.model);
}

async function storeEmbedding(marketId: string, vector: number[], model: string): Promise<void> {
  const literal = toVectorLiteral(vector);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE markets SET "questionEmbedding" = ${literal}::vector, "embeddingModel" = ${model}
    WHERE id = ${marketId}`);
}

/**
 * Embeds markets that have no vector (or, with `reembed`, one from a different
 * model), `batch` at a time, until none are left or a batch fails. Every
 * market is tried at most once per call; the next call retries failures.
 */
export async function backfillEmbeddings(
  batch = 64,
  opts: { reembed?: boolean; maxBatches?: number } = {},
): Promise<{ embedded: number; failed: number }> {
  const provider = getEmbeddingProvider();
  if (!provider) return { embedded: 0, failed: 0 };
  let embedded = 0;
  let failed = 0;
  const seen = new Set<string>();
  for (let i = 0; i < (opts.maxBatches ?? Infinity); i++) {
    const rows = await prisma.$queryRaw<Array<{ id: string; question: string }>>(Prisma.sql`
      SELECT id, question FROM markets
      WHERE "questionEmbedding" IS NULL ${opts.reembed ? Prisma.sql`OR "embeddingModel" IS DISTINCT FROM ${provider.model}` : Prisma.empty}
      ORDER BY "createdAt" DESC
      LIMIT ${batch + seen.size}`);
    const todo = rows.filter((r) => !seen.has(r.id)).slice(0, batch);
    if (todo.length === 0) break;
    todo.forEach((r) => seen.add(r.id));
    try {
      const vectors = await provider.embed(todo.map((r) => normalizeQuestion(r.question)));
      for (let j = 0; j < todo.length; j++) {
        await storeEmbedding(todo[j].id, vectors[j], provider.model);
        embedded++;
      }
    } catch (err) {
      failed += todo.length;
      logger.warn({ err: (err as Error)?.message?.slice(0, 200), count: todo.length }, 'Embedding batch failed; will retry on the next sweep');
    }
  }
  return { embedded, failed };
}

/** Cosine similarity; exported for the in-memory index and the calibration script. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
