import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();
const ADMIN = Keypair.random().publicKey();
process.env.ADMIN_ADDRESSES = ADMIN; // read once when config loads

async function withServer(fn: (base: string) => Promise<void>) {
  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function post(base: string, token: string | null, body: unknown) {
  return fetch(`${base}/api/v1/admin/admins/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('POST /admin/admins/grant requires auth and the admin.manage permission', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    assert.equal((await post(base, null, {})).status, 401);
    const nonAdmin = signToken('u1', Keypair.random().publicKey());
    const forbidden = await post(base, nonAdmin, {});
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
  });
});

test('sensitive admin writes require a fresh wallet proof (#49)', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const stale = signToken('admin', ADMIN, { authTime: Math.floor(Date.now() / 1000) - 3600 });
    const res = await post(base, stale, { walletAddress: ADMIN, roleName: 'auditor' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'STEP_UP_REQUIRED');
  });
});

test('a fresh admin token passes step-up and reaches request validation', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const fresh = signToken('admin', ADMIN);
    const res = await post(base, fresh, { walletAddress: 'not-an-address', roleName: 'auditor' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  });
});
