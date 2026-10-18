import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

let client: Redis | null = null;
const blocking = new Set<Redis>();

/** Shared lazy Redis connection. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  }
  return client;
}

/**
 * A new dedicated connection for blocking commands (XREAD BLOCK). A blocking
 * read on the shared client would stall every other command queued behind it,
 * such as the SEP-10 challenge GETDEL. The caller closes it with
 * releaseBlockingRedis(); closeRedis() closes any still open.
 */
export function getBlockingRedis(): Redis {
  const connection = getRedis().duplicate();
  connection.on('error', (err) => logger.error({ err: err.message }, 'Redis (blocking) error'));
  blocking.add(connection);
  return connection;
}

export function releaseBlockingRedis(connection: Redis): void {
  blocking.delete(connection);
  // disconnect() also aborts a command blocked in XREAD.
  connection.disconnect();
}

export async function closeRedis(): Promise<void> {
  for (const connection of blocking) connection.disconnect();
  blocking.clear();
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
