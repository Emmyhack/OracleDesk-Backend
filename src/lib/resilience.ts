import { config } from '../config';
import { AppError } from '../middlewares/error.middleware';

export type Dependency =
  | 'rpc-read'
  | 'rpc-write'
  | 'rpc-events'
  | 'llm'
  | 'ipfs-pin'
  | 'ipfs-fetch'
  | 'datasource';

export class TimeoutError extends AppError {
  constructor(public readonly dependency: Dependency, public readonly timeoutMs: number) {
    super(504, 'UPSTREAM_TIMEOUT', `${dependency} timed out after ${timeoutMs}ms`, {
      dependency,
      timeoutMs,
    });
    this.name = 'TimeoutError';
  }
}

export class SaturatedError extends AppError {
  constructor(public readonly dependency: Dependency) {
    super(503, 'UPSTREAM_SATURATED', `${dependency} bulkhead saturated`, {
      dependency,
    });
    this.name = 'SaturatedError';
  }
}

export class ClientAbortedError extends AppError {
  constructor(message = 'Client aborted request') {
    super(499, 'CLIENT_ABORTED', message);
    this.name = 'ClientAbortedError';
  }
}

export function getDefaultTimeout(dep: Dependency): number {
  switch (dep) {
    case 'rpc-read':
      return config.TIMEOUT_RPC_READ_MS;
    case 'rpc-write':
      return config.TIMEOUT_RPC_WRITE_MS;
    case 'rpc-events':
      return config.TIMEOUT_RPC_EVENTS_MS;
    case 'llm':
      return config.TIMEOUT_LLM_MS;
    case 'ipfs-pin':
      return config.TIMEOUT_IPFS_PIN_MS;
    case 'ipfs-fetch':
      return config.TIMEOUT_IPFS_FETCH_MS;
    case 'datasource':
      return config.TIMEOUT_DATASOURCE_MS;
  }
}

export interface DeadlineHandle {
  signal: AbortSignal;
  ms: number;
  remaining(): number;
  cleanup?: () => void;
}

export function deadline(
  dep: Dependency,
  parent?: AbortSignal,
  overrideMs?: number,
): DeadlineHandle {
  const ms = overrideMs ?? getDefaultTimeout(dep);
  const start = Date.now();
  const controller = new AbortController();

  const remaining = () => Math.max(0, ms - (Date.now() - start));

  let timer: NodeJS.Timeout | null = null;
  let onParentAbort: (() => void) | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parent && onParentAbort) {
      parent.removeEventListener('abort', onParentAbort);
      onParentAbort = null;
    }
  };

  if (parent?.aborted) {
    controller.abort(parent.reason ?? new ClientAbortedError());
    return { signal: controller.signal, ms, remaining, cleanup };
  }

  timer = setTimeout(() => {
    controller.abort(new TimeoutError(dep, ms));
  }, ms);

  if (parent) {
    onParentAbort = () => {
      cleanup();
      controller.abort(parent.reason ?? new ClientAbortedError());
    };
    parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    ms,
    remaining,
    cleanup,
  };
}

export class Bulkhead {
  private activeCount = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (err: any) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private rejectedCount = 0;

  constructor(
    public readonly name: Dependency,
    public readonly maxConcurrent: number,
    public readonly maxQueue: number,
  ) {}

  stats(): { active: number; queued: number; rejected: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      rejected: this.rejectedCount,
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw (signal.reason instanceof AppError ? signal.reason : new ClientAbortedError());
    }

    if (this.activeCount >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) {
        this.rejectedCount++;
        throw new SaturatedError(this.name);
      }

      await new Promise<void>((resolve, reject) => {
        let entry: any;
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(signal?.reason instanceof AppError ? signal.reason : new ClientAbortedError());
        };

        entry = { resolve, reject, signal, onAbort };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        this.queue.push(entry);
      });
    }

    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      this.dequeueNext();
    }
  }

  private dequeueNext(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        continue;
      }
      next.resolve();
      break;
    }
  }
}

export const bulkheads: Record<Dependency, Bulkhead> = {
  'llm': new Bulkhead('llm', config.BULKHEAD_LLM, config.BULKHEAD_QUEUE),
  'ipfs-pin': new Bulkhead('ipfs-pin', config.BULKHEAD_IPFS, config.BULKHEAD_QUEUE),
  'ipfs-fetch': new Bulkhead('ipfs-fetch', config.BULKHEAD_IPFS, config.BULKHEAD_QUEUE),
  'rpc-read': new Bulkhead('rpc-read', config.BULKHEAD_RPC_READ, config.BULKHEAD_QUEUE),
  'rpc-write': new Bulkhead('rpc-write', config.BULKHEAD_RPC_WRITE, config.BULKHEAD_QUEUE),
  'rpc-events': new Bulkhead('rpc-events', config.BULKHEAD_RPC_EVENTS, config.BULKHEAD_QUEUE),
  'datasource': new Bulkhead('datasource', config.BULKHEAD_DATASOURCE, config.BULKHEAD_QUEUE),
};

export async function withTimeout<T>(
  dep: Dependency,
  fn: (signal: AbortSignal) => Promise<T>,
  opts?: { signal?: AbortSignal; ms?: number },
): Promise<T> {
  const bulkhead = bulkheads[dep];

  return bulkhead.run(async () => {
    const handle = deadline(dep, opts?.signal, opts?.ms);
    try {
      return await fn(handle.signal);
    } catch (err: any) {
      if (opts?.signal?.aborted) {
        if (err instanceof ClientAbortedError) throw err;
        throw new ClientAbortedError(err?.message ?? 'Client aborted request');
      }
      if (handle.signal.aborted) {
        if (handle.signal.reason instanceof TimeoutError) {
          throw handle.signal.reason;
        }
        if (err instanceof TimeoutError) {
          throw err;
        }
        if (
          err?.name === 'AbortError' ||
          err?.code === 'ERR_ABORTED' ||
          err?.message?.includes('aborted') ||
          err?.message?.includes('timeout')
        ) {
          throw new TimeoutError(dep, handle.ms);
        }
      }
      throw err;
    } finally {
      handle.cleanup?.();
    }
  }, opts?.signal);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const reason = signal.reason instanceof AppError ? signal.reason : new ClientAbortedError();
    return Promise.reject(reason);
  }
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal!.reason instanceof AppError ? signal!.reason : new ClientAbortedError();
      reject(reason);
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
