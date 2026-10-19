/**
 * Record/replay ("cassettes") for LLM and data-source traffic (#72).
 *
 *   await useCassette('agents/market-maker-happy', async (cassette) => {
 *     await runMarketMakerCycle();
 *     assert.deepEqual(cassette.calls.map((c) => c.kind), ['http', 'http', 'anthropic', ...]);
 *   });
 *
 * Modes, from CASSETTE_MODE (default `replay`, the only mode CI uses):
 *
 *   replay  every Anthropic, Gemini and data-source request is matched by a
 *           stable fingerprint and served from tests/cassettes/<name>.json. An
 *           unmatched request throws CassetteMiss with a diff against the
 *           closest recorded request; an interaction left unused fails the
 *           test at teardown.
 *   record  requires CASSETTE_RECORD=1. Requests go to the real providers (or
 *           to `opts.upstream`, scripted responses used to author synthetic
 *           cassettes with CASSETTE_UPSTREAM=scripted) and the normalised,
 *           redacted pairs are written on teardown, after the secret guard.
 *   off     real transports, nothing recorded. Local only; refused under CI.
 *
 * Fingerprint = sha256(canonicalJson(normalise(kind, request))), where
 * normalise drops credential keys everywhere, sorts query parameters and
 * replaces ISO-8601 timestamps, UUIDs and block nonces in strings with
 * placeholders. Equal fingerprints are served in recorded order.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Hex } from '../../src/utils/hash.util';

export type InteractionKind = 'anthropic' | 'gemini' | 'http';

export interface RecordedError {
  status?: number;
  name?: string;
  message: string;
}

export interface Interaction {
  kind: InteractionKind;
  fingerprint: string;
  request: unknown;
  response?: unknown;
  error?: RecordedError;
  recordedAt: string;
}

export interface CassetteFile {
  version: 1;
  /** True for cassettes authored from scripted upstream responses rather than live providers. */
  synthetic?: boolean;
  note?: string;
  interactions: Interaction[];
}

export const CASSETTE_DIR = join(__dirname, '..', '..', '..', 'tests', 'cassettes');

// ─── Normalisation ────────────────────────────────────────────────────────────

const CREDENTIAL_KEY = /^(api_?key|apiKey|key|authorization|x-goog-api-key)$/i;
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** renderUntrustedBlock's per-call random nonce. */
const NONCE = /nonce="[0-9a-f]{6,32}"/g;

function scrubString(s: string): string {
  return s.replace(ISO_TS, '<TIMESTAMP>').replace(UUID, '<UUID>').replace(NONCE, 'nonce="<NONCE>"');
}

function deep(value: unknown, onString: (s: string) => string): unknown {
  if (typeof value === 'string') return onString(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => deep(v, onString));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k, v]) => !CREDENTIAL_KEY.test(k) && v !== undefined)
        .map(([k, v]) => [k, deep(v, onString)]),
    );
  }
  return value instanceof Date ? onString(value.toISOString()) : value;
}

/** The request as stored and fingerprinted: no credentials, no volatile text, sorted params. */
export function normalise(kind: InteractionKind, req: unknown): unknown {
  const copy = deep(req, scrubString) as Record<string, unknown>;
  if (kind === 'http' && copy && typeof copy === 'object') {
    // Query values are strings on the wire, whether given as numbers or in the URL.
    const params = (copy.params ?? {}) as Record<string, unknown>;
    copy.params = Object.fromEntries(Object.keys(params).sort().map((k) => [k, typeof params[k] === 'object' ? params[k] : String(params[k])]));
    // A query string baked into the URL is split out and sorted the same way.
    const url = String(copy.url ?? '');
    const q = url.indexOf('?');
    if (q >= 0) {
      const extra = new URLSearchParams(url.slice(q + 1));
      for (const [k, v] of [...extra.entries()]) if (!CREDENTIAL_KEY.test(k)) (copy.params as Record<string, unknown>)[k] = scrubString(v);
      copy.url = url.slice(0, q);
      copy.params = Object.fromEntries(Object.keys(copy.params as object).sort().map((k) => [k, (copy.params as any)[k]]));
    }
  }
  return copy;
}

export function fingerprint(kind: InteractionKind, req: unknown): string {
  return sha256Hex(canonicalJson({ kind, request: normalise(kind, req) }));
}

// ─── Secret guard ─────────────────────────────────────────────────────────────

