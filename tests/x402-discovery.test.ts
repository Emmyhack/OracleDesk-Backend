/**
 * Tests for x402 live trace price discovery (#63).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';
import { config } from '../src/config';
import { CONTRACTS } from '../src/config/contracts';
import {
  clearX402PriceCache,
  discoverLiveRequirements,
  discoverTracePrice,
  extractRequirementsFromResponse,
  setX402FetchImpl,
  validatePaymentRequirement,
} from '../src/services/x402-discovery.service';

setupTestEnv();

const TEST_RECIPIENT = Keypair.random().publicKey();

test.beforeEach(() => {
  clearX402PriceCache();
  (config as any).X402_SERVICE_URL = 'http://127.0.0.1:4020';
  (config as any).X402_DISCOVERY_TIMEOUT_MS = 2000;
  (config as any).X402_PRICE_CACHE_TTL_MS = 60000;
});

test.afterEach(() => {
  clearX402PriceCache();
});

test('validatePaymentRequirement accepts valid exact stellar requirement', () => {
  const req = {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: CONTRACTS.usdc,
    payTo: TEST_RECIPIENT,
    amount: '100000',
  };

  const validated = validatePaymentRequirement(req, 'http://127.0.0.1:4020/traces/1');
  assert.equal(validated.scheme, 'exact');
  assert.equal(validated.network, 'stellar:testnet');
  assert.equal(validated.amountRaw, '100000');
  assert.equal(validated.payTo, TEST_RECIPIENT);
  assert.ok(validated.amountUsdc.length > 0);
});

test('validatePaymentRequirement rejects unexpected scheme', () => {
  const req = {
    scheme: 'upto',
    network: 'stellar:testnet',
    asset: CONTRACTS.usdc,
    payTo: TEST_RECIPIENT,
    amount: '100000',
  };

  assert.throws(() => validatePaymentRequirement(req), /Unsupported payment scheme 'upto'/);
});

test('validatePaymentRequirement rejects mismatched network', () => {
  const req = {
    scheme: 'exact',
    network: 'eip155:1',
    asset: CONTRACTS.usdc,
    payTo: TEST_RECIPIENT,
    amount: '100000',
  };

  assert.throws(() => validatePaymentRequirement(req), /Payment network 'eip155:1' does not match/);
});

test('validatePaymentRequirement rejects mismatched asset', () => {
  const req = {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    payTo: TEST_RECIPIENT,
    amount: '100000',
  };

  assert.throws(() => validatePaymentRequirement(req), /does not match expected USDC/);
});

test('validatePaymentRequirement rejects non-numeric or negative amount', () => {
  assert.throws(
    () =>
      validatePaymentRequirement({
        scheme: 'exact',
        network: 'stellar:testnet',
        asset: CONTRACTS.usdc,
        payTo: TEST_RECIPIENT,
        amount: '-100',
      }),
    /Malformed payment amount/,
  );

  assert.throws(
    () =>
      validatePaymentRequirement({
        scheme: 'exact',
        network: 'stellar:testnet',
        asset: CONTRACTS.usdc,
        payTo: TEST_RECIPIENT,
        amount: '0',
      }),
    /must be greater than zero/,
  );

  assert.throws(
    () =>
      validatePaymentRequirement({
        scheme: 'exact',
        network: 'stellar:testnet',
        asset: CONTRACTS.usdc,
        payTo: TEST_RECIPIENT,
        amount: 'invalid',
      }),
    /Malformed payment amount/,
  );
});

test('validatePaymentRequirement rejects invalid recipient address', () => {
  assert.throws(
    () =>
      validatePaymentRequirement({
        scheme: 'exact',
        network: 'stellar:testnet',
        asset: CONTRACTS.usdc,
        payTo: 'not-a-stellar-key',
        amount: '100000',
      }),
    /Invalid payment recipient/,
  );
});

test('extractRequirementsFromResponse extracts from base64 payment-required header', async () => {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'stellar:testnet',
        asset: CONTRACTS.usdc,
        payTo: TEST_RECIPIENT,
        amount: '100000',
      },
    ],
  };

  const headerVal = Buffer.from(JSON.stringify(payload)).toString('base64');
  const res = new Response(null, {
    status: 402,
    headers: { 'payment-required': headerVal },
  });

  const validated = await extractRequirementsFromResponse(res, 'http://test/traces/1');
  assert.equal(validated.amountRaw, '100000');
  assert.equal(validated.payTo, TEST_RECIPIENT);
});

test('extractRequirementsFromResponse rejects non-402 response (e.g. 200 OK)', async () => {
  const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
  await assert.rejects(
    () => extractRequirementsFromResponse(res, 'http://test/traces/1'),
    /Expected 402 Payment Required response/,
  );
});

test('discoverLiveRequirements hits cache on subsequent calls and supports TTL', async () => {
  let fetchCount = 0;
  const restore = setX402FetchImpl(async () => {
    fetchCount++;
    const payload = {
      accepts: [
        {
          scheme: 'exact',
          network: 'stellar:testnet',
          asset: CONTRACTS.usdc,
          payTo: TEST_RECIPIENT,
          amount: '100000',
        },
      ],
    };
    return new Response(JSON.stringify(payload), { status: 402 });
  });

  try {
    const first = await discoverLiveRequirements('/traces/preview');
    assert.ok(first);
    assert.equal(first.amountRaw, '100000');
    assert.equal(fetchCount, 1);

    // Second call: cache hit
    const second = await discoverLiveRequirements('/traces/preview');
    assert.ok(second);
    assert.equal(second.amountRaw, '100000');
    assert.equal(fetchCount, 1, 'subsequent call should hit cache');

    // Force refresh bypasses cache
    const third = await discoverLiveRequirements('/traces/preview', { forceRefresh: true });
    assert.ok(third);
    assert.equal(fetchCount, 2, 'force refresh should invoke fetch');
  } finally {
    restore();
  }
});

test('stampede protection prevents concurrent request flood', async () => {
  let activeFetches = 0;
  let maxActive = 0;
  let totalFetches = 0;

  const restore = setX402FetchImpl(async () => {
    totalFetches++;
    activeFetches++;
    maxActive = Math.max(maxActive, activeFetches);
    await new Promise((r) => setTimeout(r, 50));
    activeFetches--;
    return new Response(
      JSON.stringify({
        accepts: [
          {
            scheme: 'exact',
            network: 'stellar:testnet',
            asset: CONTRACTS.usdc,
            payTo: TEST_RECIPIENT,
            amount: '100000',
          },
        ],
      }),
      { status: 402 },
    );
  });

  try {
    // Fire 10 concurrent discovery calls
    const results = await Promise.all(
      Array.from({ length: 10 }, () => discoverLiveRequirements('/traces/stampede')),
    );

    assert.equal(results.length, 10);
    for (const r of results) {
      assert.ok(r);
      assert.equal(r?.amountRaw, '100000');
    }
    assert.equal(totalFetches, 1, 'stampede protection should coalesce into single fetch');
    assert.equal(maxActive, 1);
  } finally {
    restore();
  }
});

test('discoverTracePrice returns unknown when service fails or unconfigured', async () => {
  (config as any).X402_SERVICE_URL = '';
  const price = await discoverTracePrice('trace-123');
  assert.equal(price.status, 'unknown');
  assert.equal(price.amountRaw, '');
  assert.equal(price.requirements, null);
});

test('discoverTracePrice returns unknown on network timeout or 500 error', async () => {
  const restore = setX402FetchImpl(async () => {
    return new Response('Internal Server Error', { status: 500 });
  });

  try {
    const price = await discoverTracePrice('trace-500');
    assert.equal(price.status, 'unknown');
    assert.equal(price.amountRaw, '');
    assert.equal(price.requirements, null);
  } finally {
    restore();
  }
});
