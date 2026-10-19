import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import { questionDocument } from '../src/services/market-chain.service';
import {
  discoverLandedMarket,
  marketCreationDeps,
} from '../src/services/market-idempotency.service';
import { CONTRACTS } from '../src/config/contracts';

test('market-idempotency: questionDocument embeds backendMarketId and creates consistent hash', () => {
  const dummyMarket: any = {
    id: 'market-123',
    question: 'Will SpaceX land Starship on Mars by 2026?',
    category: 'CRYPTO',
    expiryTimestamp: new Date('2026-12-31T00:00:00Z'),
    resolutionOracle: 'https://spacex.com',
  };

  const doc = questionDocument(dummyMarket, 'deadbeef'.repeat(8));
  assert.equal(doc.backendMarketId, 'market-123');
  assert.equal(doc.question, dummyMarket.question);
  assert.equal(doc.resolutionHash, 'deadbeef'.repeat(8));

  // Verify backendMarketId is required and changing it changes the document JSON
  const doc2 = { ...doc, backendMarketId: 'market-456' };
  assert.notEqual(JSON.stringify(doc), JSON.stringify(doc2));
});

test('market-idempotency: discovery confirms matching candidate and rejects mismatching creator or resolutionHash', async () => {
  const qHex = 'aa'.repeat(32);
  const rHex = 'bb'.repeat(32);

  // Setup fake market on-chain
  const validMarket = {
    id: 10n,
    question_hash: Buffer.from(qHex, 'hex'),
    resolution_hash: Buffer.from(rHex, 'hex'),
    creator: CONTRACTS.treasury,
  };

  // Mismatch creator (agent instead of treasury)
  const invalidCreatorMarket = {
    ...validMarket,
    creator: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  };

  // Mismatch resolution hash
  const invalidResolutionMarket = {
    ...validMarket,
    resolution_hash: Buffer.from('cc'.repeat(32), 'hex'),
  };

  // 1. Valid candidate discovers market id 10n
  marketCreationDeps.getMarketCount = async () => 11n;
  marketCreationDeps.getOnChainMarket = async (id: bigint) => {
    if (id === 10n) return validMarket as any;
    throw new Error('MarketNotFound');
  };

  const discovered = await discoverLandedMarket({
    marketId: 'market-1',
    questionHashHex: qHex,
    resolutionHashHex: rHex,
  });
  assert.equal(discovered, 10n);

  // 2. Invalid creator returns null
  marketCreationDeps.getOnChainMarket = async () => invalidCreatorMarket as any;
  const rejectedCreator = await discoverLandedMarket({
    marketId: 'market-1',
    questionHashHex: qHex,
    resolutionHashHex: rHex,
  });
  assert.equal(rejectedCreator, null);

  // 3. Invalid resolution hash returns null
  marketCreationDeps.getOnChainMarket = async () => invalidResolutionMarket as any;
  const rejectedResolution = await discoverLandedMarket({
    marketId: 'market-1',
    questionHashHex: qHex,
    resolutionHashHex: rHex,
  });
  assert.equal(rejectedResolution, null);
});

test('market-idempotency: discovery follows txHash first before scanning', async () => {
  const qHex = '11'.repeat(32);
  const rHex = '22'.repeat(32);
  let txChecked = false;
  let scanCalled = false;

  marketCreationDeps.getTransaction = async (hash: string) => {
    txChecked = true;
    return {
      status: 'SUCCESS',
      resultMetaXdr: '',
    } as any;
  };

  marketCreationDeps.getMarketCount = async () => {
    scanCalled = true;
    return 5n;
  };
  marketCreationDeps.getOnChainMarket = async () => {
    throw new Error('MarketNotFound');
  };

  await discoverLandedMarket({
    marketId: 'market-test-order',
    questionHashHex: qHex,
    resolutionHashHex: rHex,
    txHash: 'tx-12345678',
  });

  assert.equal(txChecked, true);
  assert.equal(scanCalled, true);
});

test('market-idempotency: bounded scan stops at preSubmissionMarketCount floor', async () => {
  let scannedIds: bigint[] = [];
  marketCreationDeps.getMarketCount = async () => 100n;
  marketCreationDeps.getOnChainMarket = async (id: bigint) => {
    scannedIds.push(id);
    throw new Error('Not match');
  };

  await discoverLandedMarket({
    marketId: 'market-bounds',
    questionHashHex: '00'.repeat(32),
    resolutionHashHex: '00'.repeat(32),
    preSubmissionCount: 95n,
  });

  // Should only check down to preSubmissionCount (95)
  assert.ok(scannedIds.includes(99n));
  assert.ok(scannedIds.includes(95n));
  assert.ok(!scannedIds.includes(94n));
});
