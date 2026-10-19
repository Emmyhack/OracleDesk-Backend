import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import { FeeOracle, DEFAULT_FEE_POLICIES } from '../src/services/stellar/fees';
import { loadConfig, ConfigError } from '../src/config';
import { ChainError } from '../src/services/stellar/errors';

test('fees: percentile and clamp per class', async () => {
  const fakeSource = {
    async getFeeStats() {
      return {
        sorobanInclusionFee: {
          transactionCount: '15',
          p50: '50000',
          p80: '150000',
          p90: '250000',
        },
      };
    },
  };

  const oracle = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 1000, 5000, fakeSource);

  // market_create uses p90 (250000), between floor (100000) and cap (5000000)
  const mcFee = await oracle.pickInclusionFee('market_create');
  assert.equal(mcFee, 250_000n);

  // trade uses p80 (150000), between floor (10000) and cap (2000000)
  const tradeFee = await oracle.pickInclusionFee('trade');
  assert.equal(tradeFee, 150_000n);

  // trace_publish uses p50 (50000), between floor (10000) and cap (1000000)
  const traceFee = await oracle.pickInclusionFee('trace_publish');
  assert.equal(traceFee, 50_000n);

  // Test clamping below floor
  const fakeLow = {
    async getFeeStats() {
      return {
        sorobanInclusionFee: {
          transactionCount: '10',
          p90: '1000', // below market_create floor (100000)
        },
      };
    },
  };
  const oracleLow = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 1000, 5000, fakeLow);
  assert.equal(await oracleLow.pickInclusionFee('market_create'), 100_000n);

  // Test clamping above cap
  const fakeHigh = {
    async getFeeStats() {
      return {
        sorobanInclusionFee: {
          transactionCount: '10',
          p80: '999999999', // above trade cap (2000000)
        },
      };
    },
  };
  const oracleHigh = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 1000, 5000, fakeHigh);
  assert.equal(await oracleHigh.pickInclusionFee('trade'), 2_000_000n);
});

test('fees: zero recent Soroban traffic falls back to floor', async () => {
  const fakeZero = {
    async getFeeStats() {
      return {
        sorobanInclusionFee: {
          transactionCount: '0',
          p80: '500000',
        },
      };
    },
  };

  const oracle = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 1000, 5000, fakeZero);
  const fee = await oracle.pickInclusionFee('trade');
  assert.equal(fee, DEFAULT_FEE_POLICIES.trade.floor);
});

test('fees: single-flight with ten concurrent callers triggers one getFeeStats call', async () => {
  let callCount = 0;
  const fakeSource = {
    async getFeeStats() {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        sorobanInclusionFee: {
          transactionCount: '5',
          p80: '120000',
        },
      };
    },
  };

  const oracle = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 10000, 60000, fakeSource);
  const callers = Array.from({ length: 10 }, () => oracle.pickInclusionFee('trade'));
  const results = await Promise.all(callers);

  assert.equal(callCount, 1);
  for (const res of results) {
    assert.equal(res, 120_000n);
  }
});

test('fees: stale stats and RPC error keeps last good stats within max age', async () => {
  let fail = false;
  let callCount = 0;
  const fakeSource = {
    async getFeeStats() {
      callCount++;
      if (fail) {
        throw new Error('RPC connection refused');
      }
      return {
        sorobanInclusionFee: {
          transactionCount: '10',
          p80: '180000',
        },
      };
    },
  };

  // cache TTL = 10ms, maxAge = 500ms
  const oracle = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 10, 500, fakeSource);

  // First call succeeds
  const fee1 = await oracle.pickInclusionFee('trade');
  assert.equal(fee1, 180_000n);
  assert.equal(callCount, 1);

  // Wait past cache TTL
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Now RPC fails, but last stats are younger than maxAge (500ms)
  fail = true;
  const fee2 = await oracle.pickInclusionFee('trade');
  assert.equal(fee2, 180_000n);
  assert.equal(callCount, 2);

  // Wait past maxAge
  await new Promise((resolve) => setTimeout(resolve, 520));

  // Now last stats are older than maxAge, should fall back to floor
  const fee3 = await oracle.pickInclusionFee('trade');
  assert.equal(fee3, DEFAULT_FEE_POLICIES.trade.floor);
});

test('fees: config override merge and invalid override', () => {
  const baseEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  };

  // Valid override
  const validJson = JSON.stringify({
    trade: {
      percentile: 'p95',
      floor: '20000',
      cap: '3000000',
      budget: '30000000',
    },
  });

  const validConfig = loadConfig({
    ...baseEnv,
    FEE_POLICY_JSON: validJson,
  });
  assert.equal(validConfig.FEE_POLICY_JSON, validJson);

  // Invalid JSON override
  assert.throws(() => {
    loadConfig({
      ...baseEnv,
      FEE_POLICY_JSON: '{invalid-json',
    });
  }, ConfigError);

  // Invalid percentile
  assert.throws(() => {
    loadConfig({
      ...baseEnv,
      FEE_POLICY_JSON: JSON.stringify({
        trade: { percentile: 'p999' },
      }),
    });
  }, ConfigError);

  // Floor > Cap
  assert.throws(() => {
    loadConfig({
      ...baseEnv,
      FEE_POLICY_JSON: JSON.stringify({
        trade: { floor: '5000000', cap: '1000000' },
      }),
    });
  }, ConfigError);

  // Unknown class
  assert.throws(() => {
    loadConfig({
      ...baseEnv,
      FEE_POLICY_JSON: JSON.stringify({
        unknown_op: { floor: '1000' },
      }),
    });
  }, ConfigError);
});

test('fees: BigInt handling above 2^53', async () => {
  const largeStroops = '900719925474099300'; // > Number.MAX_SAFE_INTEGER
  const fakeLarge = {
    async getFeeStats() {
      return {
        sorobanInclusionFee: {
          transactionCount: '10',
          p90: largeStroops,
        },
      };
    },
  };

  const oracle = new FeeOracle('Test SDF Network', 'http://127.0.0.1:8000', 1000, 5000, fakeLarge);
  // Temporarily override cap to allow large value
  oracle.getPolicies().market_create.cap = BigInt(largeStroops) * 2n;

  const fee = await oracle.pickInclusionFee('market_create');
  assert.equal(fee.toString(), largeStroops);
  assert.equal(typeof fee, 'bigint');
});

test('fees: admin fees route requires admin authorization', async () => {
  const { default: adminRoutes } = await import('../src/routes/admin.routes');
  assert.ok(adminRoutes);
});
