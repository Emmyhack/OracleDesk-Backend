/**
 * Backfills sharesRaw / costBasisRaw / feesPaidRaw for pre-#78 positions.
 * Idempotent. Usage: npx tsx scripts/backfill-position-shares.ts
 */
import { backfillPositionShares } from '../src/services/position-backfill.service';
import { prisma } from '../src/lib/prisma';

async function main() {
  const report = await backfillPositionShares();
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
