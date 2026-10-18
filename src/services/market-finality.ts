/**
 * The one place a market becomes RESOLVED or CANCELLED, shared by the indexer
 * (MarketResolved events) and the reconciler (missed resolutions, #83) so the
 * two cannot diverge.
 */
import { prisma } from '../lib/prisma';

export type FinalOutcome = 'Yes' | 'No' | null; // null: the market was voided

/**
 * Marks the market final and closes its open positions in one transaction.
 *
 * Guarded by `chainSyncedLedger`: the write applies only if the row has not
 * seen a newer ledger, and only from a non-final status (RESOLVING and every
 * other state may still become final). `lte` rather than `lt`, because the
 * transition is idempotent and an event may arrive for the ledger an earlier
 * observation already recorded. Returns false when the row was skipped, i.e.
 * a newer writer already moved it.
 */
export async function applyMarketFinality(
  marketId: string,
  outcome: FinalOutcome,
  at: Date,
  ledger: number,
  db: Pick<typeof prisma, '$transaction'> = prisma,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const updated = await tx.market.updateMany({
      where: {
        id: marketId,
        status: { notIn: ['RESOLVED', 'CANCELLED'] },
        OR: [{ chainSyncedLedger: null }, { chainSyncedLedger: { lte: ledger } }],
      },
      data: {
        status: outcome ? 'RESOLVED' : 'CANCELLED',
        resolvedOutcome: outcome ? outcome === 'Yes' : null,
        resolvedAt: at,
        chainSyncedLedger: ledger,
      },
    });
    if (updated.count === 0) return false;
    await tx.position.updateMany({
      where: { marketId, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: at, closeReason: outcome ? `${outcome.toUpperCase()}_RESOLVED` : 'VOIDED' },
    });
    return true;
  });
}
