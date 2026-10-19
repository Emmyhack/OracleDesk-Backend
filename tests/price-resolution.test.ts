import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { prisma } from '../src/lib/prisma';
import type { ReflectorReader } from '../src/services/price-resolution.service';

setupTestEnv();

const REFLECTOR = 'CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR';
const FEED = {
  reflector: REFLECTOR,
  asset: { kind: 'other', symbol: 'BTC' } as const,
  quote: 'USD' as const,
  maxStaleness: 900,
  source: 'https://reflector.network/docs',
};

const NOW = new Date('2026-11-01T00:00:00Z');

function reader(over: Partial<ReflectorReader> = {}): ReflectorReader {
  return {
    decimals: async () => 6,
    supports: async () => true,
    lastPrice: async () => ({ price: 10_000_000_000n, timestamp: BigInt(Math.floor(NOW.getTime() / 1000)) }),
    ...over,
  } as ReflectorReader;
}

let logs: any[] = [];
function captureLogs() {
  logs = [];
  (prisma.agentLog.create as any) = async (a: any) => {
    logs.push(a.data);
    return a.data;
  };
}

test('toFixedPoint converts decimal thresholds exactly and rejects excess precision', async () => {
  const { toFixedPoint } = await import('../src/services/price-resolution.service');
  assert.equal(toFixedPoint('100000', 6), 100_000_000_000n);
  assert.equal(toFixedPoint('0.0001', 4), 1n);
  assert.equal(toFixedPoint('1', 0), 1n);
  assert.equal(toFixedPoint('1.23', 6), 1_230_000n);
  assert.throws(() => toFixedPoint('1e5', 6), /decimal/);
  assert.throws(() => toFixedPoint('-5', 6), /decimal/);
  assert.throws(() => toFixedPoint('0.00001', 4), /decimal places/);
});

test('rendered question text matches direction, asset, threshold and close time', async () => {
  const { renderPriceQuestion } = await import('../src/services/price-resolution.service');
  const closeTimeSecs = Math.floor(NOW.getTime() / 1000);
  assert.equal(
    renderPriceQuestion({ symbol: 'btc', direction: 'AtOrAbove', thresholdHuman: '100000', closeTimeSecs }),
    'Will the Reflector BTC/USD price be at or above 100,000 at 2026-11-01T00:00:00Z?',
  );
  assert.equal(
    renderPriceQuestion({ symbol: 'BTC', direction: 'Above', thresholdHuman: '100000', closeTimeSecs }),
    'Will the Reflector BTC/USD price be above 100,000 at 2026-11-01T00:00:00Z?',
  );
});

test('buildPriceSpec hash equals resolutionHash of the stored spec', async () => {
  const { buildPriceSpec } = await import('../src/services/price-resolution.service');
  const { resolutionHash } = await import('../src/lib/resolution-spec');
  const spec = buildPriceSpec({ threshold: '100000', direction: 'AtOrAbove' }, FEED, 6);
  assert.equal(spec.threshold, '100000000000000');
  assert.equal(spec.maxStaleness, 900);
  assert.deepEqual(
    resolutionHash(spec),
    resolutionHash({
      kind: 'price',
      reflector: REFLECTOR,
      asset: { kind: 'other', symbol: 'BTC' },
      threshold: '100000000000000',
      direction: 'AtOrAbove',
      maxStaleness: 900,
    }),
  );
});

test('unsupported asset falls back to signer mode and logs PRICE_SPEC_FALLBACK', async () => {
  const { planPriceMarket } = await import('../src/services/price-resolution.service');
  captureLogs();
  const plan = await planPriceMarket({
    category: 'CRYPTO',
    proposal: { asset: 'BTC', threshold: '100000', direction: 'AtOrAbove', close_timestamp: Math.floor(NOW.getTime() / 1000) },
    network: 'Test SDF Network ; September 2015',
    now: NOW,
    feed: FEED,
    reader: reader({ supports: async () => false }),
  });
  assert.equal(plan.spec, null);
  assert.equal(plan.question, null);
  assert.equal(logs[logs.length - 1]?.action, 'PRICE_SPEC_FALLBACK');
  assert.equal(logs[logs.length - 1]?.data?.reason, 'FEED_UNSUPPORTED');
});

test('stale feed at creation time blocks price mode', async () => {
  const { planPriceMarket } = await import('../src/services/price-resolution.service');
  captureLogs();
  const plan = await planPriceMarket({
    category: 'CRYPTO',
    proposal: { asset: 'BTC', threshold: '100000', direction: 'AtOrAbove', close_timestamp: Math.floor(NOW.getTime() / 1000) },
    network: 'Test SDF Network ; September 2015',
    now: NOW,
    feed: FEED,
    reader: reader({ lastPrice: async () => ({ price: 1n, timestamp: BigInt(Math.floor(NOW.getTime() / 1000) - 10_000) }) }),
  });
  assert.equal(plan.spec, null);
  assert.equal(logs[logs.length - 1]?.data?.reason, 'FEED_STALE');
  assert.equal(logs[logs.length - 1]?.action, 'PRICE_SPEC_FALLBACK');
});

