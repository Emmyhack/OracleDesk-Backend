import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

test('market proposal validation accepts strict binary JSON and rejects malformed confidence intervals', async () => {
  const { validateMarketQuestion } = await import('../src/services/market.service');

  const valid = validateMarketQuestion(JSON.stringify({
    market_question: 'Will the Federal Reserve cut rates by June 30, 2026?',
    initial_yes_probability: 0.62,
    resolution_oracle: 'FRED',
    expiry_timestamp: 1782777600,
    settlement_currency: 'USDC',
    minimum_liquidity_usdc: 100,
    category: 'FED',
    confidence_interval: { lower: 0.52, upper: 0.72 },
    reasoning: 'Fed signals and inflation trends support a rate cut probability.',
    grounding_signal_ids: ['n1'],
  }));

  assert.equal(valid.category, 'FED');
  assert.equal(valid.initial_yes_probability, 0.62);

  assert.throws(() => validateMarketQuestion(JSON.stringify({
    ...valid,
    confidence_interval: { lower: 0.7, upper: 0.8 },
  })), /Probability must be within the confidence interval/);
});

test('probability, confidence interval, and edge calculations are deterministic', async () => {
  const { calculateProbability } = await import('../src/services/market.service');
  const { calculateConfidenceInterval, calculateEdge } = await import('../src/services/reasoning.service');

  const signals = [
    { source: 'FRED', weight: 0.9, signal: 'Rates falling', rawValue: 0.7 },
    { source: 'NEWSAPI', weight: 0.7, signal: 'Dovish comments', rawValue: 0.6 },
    { source: 'GDELT', weight: 0.6, signal: 'Macro stress', rawValue: 0.55 },
  ];

  const estimate = calculateProbability(signals, 0.5);
  const ci = calculateConfidenceInterval(signals, estimate.probability);

  assert.equal(calculateEdge(0.68, 0.51), 0.17);
  assert.ok(estimate.probability > 0.59);
  assert.ok(estimate.confidenceInterval.lower < estimate.probability);
  assert.ok(ci.lower <= ci.upper);
});

test('kelly sizing caps single-position exposure', async () => {
  const { calculateKellySize } = await import('../src/services/trade.service');

  const result = calculateKellySize({
    agentProbability: 0.7,
    marketProbability: 0.5,
    bankroll: 10_000,
    netOdds: 1,
  });

  assert.equal(result.halfKelly, 0.025);
  assert.equal(result.betSize, 250);
});


test('questionDocument emits v1 unchanged without resolutionDetails and v2 with it; both hash deterministically', async () => {
  const { questionDocument } = await import('../src/services/market-chain.service');
  const { canonicalBytes, sha256Hex } = await import('../src/utils/hash.util');
  const market: any = {
    id: 'm1', question: 'Will CPI for September 2026 exceed 3%?', category: 'MACRO',
    expiryTimestamp: new Date('2026-10-17T05:00:00Z'), resolutionOracle: 'BLS', resolutionDetails: null,
  };
  const hash = 'ab'.repeat(32);

  const v1 = questionDocument(market, hash);
  assert.equal(v1.version, 1);
  assert.ok(!('resolution' in v1));
  assert.deepEqual(Object.keys(v1).sort(), [
    'backendMarketId', 'category', 'closeTime', 'contractCategory', 'question', 'resolutionHash', 'resolutionSource', 'version',
  ]);
  assert.equal(sha256Hex(canonicalBytes(v1)), sha256Hex(canonicalBytes(questionDocument(market, hash))));

  const resolution = {
    sourceId: 'BLS', url: 'https://www.bls.gov/news.release/', measurable: 'CPI', comparator: '>',
    threshold: { value: 3, unit: '%', text: '3%' }, deadlineUtc: '2026-10-01T03:59:59.000Z', instructions: 'First release only.',
  };
  const v2 = questionDocument({ ...market, resolutionDetails: resolution }, hash);
  assert.equal(v2.version, 2);
  assert.deepEqual((v2 as any).resolution, resolution);
  assert.equal(sha256Hex(canonicalBytes(v2)), sha256Hex(canonicalBytes(questionDocument({ ...market, resolutionDetails: resolution }, hash))));
  assert.notEqual(sha256Hex(canonicalBytes(v1)), sha256Hex(canonicalBytes(v2)));
  // v1 fields are a subset of v2, so v1 readers keep working.
  for (const [k, v] of Object.entries(v1)) if (k !== 'version') assert.deepEqual((v2 as any)[k], v);
});