export const SECRET_ENV = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'NEWSAPI_KEY', 'FRED_API_KEY', 'OPENAI_API_KEY'] as const;

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['google key', /AIza[0-9A-Za-z_-]{20,}/],
  ['32-hex key in a key-like field', /"(?:api_?key|apikey|key|token|secret|authorization)"\s*:\s*"[0-9a-fA-F]{32}"/i],
  ['32-hex key in a query string', /[?&](?:api_?key|apikey|key|token)=[0-9a-fA-F]{32}\b/i],
];

export class CassetteSecretError extends Error {
  constructor(public readonly findings: string[]) {
    super(`Refusing to write a cassette that contains secrets: ${findings.join('; ')}`);
    this.name = 'CassetteSecretError';
  }
}

/** Every reason `text` may hold a secret: a configured key's value or a key-shaped string. */
export function scanForSecrets(text: string, extraValues: string[] = []): string[] {
  const findings: string[] = [];
  const values = [...SECRET_ENV.map((n) => process.env[n] ?? ''), ...extraValues].filter((v) => v.length >= 8);
  for (const v of values) if (text.includes(v)) findings.push('a configured API key value');
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) findings.push(name);
  return findings;
}

export function assertNoSecrets(text: string, extraValues: string[] = []): void {
  const findings = scanForSecrets(text, extraValues);
  if (findings.length > 0) throw new CassetteSecretError(findings);
}

/** Every committed cassette file, for the scan in tests/cassettes-secrets.test.ts. */
export function listCassetteFiles(dir = CASSETTE_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listCassetteFiles(path) : name.endsWith('.json') ? [path] : [];
  });
}

// ─── Third-party content ──────────────────────────────────────────────────────

/** Characters of a NewsAPI title/description the prompt can use. */
export const NEWS_TEXT_CHARS = 180;
/** Articles the market prompt can show (NEWS_LIMIT in market.service.ts). */
export const NEWS_ARTICLES = 6;

/**
 * Article text is third-party copyrighted content: a recorded NewsAPI response
 * keeps only the articles the prompt can use, their text cut to what it
 * shows, and no `content` body.
 */
export function trimResponse(kind: InteractionKind, request: any, response: any): unknown {
  if (kind === 'http' && String(request?.url ?? '').includes('newsapi.org') && Array.isArray(response?.articles)) {
    return {
      ...response,
      articles: response.articles.slice(0, NEWS_ARTICLES).map((a: any) => ({
        source: a.source, title: typeof a.title === 'string' ? a.title.slice(0, NEWS_TEXT_CHARS) : a.title,
        description: typeof a.description === 'string' ? a.description.slice(0, NEWS_TEXT_CHARS) : a.description,
        url: a.url, publishedAt: a.publishedAt,
      })),
    };
  }
  return response;
}

// ─── Miss diagnostics ─────────────────────────────────────────────────────────

