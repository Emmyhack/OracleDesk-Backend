import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

function memoryStore() {
  const map = new Map<string, { sha256: string; bytes: Buffer; origin: string }>();
  return {
    map,
    async put(entry: any) {
      const hash = crypto.createHash('sha256').update(entry.bytes).digest('hex');
      assert.equal(hash, entry.sha256);
      const existing = map.get(entry.cid);
      if (existing && existing.sha256 !== entry.sha256) {
        throw new Error('IPFS_CID_HASH_CONFLICT');
      }
      map.set(entry.cid, { sha256: entry.sha256, bytes: Buffer.from(entry.bytes), origin: entry.origin });
    },
    async get(cid: string) {
      return map.get(cid) ?? null;
    },
    async touch() {},
    async evict() { return { removed: 0, freedBytes: 0 }; },
  };
}

test('pinJson writes the exact pinned bytes to the store (#100)', async () => {
  const { pinJson, setIpfsTransport } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  const store = memoryStore();
  setContentStore(store as any);
  const pinnedBytes = Buffer.from('{"a":1}');
  setIpfsTransport({
    async pin() { return 'bafy-pinned'; },
    async fetch() { return pinnedBytes; },
  });

  const pinned = await pinJson({ a: 1 }, 'doc');
  const stored = await store.get(pinned.cid);
  assert.ok(stored, 'pinned bytes are recorded');
  assert.equal(stored!.sha256, pinned.hash);
  assert.ok(stored!.bytes.equals(pinned.bytes), 'exact bytes, not a re-serialisation');
});

test('a store failure does not fail pinJson (#100)', async () => {
  const { pinJson, setIpfsTransport } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  setContentStore({
    async put() { throw new Error('cache down'); },
    async get() { return null; },
    async touch() {},
    async evict() { return { removed: 0, freedBytes: 0 }; },
  } as any);
  setIpfsTransport({ async pin() { return 'bafy-ok'; }, async fetch() { throw new Error('no'); } });
  const pinned = await pinJson({ ok: true }, 'doc');
  assert.equal(pinned.cid, 'bafy-ok');
});

test('fetchVerifiedBytes serves a cache hit during a gateway outage (#100)', async () => {
  const { fetchVerifiedBytes, pinJson, setIpfsTransport } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  const store = memoryStore();
  setContentStore(store as any);
  let gatewayUp = true;
  const bytes = Buffer.from('{"n":1}');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  setIpfsTransport({
    async pin() { return 'bafy-cache'; },
    async fetch() {
      if (!gatewayUp) throw new Error('gateway down');
      return bytes;
    },
  });
  await pinJson({ n: 1 }, 'doc');

  gatewayUp = false;
  const result = await fetchVerifiedBytes('bafy-cache', hash, 'test');
  assert.equal(result.source, 'cache');
  assert.ok(result.bytes.equals(bytes));
});

test('a cached row with a different hash is never served (#100)', async () => {
  const { fetchVerifiedBytes, setIpfsTransport } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  const store = memoryStore();
  setContentStore(store as any);
  const cachedBytes = Buffer.from('old');
  const cachedHash = crypto.createHash('sha256').update(cachedBytes).digest('hex');
  const expectedBytes = Buffer.from('new');
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  store.map.set('bafy-x', { sha256: cachedHash, bytes: cachedBytes, origin: 'PINNED' });

  let gatewayCalls = 0;
  setIpfsTransport({
    async pin() { return 'x'; },
    async fetch() { gatewayCalls++; return expectedBytes; },
  });
  const result = await fetchVerifiedBytes('bafy-x', expectedHash, 'test');
  assert.equal(result.source, 'gateway');
  assert.equal(gatewayCalls, 1, 'gateway consulted instead of returning the wrong cached bytes');
  assert.ok(result.bytes.equals(expectedBytes));
  assert.equal(store.map.get('bafy-x')!.sha256, cachedHash, 'existing CID is not overwritten');
});

