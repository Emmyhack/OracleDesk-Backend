/**
 * Wall clock and timers behind one seam (#72).
 *
 * Throttles, retry waits, cache TTLs, the GDELT deadline and the "Current
 * date" line of the market prompt read time through here, so tests can run a
 * full agent cycle on a fixed clock without real waiting:
 *
 *   const clock = new FakeClock(new Date('2026-10-18T12:00:00Z'));
 *   const prev = setClock(clock);
 *   ...
 *   setClock(prev);
 *
 * Production keeps `systemClock` (Date, setTimeout).
 */
import { deadline as resilienceDeadline, sleep as resilienceSleep, TimeoutError, type DeadlineHandle, type Dependency } from './resilience';

export interface Clock {
  now(): Date;
  /** Waits `ms`, rejecting if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * An abort signal that fires after `ms` (or with `parent`). Deadlines are
   * timers like sleeps, so a fake clock decides when they fire.
   */
  deadline(dep: Dependency, parent: AbortSignal | undefined, ms: number): DeadlineHandle;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: resilienceSleep,
  deadline: (dep, parent, ms) => resilienceDeadline(dep, parent, ms),
};

let current: Clock = systemClock;

/** Test seam. Pass null to restore the system clock. Returns the previous clock. */
export function setClock(next: Clock | null): Clock {
  const prev = current;
  current = next ?? systemClock;
  return prev;
}

export function getClock(): Clock {
  return current;
}

export const now = (): Date => current.now();
export const nowMs = (): number => current.now().getTime();
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => current.sleep(ms, signal);
export const clockDeadline = (dep: Dependency, parent: AbortSignal | undefined, ms: number): DeadlineHandle =>
  current.deadline(dep, parent, ms);

interface PendingTimer {
  at: number;
  fire: () => void;
}

/**
 * Virtual time for tests. `sleep` resolves at once and moves time forward by
 * the requested amount, so throttles and retries cost nothing. Deadlines only
 * fire when the test moves time past them with `advance`; a sleep elsewhere
 * does not expire them, so a replayed response can never lose a race against a
 * timer it would beat in production.
 */
export class FakeClock implements Clock {
  private t: number;
  private timers: PendingTimer[] = [];
  /** Every sleep requested, in order (ms). */
  readonly sleeps: number[] = [];

  constructor(start: Date | number = Date.UTC(2026, 9, 18, 12, 0, 0)) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += Math.max(0, ms);
  }

  deadline(dep: Dependency, parent: AbortSignal | undefined, ms: number): DeadlineHandle {
    const controller = new AbortController();
    const onParent = () => controller.abort(parent!.reason);
    if (parent?.aborted) controller.abort(parent.reason);
    else parent?.addEventListener('abort', onParent, { once: true });
    const timer: PendingTimer = { at: this.t + ms, fire: () => controller.abort(new TimeoutError(dep, ms)) };
    this.timers.push(timer);
    const startedAt = this.t;
    return {
      signal: controller.signal,
      ms,
      remaining: () => Math.max(0, startedAt + ms - this.t),
      cleanup: () => {
        this.timers = this.timers.filter((x) => x !== timer);
        parent?.removeEventListener('abort', onParent);
      },
    };
  }

  /** Moves time forward and fires the deadlines that are now due. */
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const timer of due) timer.fire();
  }
}