/** Levenshtein distance on at most the first `cap` characters (diagnostics only). */
export function levenshtein(a: string, b: string, cap = 4_000): number {
  const s = a.slice(0, cap);
  const t = b.slice(0, cap);
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

const promptText = (req: unknown) => JSON.stringify(req, null, 1);

function lineDiff(actual: string, recorded: string, max = 25): string {
  const a = actual.split('\n');
  const r = recorded.split('\n');
  const rs = new Set(r);
  const as = new Set(a);
  const out = [
    ...a.filter((l) => !rs.has(l)).map((l) => `+ ${l}`),
    ...r.filter((l) => !as.has(l)).map((l) => `- ${l}`),
  ];
  return out.slice(0, max).join('\n') + (out.length > max ? `\n… ${out.length - max} more lines` : '');
}

export class CassetteMiss extends Error {
  constructor(
    public readonly kind: InteractionKind,
    public readonly request: unknown,
    public readonly closest: Interaction | null,
    cassette: string,
  ) {
    const diff = closest
      ? `closest recorded ${kind} request (+ actual, - recorded):\n${lineDiff(promptText(request), promptText(closest.request))}`
      : `no ${kind} interactions left in the cassette`;
    super(`CassetteMiss in ${cassette}: unmatched ${kind} request.\n${diff}\nRe-record with CASSETTE_MODE=record CASSETTE_RECORD=1 (see CONTRIBUTING.md).`);
    this.name = 'CassetteMiss';
  }
}

// ─── Cassette ─────────────────────────────────────────────────────────────────

export type CassetteMode = 'replay' | 'record' | 'off';

export function cassetteMode(): CassetteMode {
  const mode = (process.env.CASSETTE_MODE ?? 'replay') as CassetteMode;
  if (!['replay', 'record', 'off'].includes(mode)) throw new Error(`CASSETTE_MODE must be replay, record or off (got ${mode})`);
  if (process.env.CI && mode !== 'replay') throw new Error('CI runs cassettes in replay mode only');
  if (mode === 'record' && process.env.CASSETTE_RECORD !== '1') {
    throw new Error('CASSETTE_MODE=record also needs CASSETTE_RECORD=1 (it calls paid providers)');
  }
  return mode;
}

/** An error rebuilt from a recording: same message, status and name, so callers classify it the same way. */
function rebuildError(e: RecordedError): Error {
  const err = new Error(e.message) as Error & { status?: number };
  if (e.name) err.name = e.name;
  if (e.status !== undefined) err.status = e.status;
  return err;
}

function captureError(err: unknown): RecordedError {
  const e = err as { status?: unknown; name?: unknown; message?: unknown };
  return {
    ...(typeof e?.status === 'number' ? { status: e.status } : {}),
    ...(typeof e?.name === 'string' ? { name: e.name } : {}),
    message: String(e?.message ?? err).slice(0, 500),
  };
}

export class Cassette {
  readonly calls: Array<{ kind: InteractionKind; fingerprint: string; request: unknown }> = [];
  private readonly used = new Set<number>();
  private readonly recorded: Interaction[] = [];

  constructor(
    readonly name: string,
    readonly mode: CassetteMode,
    readonly file: CassetteFile,
  ) {}

  get path(): string {
    return join(CASSETTE_DIR, `${this.name}.json`);
  }

  /** The cassette's interactions: the file in replay mode, what has been recorded so far otherwise. */
  get interactions(): Interaction[] {
    return this.mode === 'replay' ? this.file.interactions : this.recorded;
  }

  /** Recorded response of the n-th interaction of `kind` (for assertions that follow the recording). */
  responseOf(kind: InteractionKind, n = 0): any {
    return this.interactions.filter((i) => i.kind === kind && !i.error)[n]?.response;
  }

  /**
   * Serves one request. Replay: from the cassette. Record/off: through
   * `live`, recording the normalised pair in record mode.
   */
  async serve<T>(kind: InteractionKind, request: unknown, live: () => Promise<T>): Promise<T> {
    const fp = fingerprint(kind, request);
    this.calls.push({ kind, fingerprint: fp, request: normalise(kind, request) });

    if (this.mode === 'replay') {
      const idx = this.file.interactions.findIndex((x, i) => !this.used.has(i) && x.kind === kind && x.fingerprint === fp);
      if (idx < 0) {
        const pool = this.file.interactions.filter((x, i) => !this.used.has(i) && x.kind === kind);
        const text = promptText(normalise(kind, request));
        const closest = pool.length === 0 ? null : pool
          .map((x) => ({ x, d: levenshtein(text, promptText(x.request)) }))
          .sort((a, b) => a.d - b.d)[0].x;
        throw new CassetteMiss(kind, normalise(kind, request), closest, this.name);
      }
      this.used.add(idx);
      const hit = this.file.interactions[idx];
      if (hit.error) throw rebuildError(hit.error);
      return structuredClone(hit.response) as T;
    }

    try {
      const response = await live();
      if (this.mode === 'record') {
        this.recorded.push({
          kind, fingerprint: fp, request: normalise(kind, request),
          response: deep(trimResponse(kind, request, response), (s) => s), recordedAt: new Date().toISOString(),
        });
      }
      return response;
    } catch (err) {
      if (this.mode === 'record') {
        this.recorded.push({ kind, fingerprint: fp, request: normalise(kind, request), error: captureError(err), recordedAt: new Date().toISOString() });
      }
      throw err;
    }
  }

  /** Replay: every interaction must have been used. Record: write the file (secret guard first). */
  finish(opts: { synthetic?: boolean; note?: string; extraSecrets?: string[] } = {}): void {
    if (this.mode === 'replay') {
      const unused = this.file.interactions.map((x, i) => ({ x, i })).filter(({ i }) => !this.used.has(i));
      if (unused.length > 0) {
        throw new Error(
          `Cassette ${this.name}: ${unused.length} recorded interaction(s) were never requested ` +
          `(${unused.map(({ x, i }) => `#${i} ${x.kind}`).join(', ')}). The code no longer makes them, ` +
          'or a cache answered first; re-record or fix the test setup.',
        );
      }
      return;
    }
    if (this.mode === 'record') {
      const file: CassetteFile = {
        version: 1,
        ...(opts.synthetic ? { synthetic: true } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        interactions: this.recorded,
      };
      const text = JSON.stringify(file, null, 2) + '\n';
      assertNoSecrets(text, opts.extraSecrets);
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, text);
    }
  }
}

export function loadCassette(name: string, mode: CassetteMode = cassetteMode()): Cassette {
  const path = join(CASSETTE_DIR, `${name}.json`);
  if (mode === 'replay') {
    if (!existsSync(path)) throw new Error(`Cassette ${name} not found at ${path}; record it first (CONTRIBUTING.md)`);
    return new Cassette(name, mode, JSON.parse(readFileSync(path, 'utf8')) as CassetteFile);
  }
  return new Cassette(name, mode, { version: 1, interactions: [] });
}

// ─── Seams ────────────────────────────────────────────────────────────────────

/** Real (or scripted) providers used in record and off modes. */
export interface Upstream {
  anthropic?: (req: any) => Promise<any>;
  gemini?: (req: any) => Promise<{ text: string; usage?: object }>;
  http?: (url: string, opts: { params?: Record<string, unknown> }) => Promise<{ data: unknown }>;
}

async function liveUpstream(): Promise<Upstream> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const axios = (await import('axios')).default;
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  const geminiKey = process.env.GEMINI_API_KEY ?? '';
  const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey, maxRetries: 0 }) : null;
  const genAI = geminiKey ? new GoogleGenerativeAI(geminiKey) : null;
  return {
    anthropic: async (req) => {
      if (!anthropic) throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { status: 401 });
      return anthropic.messages.create(req);
    },
    gemini: async (req) => {
      if (!genAI) throw Object.assign(new Error('GEMINI_API_KEY is not set'), { status: 401 });
      const model = genAI.getGenerativeModel({ model: req.model, systemInstruction: req.systemInstruction, generationConfig: req.generationConfig });
      const res = await model.generateContent(req.prompt);
      return { text: res.response.text(), usage: res.response.usageMetadata };
    },
    http: (url, opts) => axios.get(url, { params: opts.params, timeout: 10_000 }),
  };
}