test('a registered, fresh feed produces a price spec and rendered question', async () => {
  const { planPriceMarket } = await import('../src/services/price-resolution.service');
  const plan = await planPriceMarket({
    category: 'CRYPTO',
    proposal: { asset: 'BTC', threshold: '100000', direction: 'AtOrAbove', close_timestamp: Math.floor(NOW.getTime() / 1000) },
    network: 'Test SDF Network ; September 2015',
    now: NOW,
    feed: FEED,
    reader: reader(),
  });
  assert.equal(plan.spec?.kind, 'price');
  assert.equal(plan.spec?.threshold, '100000000000000');
  assert.match(plan.question ?? '', /Reflector BTC\/USD price be at or above 100,000/);
  assert.equal(plan.resolution?.decimals, 6);
});

test('maxStaleness 0 is rejected by validateResolutionSpec', async () => {
  const { validateResolutionSpec } = await import('../src/lib/resolution-spec');
  assert.throws(
    () =>
      validateResolutionSpec({
        kind: 'price',
        reflector: REFLECTOR,
        asset: { kind: 'other', symbol: 'BTC' },
        threshold: '1',
        direction: 'Above',
        maxStaleness: 0,
      }),
    /maxStaleness/,
  );
});

test('reveal after creation treats MarketAlreadyConfigured as success', async () => {
  const { revealPriceSpec } = await import('../src/services/price-resolution.service');
  const { ChainError } = await import('../src/services/stellar/errors');
  const spec = {
    kind: 'price' as const,
    reflector: REFLECTOR,
    asset: { kind: 'other' as const, symbol: 'BTC' },
    threshold: '1',
    direction: 'Above' as const,
    maxStaleness: 900,
  };
  const result = await revealPriceSpec(1n, spec, {
    register: (async () => {
      throw new ChainError('register_price_spec failed', 'MarketAlreadyConfigured');
    }) as any,
  });
  assert.equal(result.method, 'register_price_spec');
});

test('PriceUnavailable retries with backoff then escalates after the deadline', async () => {
  const { nextResolutionAction } = await import('../src/services/price-resolution.service');
  assert.deepEqual(nextResolutionAction('PriceUnavailable', 10, 3600, 0), {
    retry: true, escalate: false, delayMs: 250,
  });
  const past = nextResolutionAction('StalePrice', 4000, 3600, 2);
  assert.equal(past.retry, false);
  assert.equal(past.escalate, true);
  assert.equal(nextResolutionAction('SpecHashMismatch', 0, 3600, 0).retry, false);
  assert.equal(nextResolutionAction('MarketNotClosed', 0, 3600, 0).retry, true);
});

test('AlreadyFinalized ends the loop without error', async () => {
  const { runPriceResolutionTick } = await import('../src/services/price-resolution.service');
  const { ChainError } = await import('../src/services/stellar/errors');
  captureLogs();
  const market = { id: 'm1', onChainMarketId: 5n, expiryTimestamp: new Date('2026-10-01T00:00:00Z'), createdAt: NOW };
  const out = await runPriceResolutionTick({
    now: NOW,
    markets: [market],
    state: (async () => ({ tag: 'SignersPending', values: undefined })) as any,
    resolve: (async () => {
      throw new ChainError('resolve_price failed', 'AlreadyFinalized');
    }) as any,
  });
  assert.deepEqual(out, { resolved: [], escalated: [] });
  assert.equal(logs.length, 0);
});

test('PriceUnavailable past the deadline escalates with PRICE_RESOLUTION_STUCK', async () => {
  const { runPriceResolutionTick } = await import('../src/services/price-resolution.service');
  const { ChainError } = await import('../src/services/stellar/errors');
  captureLogs();
  const market = { id: 'm2', onChainMarketId: 6n, expiryTimestamp: new Date('2026-09-01T00:00:00Z'), createdAt: NOW };
  const out = await runPriceResolutionTick({
    now: NOW,
    markets: [market],
    state: (async () => ({ tag: 'Unconfigured', values: undefined })) as any,
    resolve: (async () => {
      throw new ChainError('resolve_price failed', 'PriceUnavailable');
    }) as any,
  });
  assert.deepEqual(out.escalated, [6n]);
  assert.equal(logs[logs.length - 1]?.action, 'PRICE_RESOLUTION_STUCK');
  assert.equal(logs[logs.length - 1]?.level, 'ERROR');
});
