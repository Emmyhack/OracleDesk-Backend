import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// ─── Duck-typed TransactionResult doubles (we exercise the mapping, not XDR) ──

const txResult = (code: string) => ({ result: () => ({ switch: () => ({ name: code }) }) });

const failedOp = (opCode: string) => ({
  result: () => ({
    switch: () => ({ name: 'txFailed' }),
    results: () => [
      {
        tr: () => ({
          switch: () => ({ name: 'invokeHostFunction' }),
          invokeHostFunctionResult: () => ({ switch: () => ({ name: opCode }) }),
        }),
      },
    ],
  }),
});

const send = (status: string, extra: Record<string, unknown> = {}) =>
  ({ status, hash: 'deadbeef', ...extra }) as any;

test('TRY_AGAIN_LATER is a transient, definitely-not-applied failure', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({ contract: 'treasury', send: send('TRY_AGAIN_LATER') });
  assert.equal(f.class, 'TRANSIENT_RPC');
  assert.equal(f.submitted, false);
});

test('DUPLICATE is treated as ambiguous and never rebuilt', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({ contract: 'treasury', send: send('DUPLICATE') });
  assert.equal(f.class, 'UNKNOWN_OUTCOME');
  assert.equal(f.submitted, true);
});

test('ERROR txBadSeq classifies as BAD_SEQUENCE', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({ contract: 'treasury', send: send('ERROR', { errorResult: txResult('txBadSeq') }) });
  assert.equal(f.class, 'BAD_SEQUENCE');
  assert.equal(f.txCode, 'txBadSeq');
  assert.equal(f.submitted, false);
});

test('ERROR txTooLate / txInsufficientFee map to EXPIRED / INSUFFICIENT_FEE', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  assert.equal(classifyFailure({ contract: 'treasury', send: send('ERROR', { errorResult: txResult('txTooLate') }) }).class, 'EXPIRED');
  assert.equal(
    classifyFailure({ contract: 'treasury', send: send('ERROR', { errorResult: txResult('txInsufficientFee') }) }).class,
    'INSUFFICIENT_FEE',
  );
});

test('a resource-limit operation failure is RESOURCE_OR_STATE and retryable', async () => {
  const { classifyFailure, retryDecision, isPermanentFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({
    contract: 'marketCore',
    send: send('ERROR', { errorResult: failedOp('invokeHostFunctionResourceLimitExceeded') }),
  });
  assert.equal(f.class, 'RESOURCE_OR_STATE');
  assert.equal(f.opCode, 'invokeHostFunctionResourceLimitExceeded');
  assert.equal(f.submitted, false);
  assert.equal(isPermanentFailure(f.class), false);
  const decision = retryDecision(f, 0, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 1000 }, 0, () => 0);
  assert.equal(decision.retry, true);
});

test('a trapped contract error is CONTRACT_ERROR, permanent, and named from the host text', async () => {
  const { classifyFailure, isPermanentFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({
    contract: 'marketCore',
    err: new Error('HostError: Error(Contract, #12)'),
    send: send('ERROR', { errorResult: failedOp('invokeHostFunctionTrapped') }),
  });
  assert.equal(f.class, 'CONTRACT_ERROR');
  assert.equal(f.contractError, 'SlippageExceeded');
  assert.equal(isPermanentFailure(f.class), true);
});

test('a FAILED get response is classified with submitted=true', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({
    contract: 'marketCore',
    err: new Error('Error(Contract, #12)'),
    get: { status: 'FAILED', resultXdr: failedOp('invokeHostFunctionTrapped') } as any,
  });
  assert.equal(f.class, 'CONTRACT_ERROR');
  assert.equal(f.contractError, 'SlippageExceeded');
  assert.equal(f.submitted, true);
});

test('NOT_FOUND is an ambiguous outcome', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  assert.equal(classifyFailure({ contract: 'treasury', get: { status: 'NOT_FOUND' } as any }).class, 'UNKNOWN_OUTCOME');
});

test('a thrown timeout is an ambiguous outcome', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({ contract: 'treasury', err: Object.assign(new Error('timed out'), { code: 'UPSTREAM_TIMEOUT' }) });
  assert.equal(f.class, 'UNKNOWN_OUTCOME');
  assert.equal(f.submitted, true);
});

test('a thrown connection error before send is transient', async () => {
  const { classifyFailure } = await import('../src/services/stellar/failures');
  const f = classifyFailure({ contract: 'treasury', err: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.equal(f.class, 'TRANSIENT_RPC');
  assert.equal(f.submitted, false);
});

test('retryDecision never retries permanent or ambiguous failures', async () => {
  const { retryDecision } = await import('../src/services/stellar/failures');
  const opts = { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 100_000 };
  const mk = (cls: string, submitted: boolean) => ({ class: cls, txCode: null, opCode: null, contractError: null, txHash: null, submitted } as any);
  assert.equal(retryDecision(mk('CONTRACT_ERROR', false), 0, opts, 0).retry, false);
  assert.equal(retryDecision(mk('UNKNOWN_OUTCOME', true), 0, opts, 0).retry, false);
  assert.equal(retryDecision(mk('TRANSIENT_RPC', true), 0, opts, 0).retry, false, 'never rebuild an applied envelope');
  assert.equal(retryDecision(mk('TRANSIENT_RPC', false), 0, opts, 0).retry, true);
});

test('retryDecision stops at maxAttempts and at the deadline', async () => {
  const { retryDecision } = await import('../src/services/stellar/failures');
  const f = { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash: null, submitted: false } as any;
  assert.equal(retryDecision(f, 4, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 100_000 }, 0, () => 0).retry, false);
  assert.equal(retryDecision(f, 0, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 1000, deadlineMs: 10 }, 0, () => 1).retry, false);
});

test('backoffDelay stays within the jitter bounds', async () => {
  const { backoffDelay } = await import('../src/services/stellar/failures');
  const opts = { baseDelayMs: 200, maxDelayMs: 1000 };
  assert.equal(backoffDelay(0, opts, () => 0), 100);
  assert.equal(backoffDelay(0, opts, () => 1), 200);
  assert.equal(backoffDelay(10, opts, () => 1), 1000, 'capped at maxDelayMs');
  assert.equal(backoffDelay(10, opts, () => 0), 500, 'half of the cap');
});
