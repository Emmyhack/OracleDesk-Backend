/**
 * npm run backfill:embeddings [-- --reembed] [--batch 64]
 *
 * Embeds markets whose questionEmbedding is NULL (#69). With --reembed it also
 * redoes rows embedded by a different model: vectors from two models are never
 * compared, so after changing EMBEDDING_MODEL run this once.
 */
import { backfillEmbeddings, getEmbeddingProvider } from '../src/services/embeddings.service';
import { initSecrets } from '../src/config/secrets';
import { config } from '../src/config';
import { prisma } from '../src/lib/prisma';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const batchIdx = argv.indexOf('--batch');
  const batch = batchIdx >= 0 ? Number(argv[batchIdx + 1]) : 64;
  await initSecrets(config);
  const provider = getEmbeddingProvider();
  if (!provider) {
    console.error('EMBEDDING_PROVIDER is none; nothing to do');
    process.exit(1);
  }
  const result = await backfillEmbeddings(batch, { reembed: argv.includes('--reembed') });
  console.log(`model ${provider.model}: embedded ${result.embedded}, failed ${result.failed}`);
  await prisma.$disconnect();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
