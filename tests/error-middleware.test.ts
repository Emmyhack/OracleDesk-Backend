import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

/**
 * A route that lets any unique-constraint error escape, to prove the global
 * mapper turns P2002 into a 409 CONFLICT without leaking column or table names.
 */
async function withFailingRoute(err: unknown, fn: (base: string) => Promise<void>): Promise<void> {
  const express = (await import('express')).default;
  const { errorMiddleware } = await import('../src/middlewares/error.middleware');
  const app = express();
  app.get('/boom', async () => {
    throw err;
  });
  app.use(errorMiddleware);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('Prisma P2002 from any route is a 409 CONFLICT with a safe message (#59)', async () => {
  const { Prisma } = await import('@prisma/client');
  const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`txHash`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['txHash'] },
  });
  await withFailingRoute(err, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'CONFLICT');
    assert.doesNotMatch(body.error.message, /txHash|payment_events|constraint|P2002/i);
    assert.doesNotMatch(JSON.stringify(body), /txHash|payment_events/i);
  });
});

test('a raw Postgres 23505 is also a 409, never a 500 (#59)', async () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "subscriptions_txHash_key"'), {
    code: '23505',
  });
  await withFailingRoute(err, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'CONFLICT');
    assert.doesNotMatch(body.error.message, /subscriptions|txHash/i);
  });
});
