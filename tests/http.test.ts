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

test('admin reconciliation routes require an admin (#83)', async () => {
  const { signToken } = await import('../src/middlewares/auth.middleware');
  await withServer(async (base) => {
    const token = signToken('u1', Keypair.random().publicKey());
    for (const [method, path] of [['POST', '/admin/reconciliation/run'], ['GET', '/admin/reconciliation/runs'], ['GET', '/admin/reconciliation/runs/abc']]) {
      const anon = await fetch(`${base}/api/v1${path}`, { method });
      assert.equal(anon.status, 401, `${method} ${path}`);
      const nonAdmin = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      assert.equal(nonAdmin.status, 403, `${method} ${path}`);
    }
  });
});

test('GET /portfolio derives capital from the treasury and serialises raw amounts as decimal strings (#76)', async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { setChainOverrides } = await import('../src/services/chain.service');
  const USDC = 10_000_000n;
  const orig = {
    positions: prisma.position.findMany, agg: prisma.trade.aggregate,
    report: prisma.transparencyReport.findFirst, snap: prisma.correlationSnapshot.findFirst,
  };
  (prisma.position.findMany as any) = async ({ where }: any) =>
    where.status === 'OPEN' ? [{ size: 25, pnl: 0, costBasisRaw: '250000000', realisedPnlRaw: '0', unrealisedPnlRaw: '0', market: { id: 'm1', category: 'FED' } }] : [];
  (prisma.trade.aggregate as any) = async () => ({ _sum: { builderFee: 0 } });
  (prisma.transparencyReport.findFirst as any) = async () => null;
  (prisma.correlationSnapshot.findFirst as any) = async () => null;
  const prev = setChainOverrides({
    treasuryAvailableCapital: async () => 800n * USDC + 5n,
    treasuryRiskConfig: async () => ({ agent: 'G', collateral: 'C', market_core: 'M', max_trade: 50n * USDC, max_market: 100n * USDC, max_daily: 200n * USDC }),
    treasuryDailyUsage: async () => ({ amount: 15n * USDC, day_start: 1_792_310_400n }),
  });
  try {
    await withServer(async (base) => {
      const ok = await (await fetch(`${base}/api/v1/portfolio`)).json();
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.data.treasury, {
        availableRaw: '8000000005',
        maxTradeRaw: '500000000',
        maxMarketRaw: '1000000000',
        maxDailyRaw: '2000000000',
        dailyUsedRaw: '150000000',
        dailyRemainingRaw: '1850000000',
        dailyResetsAt: new Date((1_792_310_400 + 86_400) * 1000).toISOString(),
      });
      assert.equal(ok.data.availableCapitalRaw, '8000000005');
      assert.equal(ok.data.availableCapital, 800);
      assert.equal(ok.data.deployedCapital, 25);
      assert.equal(ok.data.totalUsdc, 825);
      assert.equal(ok.data.correlationRisk.isOverExposed, false);
    });

    setChainOverrides({ treasuryAvailableCapital: async () => { throw new Error('rpc down'); } });
    await withServer(async (base) => {
      const down = await (await fetch(`${base}/api/v1/portfolio`)).json();
      assert.equal(down.ok, true);
      assert.equal(down.data.treasury, null);
      assert.equal(down.data.availableCapitalRaw, null);
      assert.equal(down.data.totalUsdc, null);
      assert.equal(down.data.availableCapital, null);
      assert.equal(down.data.deployedCapital, 25, 'database fields are still returned');
    });
  } finally {
    setChainOverrides(prev);
    (prisma.position.findMany as any) = orig.positions;
    (prisma.trade.aggregate as any) = orig.agg;
    (prisma.transparencyReport.findFirst as any) = orig.report;
    (prisma.correlationSnapshot.findFirst as any) = orig.snap;
  }
});
