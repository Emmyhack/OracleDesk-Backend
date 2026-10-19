import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

test('config names every missing or invalid variable', async () => {
  const { loadConfig } = await import('../src/config');
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', ADMIN_ADDRESSES: '0xabc' }), /ADMIN_ADDRESSES/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', CHAIN_EXECUTION_MODE: 'live' }), /AGENT_SECRET_KEY is required/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', CHAIN_EXECUTION_MODE: 'mock' }), /CHAIN_EXECUTION_MODE/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'x', CHAIN_EXECUTION_MODE: 'live', AGENT_SECRET_KEY: Keypair.random().secret(), STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015' }),
    /testnet-only/,
  );
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', NODE_ENV: 'production' }), /JWT_SECRET is required in production/);
});

test('fee bump config rejects a fee payer equal to the agent and requires testnet', async () => {
  const { loadConfig } = await import('../src/config');
  const agent = Keypair.random().secret();
  const payer = Keypair.random().secret();
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'x', CHAIN_EXECUTION_MODE: 'live', AGENT_SECRET_KEY: agent, FEE_PAYER_SECRET: agent }),
    /FEE_PAYER_SECRET must differ from AGENT_SECRET_KEY/,
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'x', FEE_BUMP_ENABLED: 'true' }),
    /FEE_PAYER_SECRET is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: 'x',
        FEE_BUMP_ENABLED: 'true',
        FEE_PAYER_SECRET: payer,
        STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
      }),
    /fee bumps are testnet-only/,
  );
  const c = loadConfig({ DATABASE_URL: 'x', FEE_BUMP_ENABLED: 'true', FEE_PAYER_SECRET: payer });
  assert.equal(c.FEE_BUMP_ENABLED, true);
  assert.equal(c.FEE_BUMP_MAX_ATTEMPTS, 3);
});

test('defaults to dry-run on testnet, and generates dev-only ephemeral secrets', async () => {
  const { loadConfig } = await import('../src/config');
  const c = loadConfig({ DATABASE_URL: 'x' });
  assert.equal(c.CHAIN_EXECUTION_MODE, 'dry-run');
  assert.equal(c.STELLAR_NETWORK_PASSPHRASE, 'Test SDF Network ; September 2015');
  assert.deepEqual(c.ephemeralSecrets.sort(), ['AUTH_SIGNING_SECRET', 'ENTITLEMENT_SIGNING_KEY', 'JWT_SECRET']);
});

test('SEP-45 and signing-key rotation settings are validated (#47/#48)', async () => {
  const { loadConfig } = await import('../src/config');
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', SEP45_ENABLED: 'true' }), /WEB_AUTH_CONTRACT_ID/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', AUTH_PREVIOUS_SIGNING_KEYS: 'GABC' }));
  const previous = Keypair.random().publicKey();
  const c = loadConfig({ DATABASE_URL: 'x', AUTH_PREVIOUS_SIGNING_KEYS: previous });
  assert.equal(c.AUTH_PREVIOUS_SIGNING_KEYS.length, 1);
  assert.equal(c.AUTH_PREVIOUS_SIGNING_KEYS[0].publicKey, previous);
  assert.equal(c.SEP45_ENABLED, false);
});
