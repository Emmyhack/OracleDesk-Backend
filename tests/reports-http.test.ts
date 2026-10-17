import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

async function withServer(fn: (base: string) => Promise<void>) {
  const { prisma } = await import('../src/lib/prisma');
  (prisma.transparencyReport.findMany as any) = async () => [{
    date: '2026-10-14', anchorLedger: 100, cid: 'bafy', hash: 'a'.repeat(64),
    onChainTraceId: 1n, mode: 'dry-run', consistency: 'exact', report: {}, createdAt: new Date(),
  }];
  (prisma.transparencyReport.count as any) = async () => 1;
  (prisma.transparencyReport.findFirst as any) = async () => ({
    date: '2026-10-14', anchorLedger: 100, cid: 'bafy', hash: 'a'.repeat(64),
    onChainTraceId: 1n, mode: 'dry-run', consistency: 'exact', report: {}, createdAt: new Date(),
  });
  (prisma.transparencyReport.findUnique as any) = async () => null;

  const { default: app } = await import('../src/app');
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('GET /api/v1/reports is public and paginated (#159)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/reports?page=2&limit=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data[0].cid, 'bafy');
    assert.equal(body.meta.page, 2);
    assert.equal(body.meta.limit, 5);
    assert.ok(body.data[0].verification.recipe.length > 0);
  });
});

test('GET /api/v1/reports/latest and :date behave (#159)', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/v1/reports/latest`)).status, 200);
    assert.equal((await fetch(`${base}/api/v1/reports/2026-10-14`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/reports/not-a-date`)).status, 400);
  });
});