/** Rebuilds the slice of an Anthropic Message the code reads (SDK types change between minor versions). */
function toMessage(raw: any): any {
  return { id: raw?.id ?? 'msg_cassette', type: 'message', role: 'assistant', model: raw?.model, content: raw?.content ?? [], stop_reason: raw?.stop_reason ?? 'end_turn', usage: raw?.usage ?? { input_tokens: 0, output_tokens: 0 } };
}

/**
 * Installs the Anthropic, Gemini and data-source seams for the duration of
 * `fn`, then restores them. In replay mode every interaction must be used.
 */
export async function useCassette<T>(
  name: string,
  fn: (cassette: Cassette) => Promise<T>,
  opts: { upstream?: Upstream; synthetic?: boolean; note?: string; extraSecrets?: string[] } = {},
): Promise<T> {
  const mode = cassetteMode();
  const cassette = loadCassette(name, mode);
  const useScripted = process.env.CASSETTE_UPSTREAM === 'scripted';
  const upstream: Upstream = mode === 'replay' ? {} : useScripted ? (opts.upstream ?? {}) : await liveUpstream();
  const missing = (what: string) => async (): Promise<never> => { throw new Error(`no ${what} upstream for ${name}`); };

  const llm = await import('../../src/lib/llm');
  const ingestion = await import('../../src/services/ingestion.service');
  const prevAnthropic = llm.setAnthropicTransport({
    create: (req) => cassette.serve('anthropic', req, async () => toMessage(await (upstream.anthropic ?? missing('anthropic'))(req))),
  });
  const prevGemini = llm.setGeminiTransport({
    generate: (req) => cassette.serve('gemini', req, () => (upstream.gemini ?? missing('gemini'))(req)),
  });
  // The provider's JSON body is what gets recorded (and trimmed), not the wrapper.
  const prevHttp = ingestion.setSignalHttp({
    get: async (url, o) => ({
      data: await cassette.serve('http', { method: 'GET', url, params: o.params ?? {} }, async () =>
        (await (upstream.http ?? missing('http'))(url, { params: o.params })).data),
    }) as any,
  });
  try {
    const result = await fn(cassette);
    cassette.finish({ synthetic: opts.synthetic ?? useScripted, note: opts.note, extraSecrets: opts.extraSecrets });
    return result;
  } finally {
    llm.setAnthropicTransport(prevAnthropic);
    llm.setGeminiTransport(prevGemini);
    ingestion.setSignalHttp(prevHttp);
  }
}
