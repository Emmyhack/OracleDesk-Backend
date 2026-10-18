/**
 * Canonicalisation parity (#64): the backend's canonicalJson must produce the
 * same bytes as the contracts repo's canonicalize (agents/core/trace.ts), or
 * every paid unlock fails the on-chain hash check. Needs the submodule but not
 * the x402 npm dependencies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { loadContractsTrace, skipOrFail } from './helpers/x402-harness';

setupTestEnv();

// Values both canonicalisers must encode identically.
const PARITY_CORPUS: Array<[string, unknown]> = [
  ['empty object', {}],
  ['key ordering', { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } }],
  ['deeply nested', { a: { b: { c: { d: { e: [{ f: 1, a: 0 }] } } } } }],
  ['arrays keep order', [3, 1, 2, { b: 1, a: 2 }]],
  ['undefined object member', { a: 1, b: undefined, c: { d: undefined } }],
  ['undefined in array', [1, undefined, 3, [undefined]]],
  ['null members', { a: null, b: [null] }],
  ['bigint', { stroops: 123456789012345678901234567890n, nested: [10n] }],
  ['unicode', { s: 'naïve café ✓ 日本語 😀 \u0000    ', 'ключ': 'значение' }],
  ['astral keys sort by UTF-16 units', { '😀': 1, '￿': 2, a: 3 }],
  ['negative zero', { z: -0, arr: [-0] }],
  ['large floats', { a: 1e21, b: 1.7976931348623157e308, c: 5e-324, d: 123456789.123456789 }],
  ['float formatting', { sum: 0.1 + 0.2, third: 1 / 3 }],
  ['integers', { a: 0, b: -1, c: 9007199254740991 }],
  ['special strings', { q: '"quoted"', bs: 'back\\slash', nl: 'a\nb', tab: '\t' }],
  ['booleans', { t: true, f: false }],
  ['top level scalar', 'just a string'],
  ['top level number', 42],
  ['top level null', null],
];

test('canonicalJson matches the contracts canonicalize over an edge-case corpus', async (t) => {
  const loaded = await loadContractsTrace();
  if (!loaded.ok) return skipOrFail(t, loaded.reason);
  const { canonicalJson } = await import('../src/utils/hash.util');

  for (const [name, value] of PARITY_CORPUS) {
    assert.equal(canonicalJson(value), loaded.value.canonicalize(value), `parity: ${name}`);
  }
});

test('known divergence: a Date is an ISO string in the backend but {} in the contracts repo', async (t) => {
  const loaded = await loadContractsTrace();
  if (!loaded.ok) return skipOrFail(t, loaded.reason);
  const { canonicalJson } = await import('../src/utils/hash.util');

  const d = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(canonicalJson({ d }), '{"d":"2026-01-02T03:04:05.000Z"}');
  assert.equal(loaded.value.canonicalize({ d }), '{"d":{}}');
  // Hence pinJson refuses it (next test) and the payload walker below proves
  // the backend never builds one.
});

test('pinJson rejects non-plain objects so the drift cannot be triggered silently', async () => {
  const { pinJson } = await import('../src/services/ipfs.service');
  class Thing { x = 1; }
  for (const bad of [
    { when: new Date() },
    { nested: [{ m: new Map() }] },
    { s: new Set([1]) },
    { t: new Thing() },
    { f: () => 1 },
    { sym: Symbol('x') },
  ]) {
    await assert.rejects(
      () => pinJson(bad, 'bad'),
      (err: any) => err.code === 'IPFS_NON_PLAIN_DOCUMENT' && err.statusCode === 422,
    );
  }
});

function findNonPlain(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findNonPlain(v, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return [`${path} (${(value as object).constructor?.name})`];
  return Object.entries(value).flatMap(([k, v]) => findNonPlain(v, `${path}.${k}`));
}

test('tracePayload never contains a Date or other class instance', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { generateReasoningTrace } = await import('../src/services/reasoning.service');
  const original = prisma.reasoningTrace.create;
  (prisma.reasoningTrace.create as any) = async ({ data }: any) => ({ id: 't1', ...data });
  try {
    const { tracePayload } = await generateReasoningTrace({
      marketId: 'm1',
      agentType: 'TRADER',
      decisionType: 'TRADE',
      sourcesUsed: [{ source: 'FRED', weight: 0.9, signal: 'CPI', rawValue: 0.6 }],
      probabilityEstimate: 0.6,
      marketProbability: 0.5,
      edge: 0.1,
      confidenceInterval: { lower: 0.5, upper: 0.7 },
      betFraction: 0.05,
      betSizeUsdc: 10,
      agentWallet: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    });
    assert.deepEqual(findNonPlain(tracePayload), []);
    assert.equal(typeof (tracePayload as Record<string, unknown>).timestamp, 'string', 'timestamp is pre-formatted, not a Date');
  } finally {
    (prisma.reasoningTrace.create as any) = original;
  }
});
