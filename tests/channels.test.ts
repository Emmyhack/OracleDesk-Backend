import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import { Keypair, Networks } from '@stellar/stellar-sdk';
import {
  ChannelPool,
  channelSigner,
  verifyChannelAuthEntries,
} from '../src/services/stellar/channels';
import { loadConfig } from '../src/config';
import { assertTestnet, createChannels } from '../scripts/channels';

// In-memory Redis fake for testing exclusive leases
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, mode?: string, ttlMs?: number, flag?: string): Promise<string | null> {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) {
      if (flag === 'NX') return null;
    }
    const expiresAt = ttlMs ? now + ttlMs : Infinity;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async eval(script: string, numKeys: number, key: string, arg: string): Promise<number> {
    const existing = this.store.get(key);
    if (existing && existing.value === arg) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

test('channels: exclusive lease across concurrent callers with fake Redis', async () => {
  const fakeRedis = new FakeRedis() as any;
  const pool = new ChannelPool(fakeRedis);

  const kp1 = Keypair.random();
  const kp2 = Keypair.random();
  (pool as any).channels = [
    { publicKey: kp1.publicKey(), keypair: kp1, healthy: true, lastBalanceXlm: 100 },
    { publicKey: kp2.publicKey(), keypair: kp2, healthy: true, lastBalanceXlm: 100 },
  ];

  // Lease 1
  const lease1 = await pool.acquire({ timeoutMs: 1000 });
  assert.ok(lease1);

  // Lease 2 (should pick the other channel via round-robin)
  const lease2 = await pool.acquire({ timeoutMs: 1000 });
  assert.ok(lease2);
  assert.notEqual(lease1.channel.publicKey, lease2.channel.publicKey);

  // Third lease should time out or fail because both are leased
  await assert.rejects(
    async () => {
      await pool.acquire({ timeoutMs: 150 });
    },
    /CHANNELS_EXHAUSTED/,
  );

  // Release lease 1
  await lease1.release();

  // Now acquire should succeed
  const lease3 = await pool.acquire({ timeoutMs: 500 });
  assert.equal(lease3.channel.publicKey, lease1.channel.publicKey);
  await lease2.release();
  await lease3.release();
});

test('channels: low-balance channel is skipped', async () => {
  const fakeRedis = new FakeRedis() as any;
  const pool = new ChannelPool(fakeRedis);

  const lowKp = Keypair.random();
  const healthyKp = Keypair.random();

  (pool as any).channels = [
    { publicKey: lowKp.publicKey(), keypair: lowKp, healthy: false, lastBalanceXlm: 2 },
    { publicKey: healthyKp.publicKey(), keypair: healthyKp, healthy: true, lastBalanceXlm: 50 },
  ];

  const lease = await pool.acquire({ timeoutMs: 500 });
  assert.equal(lease.channel.publicKey, healthyKp.publicKey());
  await lease.release();
});

test('channels: channelSigner composes channel envelope signing and agent auth entry signing', async () => {
  const channelKp = Keypair.random();
  const agentKp = Keypair.random();

  const signer = channelSigner(channelKp, agentKp);
  assert.equal(signer.publicKey, channelKp.publicKey());
  assert.equal(typeof signer.signTransaction, 'function');
  assert.equal(typeof signer.signAuthEntry, 'function');
});

test('channels: verifyChannelAuthEntries aborts on unexpected non-invoker signer', () => {
  const agentKp = Keypair.random();
  const attackerKp = Keypair.random();

  // Mock AssembledTransaction with unexpected signer
  const badTx = {
    needsNonInvokerSigningBy: () => [attackerKp.publicKey()],
  };

  assert.throws(
    () => {
      verifyChannelAuthEntries(badTx, agentKp.publicKey(), 'agent_buy');
    },
    (err: any) => err.code === 'UNEXPECTED_AUTH_SIGNER',
  );

  // Expected signer passes
  const goodTx = {
    needsNonInvokerSigningBy: () => [agentKp.publicKey()],
  };
  assert.doesNotThrow(() => {
    verifyChannelAuthEntries(goodTx, agentKp.publicKey(), 'agent_buy');
  });
});

test('channels: config rejects duplicate or agent-equal channel keys', () => {
  const agentSecret = Keypair.random().secret();
  const duplicateKey = Keypair.random().secret();

  // 1. Channel key equals agent secret key
  assert.throws(() => {
    loadConfig({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      CHAIN_EXECUTION_MODE: 'live',
      AGENT_SECRET_KEY: agentSecret,
      STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
      CHANNEL_SECRET_KEYS: agentSecret,
    });
  }, /channel secret key must not equal AGENT_SECRET_KEY/);

  // 2. Duplicate channel keys
  assert.throws(() => {
    loadConfig({
      DATABASE_URL: 'postgresql://localhost:5432/test',
      CHAIN_EXECUTION_MODE: 'live',
      AGENT_SECRET_KEY: agentSecret,
      STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
      CHANNEL_SECRET_KEYS: `${duplicateKey},${duplicateKey}`,
    });
  }, /duplicate channel secret key configured/);
});

test('channels script: refuses non-testnet passphrase', () => {
  assert.throws(() => {
    assertTestnet(Networks.PUBLIC);
  }, /Refusing to run channel script outside of Stellar testnet/);

  assert.doesNotThrow(() => {
    assertTestnet(Networks.TESTNET);
  });
});

test('channels script: createChannels returns valid public keys', () => {
  const res = createChannels(3, undefined, Networks.TESTNET);
  assert.equal(res.publicKeys.length, 3);
  res.publicKeys.forEach((k) => assert.ok(k.startsWith('G')));
});
