/**
 * Pure normalisation for the signal store (#73): stable identities, near-dup
 * fingerprints, category classification and the relevance score. No I/O, no
 * clock; callers pass `now`.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { sha256Hex } from '../utils/hash.util';
import { SOURCE_WEIGHTS } from './market-policy';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

export type SignalSource = 'NEWSAPI' | 'FRED' | 'GDELT';

// ─── Identity ─────────────────────────────────────────────────────────────────

const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|ref)$/i;

/**
 * Canonical form of an article URL: lowercase scheme and host, no `www.`, no
 * fragment, no tracking parameters (utm_*, fbclid, gclid, ref), remaining
 * parameters sorted. Null when the input is not an http(s) URL.
 */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  const port = u.port ? `:${u.port}` : '';
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${host}${port}${path}${query}`;
}

export const dedupKeyForUrl = (canonical: string): string => sha256Hex(canonical);

/** One FRED observation is one row however often it is fetched. */
export const dedupKeyForFred = (seriesId: string, observationDate: string): string =>
  sha256Hex(`FRED:${seriesId}:${observationDate}`);

// ─── Dates ────────────────────────────────────────────────────────────────────

/** GDELT `seendate` (YYYYMMDDTHHMMSSZ, UTC). Null when it does not parse. */
export function parseGdeltDate(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const d = dayjs.utc(s, 'YYYYMMDDTHHmmss[Z]', true);
  return d.isValid() ? d.toDate() : null;
}

/** ISO-8601 timestamp from a provider. Null when it does not parse. */
export function parseIsoDate(s: unknown): Date | null {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Near-duplicate fingerprints ──────────────────────────────────────────────

const SHINGLE_SIZE = 5;
export const SUMMARY_PREFIX_CHARS = 200;
/** SimHash bits that may differ between near-duplicates. */
export const SIMHASH_MAX_DISTANCE = 3;
/** Shingle Jaccard at or above which two signals are near-duplicates. */
export const SHINGLE_JACCARD_MIN = 0.6;
/** How far back a new signal looks for a cluster to join. */
export const CLUSTER_WINDOW_HOURS = 48;

export function normalizeText(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.\s]/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Text the near-dup fingerprint is computed over: title plus the start of the summary. */
export function fingerprintText(title: string, summary: string | null | undefined): string {
  return `${title} ${(summary ?? '').slice(0, SUMMARY_PREFIX_CHARS)}`;
}

/** 5-word shingles; a text shorter than five words is one shingle. */
export function shingles(text: string): Set<string> {
  const words = normalizeText(text);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length < SHINGLE_SIZE) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) out.add(words.slice(i, i + SHINGLE_SIZE).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const MASK64 = (1n << 64n) - 1n;

/**
 * 64-bit Charikar SimHash over the shingles, returned as a signed 64-bit
 * value so it fits a Postgres BIGINT. Compare with {@link hammingDistance}.
 */
export function simhash64(text: string): bigint {
  const features = shingles(text);
  const v = new Array<number>(64).fill(0);
  for (const f of features) {
    const h = BigInt(`0x${sha256Hex(f).slice(0, 16)}`);
    for (let bit = 0; bit < 64; bit++) v[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) if (v[bit] > 0) out |= 1n << BigInt(bit);
  return BigInt.asIntN(64, out);
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = (BigInt.asUintN(64, a) ^ BigInt.asUintN(64, b)) & MASK64;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export interface ClusterCandidate {
  id: string;
  clusterId: string | null;
  title: string;
  summary: string | null;
  simhash: bigint | null;
  firstSeenAt: Date;
}

export function isNearDuplicate(
  a: { title: string; summary: string | null; simhash: bigint | null },
  b: { title: string; summary: string | null; simhash: bigint | null },
): boolean {
  if (a.simhash !== null && b.simhash !== null && hammingDistance(a.simhash, b.simhash) <= SIMHASH_MAX_DISTANCE) return true;
  return jaccard(shingles(fingerprintText(a.title, a.summary)), shingles(fingerprintText(b.title, b.summary))) >= SHINGLE_JACCARD_MIN;
}

/**
 * Cluster a new signal joins. Among all near-duplicate candidates it always
 * picks the oldest cluster (earliest firstSeenAt, then smallest id), so two
 * replicas assigning concurrently converge on the same answer. Null when the
 * signal starts its own cluster.
 */
export function chooseCluster(
  signal: { title: string; summary: string | null; simhash: bigint | null },
  candidates: ClusterCandidate[],
): string | null {
  const matches = candidates
    .filter((c) => isNearDuplicate(signal, c))
    .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || (a.id < b.id ? -1 : 1));
  const first = matches[0];
  return first ? first.clusterId ?? first.id : null;
}

// ─── Category classifier ──────────────────────────────────────────────────────

/** Keyword lists in priority order; the order breaks ties. */
const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ['FED', ['federal reserve', 'fed ', 'fomc', 'fed rate', 'powell']],
  ['ECB', ['ecb', 'european central bank', 'lagarde']],
  ['ELECTION', ['election', 'senate', 'president', 'parliament', 'vote']],
  ['GEOPOLITICAL', ['sanctions', 'treaty', 'conflict', 'geopolitical', 'war']],
  ['CRYPTO', ['bitcoin', 'ethereum', 'crypto', 'defi']],
  ['SPORTS', ['nba', 'world cup', 'super bowl', 'premier league', 'championship']],
  ['ENTERTAINMENT', ['oscar', 'grammy', 'emmy', 'box office', 'billboard']],
];

/** Confidence of the MACRO fallback, when no keyword matched. */
export const FALLBACK_CONFIDENCE = 0.2;

export interface Classification {
  category: string;
  /** Matched keywords of the winning category over all matched keywords. */
  confidence: number;
}

export function classifyNewsCategory(title: string): Classification {
  const t = ` ${title.toLowerCase()} `;
  let total = 0;
  let best: { category: string; hits: number } | null = null;
  for (const [category, words] of CATEGORY_KEYWORDS) {
    const hits = words.filter((w) => t.includes(w)).length;
    total += hits;
    if (hits > 0 && (!best || hits > best.hits)) best = { category, hits };
  }
  if (!best) return { category: 'MACRO', confidence: FALLBACK_CONFIDENCE };
  return { category: best.category, confidence: Math.round((best.hits / total) * 1000) / 1000 };
}

// ─── Relevance ────────────────────────────────────────────────────────────────

/** Half-life of a signal's recency weight. */
export const RECENCY_HALF_LIFE_HOURS = 12;

export const sourceWeight = (source: string): number => SOURCE_WEIGHTS[source.toUpperCase()] ?? 0.5;

/** 1 for a signal published now, halving every RECENCY_HALF_LIFE_HOURS; never above 1. */
export function recencyDecay(publishedAt: Date, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
}

/**
 * relevance = sourceWeight × recencyDecay(age) × log2(1 + clusterSize)
 *
 * A story carried by several outlets counts more, but logarithmically, so
 * syndication cannot drown out a single primary source. FRED rows age from
 * when the observation was last seen (`ageFrom`), not from the observation
 * date, which is the start of the reporting period.
 */
export function relevanceScore(source: string, ageFrom: Date, clusterSize: number, now: Date): number {
  const score = sourceWeight(source) * recencyDecay(ageFrom, now) * Math.log2(1 + Math.max(1, clusterSize));
  return Math.round(score * 10_000) / 10_000;
}
