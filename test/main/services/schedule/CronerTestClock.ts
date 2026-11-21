import assert from 'node:assert/strict';

import { Cron, type CronOptions } from 'croner';

export const ARMED_AT = Date.parse('2026-11-21T15:08:54.853Z');
export const TARGET_AT = Date.parse('2026-11-21T15:09:52.000Z');
export const OBSERVATION_END = Date.parse('2026-11-21T15:10:09.926Z');
export const ANNUAL_CRON = '52 9 15 21 11 *';

interface CapturedTimer {
  due: number;
  invoke(): void;
}

export interface CronerTestClock {
  calls: number[];
  cleanup: (() => void | Promise<void>)[];
  registrations: number;
  unrefs: number;
  now(): number;
  pendingCount(): number;
  nextDue(): number | undefined;
  moveTo(time: number): void;
  sample<T>(readings: number[], action: () => T): T;
  create(input?: {
    pattern?: string;
    options?: CronOptions;
    deferred?: boolean;
    callback?(): void | Promise<void>;
  }): Cron;
  fireNextAt(time: number, readings?: number[]): Promise<void>;
  through(time: number): Promise<void>;
}

/** Execute real Croner callbacks; substitute only wall time and the timer transport. */
export async function withCronerTestClock(action: (clock: CronerTestClock) => Promise<void>): Promise<void> {
  const original = { Date, setTimeout, clearTimeout };
  let now = ARMED_AT;
  let readings: number[] = [];
  const pending = new Map<ReturnType<typeof setTimeout>, CapturedTimer>();
  const sample = () => {
    const value = readings.shift() ?? now;
    assert.ok(value >= now, 'The controlled clock must be monotonic');
    now = value;
    return now;
  };
  class ControlledDate extends original.Date {
    constructor(...args: unknown[]) {
      const value = args.length ? Reflect.construct(original.Date, args) as Date : new original.Date(sample());
      super(value.getTime());
    }
    static now(): number { return sample(); }
  }
  const next = () => [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
  const clock: CronerTestClock = {
    calls: [], cleanup: [], registrations: 0, unrefs: 0,
    now: () => now,
    pendingCount: () => pending.size,
    nextDue: () => next()?.[1].due,
    moveTo(time) { assert.ok(time >= now); now = time; },
    sample(samples, operation) {
      assert.equal(readings.length, 0);
      assert.ok(samples.every((value, index) => value >= (index ? samples[index - 1] : now)));
      readings = [...samples];
      try { return operation(); }
      finally {
        // Removing redundant clock reads must not fail the observable invariant.
        // Both implementations reach the same final wall-clock boundary.
        readings = [];
        now = Math.max(now, samples.at(-1) ?? now);
      }
    },
    create({ pattern = ANNUAL_CRON, options = {}, deferred = false, callback } = {}) {
      const invoke = () => { clock.calls.push(now); return callback?.(); };
      const job = deferred
        ? new Cron(pattern, { timezone: 'UTC', paused: true, ...options })
        : new Cron(pattern, { timezone: 'UTC', paused: true, ...options }, invoke);
      clock.cleanup.push(() => job.stop());
      if (deferred) job.schedule(invoke);
      job.resume();
      return job;
    },
    async fireNextAt(time, samples = []) {
      clock.moveTo(time);
      const timer = next();
      assert.ok(timer, 'An original captured timer must exist');
      pending.delete(timer[0]);
      clock.sample(samples, timer[1].invoke);
      await Promise.resolve();
    },
    async through(end) {
      for (let count = 0; count < 24; count++) {
        const due = clock.nextDue();
        if (due === undefined || due > end) { clock.moveTo(end); return; }
        await clock.fireNextAt(Math.max(now, due));
      }
      throw new Error('Finite Croner timer budget exhausted');
    },
  };
  globalThis.Date = ControlledDate as DateConstructor;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 1, ...args: unknown[]) => {
    assert.ok(Number.isFinite(delay) && delay <= 2_147_483_647);
    const timer = { unref() { clock.unrefs++; return this; } } as ReturnType<typeof setTimeout>;
    clock.registrations++;
    pending.set(timer, { due: now + Math.max(1, Math.trunc(delay)), invoke: () => callback(...args) });
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = timer => { pending.delete(timer as ReturnType<typeof setTimeout>); };
  try { await action(clock); }
  finally {
    try {
      for (const close of clock.cleanup.toReversed()) await close();
      assert.equal(pending.size, 0, 'Every test-owned timer must be cleaned up');
    } finally {
      globalThis.Date = original.Date;
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
    }
  }
}
