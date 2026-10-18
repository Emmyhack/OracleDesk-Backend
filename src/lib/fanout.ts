/**
 * Socket fan-out (#93): one elected instance reads the event bus and calls
 * io.emit. With the socket.io Redis Streams adapter that single emit reaches
 * the clients of every instance, so API-only replicas deliver events too.
 *
 * Why one consumer plus the adapter, rather than every instance emitting to
 * its own sockets: the adapter is needed anyway for per-user rooms and
 * private events (#94), and routing then lives in one place instead of being
 * rebuilt by each feature.
 *
 * Leader election: SET leader NX PX, renewed by compare-and-set. The leader
 * persists the stream id of the last event it delivered, so a successor
 * resumes there (no gap). Each delivery is recorded under a `seen` key after
 * the emit and checked before it, so a successor replaying the leader's last
 * event does not deliver it twice. Leadership is re-checked before delivering
 * (fencing) so a leader that lost the lock during a pause stops emitting.
 */
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { config } from '../config';
import { logger } from './logger';
import { getRedis } from './redis';
import type { BusEvent, EventBus } from './event-bus';
import { assertPublic } from './socket-auth';

export interface FanoutOptions {
  redis?: Redis;
  /** Key prefix; tests use a per-test prefix. */
  prefix?: string;
  instanceId?: string;
  /** Lock lifetime without renewal. */
  leaseMs?: number;
  /** How often the leader renews and candidates try to acquire. */
  renewMs?: number;
  /** How long a delivered id is remembered. */
  seenTtlSeconds?: number;
  /** Leadership is re-read from Redis before delivering if last confirmed longer ago than this. */
  fenceMs?: number;
}

const RENEW_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const LOCAL_SEEN_MAX = 10_000;

export function startFanout(bus: EventBus, io: Pick<Server, 'emit'>, opts: FanoutOptions = {}): () => Promise<void> {
  const redis = opts.redis ?? getRedis();
  const prefix = opts.prefix ?? 'oracledesk:fanout';
  const instanceId = opts.instanceId ?? config.INSTANCE_ID;
  const leaseMs = opts.leaseMs ?? 15_000;
  const renewMs = opts.renewMs ?? 5_000;
  const seenTtl = opts.seenTtlSeconds ?? 3600;
  const fenceMs = opts.fenceMs ?? 500;

  const leaderKey = `${prefix}:leader`;
  const cursorKey = `${prefix}:cursor`;
  const seenKey = (id: string) => `${prefix}:seen:${id}`;

  let leading = false;
  let stopSubscription: (() => Promise<void>) | null = null;
  let lastVerifiedAt = 0;
  let closed = false;
  let busy = false;
  const localSeen = new Set<string>();

  const remember = (id: string) => {
    localSeen.add(id);
    if (localSeen.size > LOCAL_SEEN_MAX) localSeen.delete(localSeen.values().next().value as string);
  };

  async function stillLeader(): Promise<boolean> {
    if (Date.now() - lastVerifiedAt < fenceMs) return true;
    const holder = await redis.get(leaderKey);
    if (holder !== instanceId) return false;
    lastVerifiedAt = Date.now();
    return true;
  }

  function dropLeadership(reason: string): void {
    if (!leading) return;
    leading = false;
    logger.warn({ instanceId, reason }, 'Fan-out: stopped consuming');
    const stop = stopSubscription;
    stopSubscription = null;
    // Not awaited: this can be called from inside the handler that stop() waits for.
    if (stop) void stop().catch(() => undefined);
  }

  async function deliver(event: BusEvent, streamId: string): Promise<void> {
    if (!leading) return;
    if (!(await stillLeader())) {
      dropLeadership('lost the lock');
      return;
    }
    if (localSeen.has(event.id) || (await redis.exists(seenKey(event.id))) === 1) {
      await redis.set(cursorKey, streamId);
      return;
    }
    assertPublic(event.type);
    io.emit(event.type, event.payload);
    remember(event.id);
    await redis.multi().set(seenKey(event.id), '1', 'EX', seenTtl).set(cursorKey, streamId).exec();
  }

  async function becomeLeader(): Promise<void> {
    leading = true;
    lastVerifiedAt = Date.now();
    let from = await redis.get(cursorKey);
    if (!from) {
      // First leader ever: pin the cursor to the current tail so a successor
      // resumes from here even if no event has been delivered yet.
      from = await bus.tailId();
      await redis.set(cursorKey, from);
    }
    stopSubscription = bus.subscribe(deliver, { fromId: from });
    logger.info({ instanceId, from }, 'Fan-out: became leader');
  }

  async function tick(): Promise<void> {
    if (closed || busy) return;
    busy = true;
    try {
      if (leading) {
        const renewed = await redis.eval(RENEW_LUA, 1, leaderKey, instanceId, String(leaseMs));
        if (renewed === 1) lastVerifiedAt = Date.now();
        else dropLeadership('lease not renewed');
      } else if ((await redis.set(leaderKey, instanceId, 'PX', leaseMs, 'NX')) === 'OK') {
        await becomeLeader();
      } else if ((await redis.eval(RENEW_LUA, 1, leaderKey, instanceId, String(leaseMs))) === 1) {
        // The lock is already ours: an earlier attempt took it, then failed before consuming.
        await becomeLeader();
      }
    } catch (err) {
      // Cannot reach Redis: assume the lease will lapse and stop emitting.
      dropLeadership('lock check failed');
      logger.warn({ err: err instanceof Error ? err.message : err }, 'Fan-out: leader check failed');
    } finally {
      busy = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), renewMs);
  timer.unref?.();

  return async () => {
    closed = true;
    clearInterval(timer);
    const wasLeading = leading;
    leading = false;
    const stop = stopSubscription;
    stopSubscription = null;
    if (stop) await stop().catch(() => undefined);
    if (wasLeading) await redis.eval(RELEASE_LUA, 1, leaderKey, instanceId).catch(() => undefined);
  };
}

/**
 * Single-process variant for EVENT_BUS_ENABLED=false: no leader election and
 * no Redis, one consumer emitting to this process's sockets.
 */
export function startLocalFanout(bus: EventBus, io: Pick<Server, 'emit'>): () => Promise<void> {
  return bus.subscribe((event) => {
    assertPublic(event.type);
    io.emit(event.type, event.payload);
  });
}
