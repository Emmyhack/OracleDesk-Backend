import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('POST /oracle/resolve no longer exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/oracle/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"marketId":"x","yesWon":true}' });
    assert.equal(res.status, 404);
  });
});

test('POST /auth/connect no longer exists', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/auth/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"walletAddress":"0x0000000000000000000000000000000000000001"}' });
    assert.equal(res.status, 404);
  });
});

test('POST /markets/generate requires an admin', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/v1/markets/generate`, { method: 'POST' });
    assert.equal(anon.status, 401);
    const token = signToken('u1', Keypair.random().publicKey());
    const nonAdmin = await fetch(`${base}/api/v1/markets/generate`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonAdmin.status, 403);
    assert.equal((await nonAdmin.json()).error.code, 'FORBIDDEN');
  });
});

test('GET /admin/trace-audit requires an admin', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/v1/admin/trace-audit`);
    assert.equal(anon.status, 401);
    const token = signToken('u1', Keypair.random().publicKey());
    const nonAdmin = await fetch(`${base}/api/v1/admin/trace-audit`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonAdmin.status, 403);
    assert.equal((await nonAdmin.json()).error.code, 'FORBIDDEN');
  });
});

test('CORS only allows configured origins', async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/health`, { headers: { origin: 'http://localhost:3000' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const evil = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

test('BigInt values serialise as decimal strings', async () => {
  const { default: app } = await import('../src/app');
  const replacer = app.get('json replacer');
  assert.equal(JSON.stringify({ id: 18446744073709551615n }, replacer), '{"id":"18446744073709551615"}');
});

test('admin treasury routes require an admin (#156)', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const anon = await fetch(`${base}/api/v1/admin/treasury`);
    assert.equal(anon.status, 401);
    const token = signToken('u1', Keypair.random().publicKey());
    const nonAdmin = await fetch(`${base}/api/v1/admin/treasury`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nonAdmin.status, 403);
    assert.equal((await nonAdmin.json()).error.code, 'FORBIDDEN');
  });
});

test('PATCH /trade/copy/:id/confirm without auth is 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/trade/copy/some-id/confirm`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: '11'.repeat(32) }),
    });
    assert.equal(res.status, 401);
  });
});
