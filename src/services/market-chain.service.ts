/**
 * Puts a database market on-chain through treasury.agent_create_market.
 *
 * ADR 0001: the market commits to its resolution rule at creation. We build
 * the spec, hash it exactly like scripts/spec-hash in the contracts repo,
 * store the full spec next to the market (so anyone can reveal it to
 * resolver.register_signer_spec later) and pass the hash on-chain.
 */
import type { Market } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { toContractCategory, toContractCategoryValue } from '../lib/categories';
import { USDC_UNIT, usdcFromNumber } from '../lib/amounts';
import { resolutionHash, type ResolutionSpecJson } from '../lib/resolution-spec';
import { agentCreateMarket, type WriteResult } from './chain.service';
import { agentSigner } from './stellar/clients';
import { pinJson } from './ipfs.service';
import type { QuestionResolutionBlock } from './resolvability.service';

/** market-core MIN_SEED is 100 USDC. */
export const MIN_SEED_RAW = 100n * USDC_UNIT;

export function defaultResolutionSpec(): ResolutionSpecJson {
  const signers = config.RESOLUTION_SIGNERS.length > 0
    ? config.RESOLUTION_SIGNERS
    : [agentSigner().publicKey as string];
  return {
    kind: 'signers',
    signers,
    threshold: config.RESOLUTION_THRESHOLD,
    disputeWindow: config.RESOLUTION_DISPUTE_WINDOW_SECS,
  };
}

/**
 * The question document pinned to IPFS; its sha256 is the on-chain question_hash.
 *
 * Version 2 (#74) adds a `resolution` block when the market has resolution
 * details. Markets without them keep the exact v1 shape, so their pinned bytes
 * (and hashes) are unchanged. Readers must ignore unknown fields.
 */
export function questionDocument(market: Market, resolutionHashHex: string) {
  const details = market.resolutionDetails as QuestionResolutionBlock | null | undefined;
  return {
    version: details ? 2 : 1,
    question: market.question,
    category: market.category,
    contractCategory: toContractCategory(market.category),
    closeTime: Math.floor(market.expiryTimestamp.getTime() / 1000),
    resolutionSource: market.resolutionOracle ?? null,
    resolutionHash: resolutionHashHex,
    backendMarketId: market.id,
    ...(details ? { resolution: details } : {}),
  };
}

export function initialYesBps(probability: number): number {
  return Math.min(9900, Math.max(100, Math.round(probability * 10_000)));
}

export async function createMarketOnChain(
  market: Market,
  spec: ResolutionSpecJson = defaultResolutionSpec(),
): Promise<WriteResult<bigint>> {
  const resolutionHashBytes = resolutionHash(spec);
  const resolutionHashHex = resolutionHashBytes.toString('hex');
  const pinned = await pinJson(questionDocument(market, resolutionHashHex), `oracledesk-market-${market.id}`);

  const requested = usdcFromNumber(market.minimumLiquidity);
  const seed = requested < MIN_SEED_RAW ? MIN_SEED_RAW : requested;

  await prisma.market.update({
    where: { id: market.id },
    data: {
      resolutionSpec: spec as object,
      resolutionHash: resolutionHashHex,
      questionHash: pinned.hash,
      metaUri: `ipfs://${pinned.cid}`,
      seedAmountRaw: seed.toString(),
    },
  });

  const result = await agentCreateMarket({
    question_hash: Buffer.from(pinned.hash, 'hex'),
    resolution_hash: resolutionHashBytes,
    meta_uri: `ipfs://${pinned.cid}`,
    category: toContractCategoryValue(market.category),
    close_time: BigInt(Math.floor(market.expiryTimestamp.getTime() / 1000)),
    seed_amount: seed,
    initial_yes_bps: initialYesBps(market.initialYesProb),
  });

  if (result.mode === 'live') {
    await prisma.market.update({
      where: { id: market.id },
      data: { onChainMarketId: result.value, creationTxHash: result.txHash, status: 'ACTIVE' },
    });
    logger.info({ marketId: market.id, onChainMarketId: result.value.toString() }, 'Market created on-chain');
  } else {
    logger.info(
      { marketId: market.id, simulatedMarketId: result.value.toString() },
      'Market creation simulated (dry-run); market stays PENDING',
    );
  }
  return result;
}
