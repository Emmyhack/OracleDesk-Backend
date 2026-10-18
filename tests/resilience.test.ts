import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setupTestEnv } from './helpers/env';
import {
  Bulkhead,
  ClientAbortedError,
  SaturatedError,
  TimeoutError,
  deadline,
  sleep,
  withTimeout,
} from '../src/lib/resilience';

setupTestEnv();

test('withTimeout rejects with UPSTREAM_TIMEOUT and aborts the inner signal', async () => {
  let innerAborted = false;
  await assert.rejects(
    async () => {
      await withTimeout(
        'rpc-read',
        async (innerSignal) => {
          return new Promise<void>((_, reject) => {
            innerSignal.addEventListener('abort', () => {
              innerAborted = true;
              reject(innerSignal.reason);
            });
          });
        },
        { ms: 30 },
      );
    },
    (err: any) => {
      assert.equal(err.code, 'UPSTREAM_TIMEOUT');
      assert.equal(err.statusCode, 504);
      assert.equal(err.details?.dependency, 'rpc-read');
      return true;
    },
  );
  assert.equal(innerAborted, true);
});

test('parent abort propagates and is not reported as timeout', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller-cancelled'));

  await assert.rejects(
    async () => {
      await withTimeout(
        'rpc-read',
        async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'ok';
        },
        { signal: controller.signal, ms: 500 },
      );
    },
    (err: any) => {
      assert.equal(err.code, 'CLIENT_ABORTED');
      assert.notEqual(err.code, 'UPSTREAM_TIMEOUT');
      return true;
    },
  );
});

test('bulkhead limits concurrency and rejects when queue is full', async () => {
  const bulkhead = new Bulkhead('llm', 2, 2);

  let unblock1: () => void;
  let unblock2: () => void;
  const p1 = new Promise<void>((r) => { unblock1 = r; });
  const p2 = new Promise<void>((r) => { unblock2 = r; });

  const t1 = bulkhead.run(() => p1);
  const t2 = bulkhead.run(() => p2);

  assert.equal(bulkhead.stats().active, 2);
  assert.equal(bulkhead.stats().queued, 0);

  // Queue 2 tasks
  let unblock3: () => void;
  let unblock4: () => void;
  const p3 = new Promise<void>((r) => { unblock3 = r; });
  const p4 = new Promise<void>((r) => { unblock4 = r; });

  const t3 = bulkhead.run(() => p3);
  const t4 = bulkhead.run(() => p4);

  assert.equal(bulkhead.stats().active, 2);
  assert.equal(bulkhead.stats().queued, 2);

  // 5th task exceeds queue limit of 2 -> rejected
  await assert.rejects(
    async () => {
      await bulkhead.run(async () => 'overflow');
    },
    (err: any) => {
      assert.equal(err.code, 'UPSTREAM_SATURATED');
      assert.equal(err.statusCode, 503);
      return true;
    },
  );
  assert.equal(bulkhead.stats().rejected, 1);

  // Release active tasks
  unblock1!();
  unblock2!();
  await Promise.all([t1, t2]);

  // Next tasks in queue should start
  unblock3!();
  unblock4!();
  await Promise.all([t3, t4]);
});

test('pinJson aborts the pending pin when the caller signal aborts', async () => {
  const { pinJson, setIpfsTransport } = await import('../src/services/ipfs.service');
  let pinSignalAborted = false;

  const fakeTransport = {
    async pin(_bytes: Buffer, _name: string, signal?: AbortSignal) {
      return new Promise<string>((_, reject) => {
        signal?.addEventListener('abort', () => {
          pinSignalAborted = true;
          reject(signal.reason ?? new Error('aborted'));
        });
      });
    },
    async fetch() {
      return Buffer.from('');
    },
  };

  const prev = setIpfsTransport(fakeTransport);
  const controller = new AbortController();

  try {
    const pinPromise = pinJson({ hello: 'world' }, 'test-doc', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(
      async () => {
        await pinPromise;
      },
      (err: any) => {
        assert.equal(err.code, 'CLIENT_ABORTED');
        return true;
      },
    );
    assert.equal(pinSignalAborted, true);
  } finally {
    setIpfsTransport(prev);
  }
});

test('verifyUsdcTransfer maps a hung getTransaction to CHAIN_READ_FAILED with timeout flag', async () => {
  const { verifyUsdcTransfer, setTransactionReader } = await import(
    '../src/services/payment-verification.service'
  );

  const prevReader = setTransactionReader({
    async getTransaction() {
      return new Promise(() => {}); // never resolves
    },
  });

  try {
    const parent = AbortSignal.timeout(30);
    await assert.rejects(
      async () => {
        await verifyUsdcTransfer(
          {
            txHash: 'aa'.repeat(32),
            token: 'test',
            from: 'test',
            to: 'test',
            minAmount: 1n,
          },
          parent,
        );
      },
      (err: any) => {
        assert.equal(err.code, 'CHAIN_READ_FAILED');
        assert.equal(err.statusCode, 502);
        assert.equal(err.details?.timeout, true);
        return true;
      },
    );
  } finally {
    setTransactionReader(prevReader);
  }
});

test('backfillEvents tick is bounded when getEvents hangs', async () => {
  const { backfillEvents } = await import('../src/services/indexer.service');

  const fakeSource = {
    async getHealth() {
      return { oldestLedger: 100, latestLedger: 200 } as any;
    },
    async getEvents() {
      return new Promise(() => {}); // never resolves
    },
  };

  const shortSignal = AbortSignal.timeout(40);
  await assert.rejects(
    async () => {
      await backfillEvents(150, { source: fakeSource as any, emit: () => {} }, { signal: shortSignal });
    },
    (err: any) => {
      assert.ok(err);
      return true;
    },
  );
});

test('callGeminiJSON stops retrying when budget is shorter than retryDelay', async () => {
  const { callGeminiJSON, setGenAI } = await import('../src/lib/gemini');
  const { MemoryGuardStore, setLlmGuardStore } = await import('../src/lib/llm-budget');
  const prevStore = setLlmGuardStore(new MemoryGuardStore());

  const fakeGenAI = {
    getGenerativeModel() {
      return {
        async generateContent() {
          throw new Error('429 RESOURCE_EXHAUSTED: Please retry in 30s.');
        },
      };
    },
  };

  const prev = setGenAI(fakeGenAI);
  try {
    const shortSignal = AbortSignal.timeout(50);
    const start = Date.now();
    await assert.rejects(
      async () => {
        await callGeminiJSON('sys', 'user', 100, { signal: shortSignal });
      },
      (err: any) => {
        assert.equal(err.code, 'UPSTREAM_TIMEOUT');
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Expected fast timeout, took ${elapsed}ms`);
  } finally {
    setGenAI(prev);
    setLlmGuardStore(prevStore);
  }
});

test('GET /portfolio returns 200 with availableCapitalRaw null when RPC read times out', async () => {
  const { readClients } = await import('../src/services/stellar/clients');
  const { default: app } = await import('../src/app');

  const origTreasury = readClients.treasury;
  (readClients as any).treasury = () => ({
    available_capital: async () => new Promise(() => {}), // hung read
  });

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/portfolio`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.availableCapitalRaw, null);
  } finally {
    (readClients as any).treasury = origTreasury;
    server.close();
  }
});
