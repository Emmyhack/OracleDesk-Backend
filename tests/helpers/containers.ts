/**
 * Where the integration tier gets Postgres 16 and Redis 7 (#135).
 *
 * - CI (or any machine with services already running): set TEST_DATABASE_URL
 *   (an admin connection, used for CREATE DATABASE) and TEST_REDIS_URL.
 * - Locally: Testcontainers starts pgvector/pgvector:pg16 (Postgres 16 with the vector extension, #69) and redis:7-alpine.
 *   Containers are reused across runs only when TESTCONTAINERS_REUSE_ENABLE=true.
 * - Neither available: returns null so the suite skips with one clear message.
 */
export interface Services {
  adminDatabaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

export async function ensureContainers(): Promise<Services | null> {
  const { TEST_DATABASE_URL, TEST_REDIS_URL } = process.env;
  if (TEST_DATABASE_URL && TEST_REDIS_URL) {
    return { adminDatabaseUrl: TEST_DATABASE_URL, redisUrl: TEST_REDIS_URL, stop: async () => undefined };
  }

  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { RedisContainer } = await import('@testcontainers/redis');
    const reuse = process.env.TESTCONTAINERS_REUSE_ENABLE === 'true';
    let pg = new PostgreSqlContainer('pgvector/pgvector:pg16');
    let redis = new RedisContainer('redis:7-alpine');
    if (reuse) {
      pg = pg.withReuse();
      redis = redis.withReuse();
    }
    const [pgStarted, redisStarted] = await Promise.all([pg.start(), redis.start()]);
    return {
      adminDatabaseUrl: pgStarted.getConnectionUri(),
      redisUrl: redisStarted.getConnectionUrl(),
      async stop() {
        if (reuse) return;
        await Promise.all([pgStarted.stop(), redisStarted.stop()]);
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[integration] Skipping: no TEST_DATABASE_URL/TEST_REDIS_URL and Docker is unavailable (${reason}).`,
    );
    return null;
  }
}
