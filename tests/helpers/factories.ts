import type { PrismaClient } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';

// Counter-based (not random) values keep failures reproducible.
let n = 0;
const next = () => ++n;

export async function makeUser(prisma: PrismaClient, overrides: { walletAddress?: string } = {}) {
  const walletAddress = overrides.walletAddress ?? Keypair.random().publicKey();
  return prisma.user.create({
    data: { walletAddress, identityKey: walletAddress },
  });
}

export async function makeMarket(
  prisma: PrismaClient,
  overrides: { onChainMarketId?: bigint; status?: string } = {},
) {
  const i = next();
  return prisma.market.create({
    data: {
      question: `Test market ${i}?`,
      category: 'FED',
      initialYesProb: 0.5,
      confidenceInterval: { lower: 0.4, upper: 0.6 },
      expiryTimestamp: new Date(Date.now() + 86_400_000),
      ...(overrides.onChainMarketId !== undefined ? { onChainMarketId: overrides.onChainMarketId } : {}),
      ...(overrides.status ? { status: overrides.status as never } : {}),
    },
  });
}
