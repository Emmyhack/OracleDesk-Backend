import crypto from 'crypto';

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, bigints
 * as decimal strings. Same rules as agents/core/trace.ts `canonicalize` in
 * the contracts repo, so a trace hashes the same on both sides.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = sortKeysDeep(v);
    }
    return sorted;
  }
  return value;
}

/**
 * Thrown by {@link assertPlainJson} for values the contracts repo's
 * `canonicalize` (agents/core/trace.ts) would encode differently from
 * `canonicalJson`, which would make the pinned bytes fail the x402 service's
 * on-chain hash check.
 */
export class NonPlainJsonError extends Error {
  constructor(public readonly path: string, public readonly kind: string) {
    super(`Cannot canonicalise ${kind} at ${path}: only plain JSON values may be pinned`);
    this.name = 'NonPlainJsonError';
  }
}

/**
 * Rejects anything that is not a plain JSON value (null, boolean, string,
 * number, bigint, arrays and plain objects). In particular `Date`, `Map`,
 * `Set`, class instances and functions are refused: the backend would turn a
 * `Date` into an ISO string while the contracts canonicaliser emits `{}`, so
 * the two sides would hash different bytes. Format such values before they
 * reach the document (e.g. `date.toISOString()`).
 */
export function assertPlainJson(value: unknown, path = '$'): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'number':
    case 'bigint':
    case 'undefined':
      return;
    case 'object': {
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertPlainJson(v, `${path}[${i}]`));
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new NonPlainJsonError(path, (value as object).constructor?.name ?? 'non-plain object');
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        assertPlainJson(v, `${path}.${k}`);
      }
      return;
    }
    default:
      throw new NonPlainJsonError(path, typeof value);
  }
}

/**
 * Stricter than {@link assertPlainJson}, for blocks that are embedded in a
 * pinned document by hand (#66): additionally rejects `undefined` (canonicalJson
 * would drop the key silently) and non-finite numbers (JSON turns them into
 * null). Key order does not matter; canonicalJson sorts.
 */
export function assertCanonicalSafe(value: unknown, path = '$'): void {
  if (value === undefined) throw new NonPlainJsonError(path, 'undefined');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new NonPlainJsonError(path, 'non-finite number');
  assertPlainJson(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => assertCanonicalSafe(v, `${path}[${i}]`));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertCanonicalSafe(v, `${path}.${k}`);
  }
}

/** Canonical bytes for a JSON document. Hash and upload these exact bytes. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Same check as x402/trace-verification.ts in the contracts repo. */
export function verifyTraceHash(content: Uint8Array, expectedHash: string): boolean {
  const normalized = expectedHash.toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(normalized) && sha256Hex(content) === normalized;
}