test('gateway bytes that fail verification are returned but never stored (#100)', async () => {
  const { fetchVerifiedBytes, setIpfsTransport } = await import('../src/services/ipfs.service');
  const { setContentStore } = await import('../src/services/content-store.service');
  const store = memoryStore();
  setContentStore(store as any);
  const badBytes = Buffer.from('tampered');
  const expected = crypto.createHash('sha256').update('expected').digest('hex');
  setIpfsTransport({ async pin() { return 'x'; }, async fetch() { return badBytes; } });

  const result = await fetchVerifiedBytes('bafy-bad', expected, 'test');
  assert.ok(result.bytes.equals(badBytes), 'caller can report the computed hash');
  assert.equal(store.map.has('bafy-bad'), false, 'unverified bytes are never cached');
});

test('postgres store rejects a CID hash conflict and oversized objects (#100)', async () => {
  const { postgresContentStore } = await import('../src/services/content-store.service');
  const { prisma } = await import('../src/lib/prisma');
  const bytes = Buffer.from('abc');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');

  (prisma.ipfsContent.findUnique as any) = async () => ({ cid: 'bafy-x', sha256: 'f'.repeat(64), bytes, size: 3, origin: 'PINNED' });
  await assert.rejects(
    postgresContentStore.put({ cid: 'bafy-x', sha256: hash, bytes, origin: 'PINNED', verifiedBy: 'test' }),
    (err: any) => err.code === 'IPFS_CID_HASH_CONFLICT',
  );

  const huge = Buffer.alloc(262_145, 1);
  const hugeHash = crypto.createHash('sha256').update(huge).digest('hex');
  await assert.rejects(
    postgresContentStore.put({ cid: 'bafy-huge', sha256: hugeHash, bytes: huge, origin: 'PINNED', verifiedBy: 'test' }),
    (err: any) => err.code === 'IPFS_CONTENT_TOO_LARGE',
  );
});

test('postgres store eviction is a no-op under budget (#100)', async () => {
  const { postgresContentStore } = await import('../src/services/content-store.service');
  const { prisma } = await import('../src/lib/prisma');
  (prisma.ipfsContent.aggregate as any) = async () => ({ _sum: { size: 10 } });
  const result = await postgresContentStore.evict(100);
  assert.deepEqual(result, { removed: 0, freedBytes: 0 });
});

test('trace verification succeeds from cache when both gateways are down (#100)', async () => {
  const crypto = await import('node:crypto');
  const { setContentStore } = await import('../src/services/content-store.service');
  const { setIpfsTransport } = await import('../src/services/ipfs.service');
  const { prisma } = await import('../src/lib/prisma');
  const bytes = Buffer.from('{"trace":"cached"}');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const map = new Map<string, any>([['bafy-cache-only', { sha256: hash, bytes, origin: 'PINNED' }]]);
  setContentStore({
    async put() {},
    async get(cid: string) { return map.get(cid) ?? null; },
    async touch() {},
    async evict() { return { removed: 0, freedBytes: 0 }; },
  } as any);
  setIpfsTransport({
    async pin() { return 'x'; },
    async fetch() { throw new Error('both gateways down'); },
  });

  const row: any = { id: 't1', onChainTraceId: 1n, traceHash: hash, ipfsCid: 'bafy-cache-only', verified: false };
  (prisma.reasoningTrace.findUnique as any) = async () => row;
  (prisma.reasoningTrace.update as any) = async ({ data }: any) => Object.assign(row, data);
  const chain = await import('../src/services/chain.service');
  (chain as any).getOnChainTrace = async () => ({ ipfs_cid: 'bafy-cache-only', trace_hash: Buffer.from(hash, 'hex') });

  const { verifyTraceOnChain } = await import('../src/services/trace-publish.service');
  const result = await verifyTraceOnChain('t1');
  assert.equal(result.verified, true);
  assert.equal(result.contentSource, 'cache');
});
