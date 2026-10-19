import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import {
  decideExpiry,
  authExpirationLedger,
  timeoutFor,
  ExpiredError,
  DEFAULT_EXPIRY_SKEW_SECONDS,
} from '../src/services/stellar/timebounds';
import { loadConfig } from '../src/config';

test('timebounds: decideExpiry pure function states', () => {
  const maxTime = 1000;
  const skew = DEFAULT_EXPIRY_SKEW_SECONDS; // 10

  // 1. SUCCESS -> LANDED
  assert.equal(
    decideExpiry({
      status: 'SUCCESS',
      latestLedgerCloseTime: 900,
      maxTime,
    }),
    'LANDED',
  );

  // 2. FAILED -> FAILED
  assert.equal(
    decideExpiry({
      status: 'FAILED',
      latestLedgerCloseTime: 900,
      maxTime,
    }),
    'FAILED',
  );

  // 3. NOT_FOUND but latestLedgerCloseTime <= maxTime + skew -> PENDING
  assert.equal(
    decideExpiry({
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 1005, // <= 1010
      maxTime,
      submittedLedger: 100,
      oldestLedger: 90,
    }),
    'PENDING',
  );

  // 4. NOT_FOUND and latestLedgerCloseTime > maxTime + skew, inside retention -> EXPIRED
  assert.equal(
    decideExpiry({
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 1015, // > 1010
      maxTime,
      submittedLedger: 100,
      oldestLedger: 90, // submittedLedger >= oldestLedger => inside retention
    }),
    'EXPIRED',
  );

  // 5. NOT_FOUND, past deadline, but older than RPC retention window -> UNKNOWN
  assert.equal(
    decideExpiry({
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 1050,
      maxTime,
      submittedLedger: 80,
      oldestLedger: 90, // submittedLedger < oldestLedger => retention floor passed!
    }),
    'UNKNOWN',
  );

  // 6. Unknown retention status when no submittedLedger/submittedAtCloseTime provided -> UNKNOWN on past deadline
  assert.equal(
    decideExpiry({
      status: 'NOT_FOUND',
      latestLedgerCloseTime: 1020,
      maxTime,
      // no submitted info
    }),
    'UNKNOWN',
  );
});

test('timebounds: authExpirationLedger derived from maxTime', () => {
  // latestLedger = 1000, closeTime = 500, maxTime = 530, margin = 12
  // remaining = 30 seconds, ceil(30 / 5) = 6 ledgers
  // expected = 1000 + 6 + 12 = 1018
  const ledger = authExpirationLedger({
    latestLedger: 1000,
    latestLedgerCloseTime: 500,
    maxTime: 530,
    marginLedgers: 12,
  });
  assert.equal(ledger, 1018);

  // Entry never expires before its enclosing transaction
  assert.ok(ledger >= 1000 + Math.ceil(30 / 5));
});

test('timebounds: timeoutFor maps classes correctly', () => {
  assert.equal(typeof timeoutFor('market_create'), 'number');
  assert.equal(typeof timeoutFor('trade'), 'number');
  assert.equal(typeof timeoutFor('trace_publish'), 'number');
  assert.equal(typeof timeoutFor('maintenance'), 'number');
});

test('timebounds: ExpiredError properties', () => {
  const err = new ExpiredError('Tx timed out', 'attempt-123', 'txhash-abc');
  assert.equal(err.code, 'CHAIN_TX_EXPIRED');
  assert.equal(err.statusCode, 504);
  assert.equal(err.attemptId, 'attempt-123');
  assert.equal(err.txHash, 'txhash-abc');
});

test('timebounds: config validation bounds', () => {
  const valid = loadConfig({
    DATABASE_URL: 'postgresql://localhost:5432/test',
    TIMEOUT_MARKET_CREATE_SECONDS: '90',
    TIMEOUT_TRADE_SECONDS: '45',
    TIMEOUT_TRACE_PUBLISH_SECONDS: '60',
    TIMEOUT_MAINTENANCE_SECONDS: '30',
    AUTH_EXPIRY_MARGIN_LEDGERS: '15',
    MAX_REBUILD_COUNT: '3',
  });
  assert.equal(valid.TIMEOUT_MARKET_CREATE_SECONDS, 90);
  assert.equal(valid.TIMEOUT_TRADE_SECONDS, 45);
  assert.equal(valid.MAX_REBUILD_COUNT, 3);

  // Out of bounds throws
  assert.throws(() => {
    loadConfig({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      TIMEOUT_TRADE_SECONDS: '5', // min is 10
    });
  });
});
