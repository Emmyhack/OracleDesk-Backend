/**
 * Internal event bus for committed chain events (#93).
 *
 * The indexer publishes one message per public event, identified by the
 * `chain_events.id` it came from. A single fan-out consumer (src/lib/fanout.ts)
 * reads the bus and emits to socket.io, whose Redis Streams adapter reaches
 * the clients of every instance.
 *
 * Delivery is at-least-once on publication (a crash between XADD and the
 * `published` flag republishes) and effectively-once on delivery, because the
 * consumer drops ids it has already delivered.
 *
 * The Redis stream is a bounded delivery buffer (MAXLEN ~). `chain_events` is
 * the durable history; anything that must replay far back reads that table.
 */
import type Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';
import { getBlockingRedis, getRedis, releaseBlockingRedis } from './redis';

export interface BusEvent {
  /** chain_events.id: the RPC event id, globally unique. */
  id: string;
  /** TRADE_EXECUTED | REASONING_PUBLISHED */
  type: string;
  ledger: number;
  /** On-chain market id as a decimal string; the per-market ordering key. */
  marketKey: string | null;
  payload: unknown;
}

export type BusHandler = (event: BusEvent, streamId: string) => void | Promise<void>;

export interface EventBus {
  /** Appends the event; resolves with its stream id. */
  publish(event: BusEvent): Promise<string>;
  /**
   * Delivers events after `fromId` (exclusive) to `handler` one at a time, in
   * publish order, starting with the current tail when `fromId` is omitted.
   * A handler that throws is logged and the stream moves on. The returned
   * function stops the subscription and resolves when no handler is running.
   */
  subscribe(handler: BusHandler, opts?: { fromId?: string }): () => Promise<void>;
  /** Id of the newest entry, or "0-0" when the bus is empty. */
  tailId(): Promise<string>;
}

export const EVENT_STREAM_KEY = 'oracledesk:events';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bigintSafe = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

function encode(event: BusEvent): string[] {
  return [
    'id', event.id,
    'type', event.type,
    'ledger', String(event.ledger),
    'marketKey', event.marketKey ?? '',
    'payload', JSON.stringify(event.payload, bigintSafe),
  ];
}

function decode(fields: string[]): BusEvent | null {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]] = fields[i + 1];
  if (!map.id || !map.type) return null;
  try {
    return {
      id: map.id,
      type: map.type,
      ledger: Number(map.ledger),
      marketKey: map.marketKey ? map.marketKey : null,
      payload: JSON.parse(map.payload ?? 'null'),
    };
  } catch {
    return null;
  }
}

export interface RedisBusOptions {
  /** Stream key; tests use a per-test prefix. */
  key?: string;
  maxLen?: number;
  /** Connection for XADD and XREVRANGE. */
  redis?: Redis;
  /** Creates the dedicated connection for each blocking read loop. */
  blocking?: () => Redis;
  /** Ends a connection made by `blocking`. */
  release?: (connection: Redis) => void;
}

export function redisEventBus(opts: RedisBusOptions = {}): EventBus {
  const key = opts.key ?? EVENT_STREAM_KEY;
  const maxLen = opts.maxLen ?? config.EVENT_BUS_MAXLEN;
  const shared = () => opts.redis ?? getRedis();
  const open = opts.blocking ?? getBlockingRedis;
  const release = opts.release ?? releaseBlockingRedis;

  async function tailId(connection: Redis = shared()): Promise<string> {
    const rows = await connection.xrevrange(key, '+', '-', 'COUNT', 1);
    return rows.length > 0 ? rows[0][0] : '0-0';
  }

  return {
    async publish(event) {
      // MAXLEN ~ trims in whole macro nodes, so the length may overshoot a little.
      const id = await shared().xadd(key, 'MAXLEN', '~', maxLen, '*', ...encode(event));
      if (!id) throw new Error('XADD returned no id');
      return id;
    },

    tailId: () => tailId(),

    subscribe(handler, subscribeOpts = {}) {
      const connection = open();
      let stopped = false;

      const loop = (async () => {
        // '$' would be re-evaluated on every XREAD and skip what arrives between
        // two reads, so the starting point is pinned to a concrete id.
        let last = subscribeOpts.fromId;
        while (!stopped && last === undefined) {
          try {
            last = await tailId(connection);
          } catch (err) {
            if (stopped) return;
            logger.warn({ err: err instanceof Error ? err.message : err }, 'Event bus: cannot read the stream tail; retrying');
            await sleep(1000);
          }
        }
        while (!stopped) {
          try {
            const result = await connection.xread('COUNT', 100, 'BLOCK', 1000, 'STREAMS', key, last as string);
            if (!result) continue;
            for (const [, entries] of result) {
              for (const [streamId, fields] of entries) {
                if (stopped) return;
                last = streamId;
                const event = decode(fields);
                if (!event) {
                  logger.warn({ streamId }, 'Event bus: skipping an undecodable entry');
                  continue;
                }
                try {
                  await handler(event, streamId);
                } catch (err) {
                  logger.error({ err, eventId: event.id }, 'Event bus: handler failed');
                }
              }
            }
          } catch (err) {
            if (stopped) return;
            logger.warn({ err: err instanceof Error ? err.message : err }, 'Event bus: read failed; retrying');
            await sleep(1000);
          }
        }
      })();

      return async () => {
        stopped = true;
        release(connection);
        await loop.catch(() => undefined);
      };
    },
  };
}

interface MemoryEntry {
  seq: number;
  event: BusEvent;
}

/** In-process bus: tests, and development without Redis events. */
export function memoryEventBus(opts: { maxLen?: number } = {}): EventBus {
  const maxLen = opts.maxLen ?? 10_000;
  const log: MemoryEntry[] = [];
  let seq = 0;
  const subscribers = new Set<(entry: MemoryEntry) => void>();

  const streamId = (n: number) => `${n}-0`;
  const parse = (id: string) => Number.parseInt(id.split('-')[0] ?? '0', 10) || 0;

  return {
    async publish(event) {
      seq += 1;
      // Same wire round-trip as Redis, so bigint and undefined behave identically.
      const entry = { seq, event: JSON.parse(JSON.stringify(event, bigintSafe)) as BusEvent };
      log.push(entry);
      if (log.length > maxLen) log.splice(0, log.length - maxLen);
      for (const deliver of subscribers) deliver(entry);
      return streamId(seq);
    },

    async tailId() {
      return log.length > 0 ? streamId(log[log.length - 1].seq) : '0-0';
    },

    subscribe(handler, subscribeOpts = {}) {
      const from = subscribeOpts.fromId !== undefined ? parse(subscribeOpts.fromId) : seq;
      let chain: Promise<void> = Promise.resolve();

      const deliver = (entry: MemoryEntry) => {
        chain = chain.then(async () => {
          try {
            await handler(entry.event, streamId(entry.seq));
          } catch (err) {
            logger.error({ err, eventId: entry.event.id }, 'Event bus: handler failed');
          }
        });
      };

      for (const entry of log) if (entry.seq > from) deliver(entry);
      subscribers.add(deliver);

      // Stopping ends new deliveries; entries already queued still run.
      return async () => {
        subscribers.delete(deliver);
        await chain;
      };
    },
  };
}
