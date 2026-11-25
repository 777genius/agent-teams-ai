// @vitest-environment node
import { expect, it } from 'vitest';

import {
  ARMED_AT, type CronerTestClock, OBSERVATION_END, TARGET_AT, withCronerTestClock,
} from './CronerTestClock';

const firstSecond = Math.ceil(ARMED_AT / 1000) * 1000;
const iso = (time: number) => new Date(time).toISOString();

async function intermediate(clock: CronerTestClock) {
  await clock.fireNextAt(ARMED_AT + 30_000);
  expect(clock.calls).toEqual([]);
  expect(clock.nextDue()).toBe(TARGET_AT);
}

it.each(['normal', 'delayed', 'early without crossing'] as const)('runs one occurrence after %s wake', async mode => {
  await withCronerTestClock(async clock => {
    clock.create();
    await intermediate(clock);
    let at = TARGET_AT;
    if (mode === 'delayed') at = TARGET_AT + 5000;
    else if (mode === 'early without crossing') at = TARGET_AT - 1;
    await clock.fireNextAt(at);
    await clock.through(OBSERVATION_END);
    expect(clock.calls).toEqual([mode === 'delayed' ? TARGET_AT + 5000 : TARGET_AT]);
  });
});

it('keeps the initial target when constructor scheduling crosses its second', async () => {
  await withCronerTestClock(async clock => {
    clock.moveTo(TARGET_AT - 1);
    clock.sample([TARGET_AT - 1, TARGET_AT - 1, TARGET_AT + 1], () => clock.create());
    await clock.through(OBSERVATION_END);
    expect(clock.calls).toHaveLength(1);
    expect(clock.calls[0]).toBeGreaterThanOrEqual(TARGET_AT);
    expect(clock.calls[0]).toBeLessThan(TARGET_AT + 15_000);
  });
});

it.each([
  { name: 'early check and reschedule', samples: [TARGET_AT - 1, TARGET_AT + 1] },
  { name: 'delay and target calculation', samples: [TARGET_AT - 1, TARGET_AT - 1, TARGET_AT - 1, TARGET_AT + 1] },
])('retains the admitted target across $name', async ({ samples }) => {
  await withCronerTestClock(async clock => {
    clock.create({ deferred: true, options: { unref: true } });
    await intermediate(clock);
    await clock.fireNextAt(TARGET_AT - 1, samples);
    await clock.through(OBSERVATION_END);
    expect(clock.calls).toHaveLength(1);
    expect(clock.calls[0]).toBeGreaterThanOrEqual(TARGET_AT);
    expect(clock.calls[0]).toBeLessThan(TARGET_AT + 15_000);
    expect(clock.unrefs).toBe(clock.registrations);
  });
});

it('preserves startAt, interval spacing and exclusive stopAt', async () => {
  await withCronerTestClock(async clock => {
    const start = Date.parse('2026-11-21T15:09:00.000Z');
    const job = clock.create({ pattern: '* * * * * *', options: {
      startAt: iso(start), interval: 3, stopAt: iso(start + 6000),
    } });
    expect(job.nextRun()?.toISOString()).toBe(iso(start));
    await clock.through(start + 10_000);
    expect(clock.calls).toEqual([start, start + 3000]);
    expect(clock.pendingCount()).toBe(0);
  });
});

it('does not rearm after maxRuns is exhausted', async () => {
  await withCronerTestClock(async clock => {
    const job = clock.create({ pattern: '* * * * * *', options: { maxRuns: 2 } });
    await clock.through(firstSecond + 5000);
    expect(clock.calls).toEqual([firstSecond, firstSecond + 1000]);
    expect(job.runsLeft()).toBe(0);
    expect(clock.pendingCount()).toBe(0);
  });
});

it('preserves protect while the original callback is pending', async () => {
  await withCronerTestClock(async clock => {
    let release!: () => void;
    let protectedCount = 0;
    const job = clock.create({ pattern: '* * * * * *', options: {
      protect: () => { protectedCount++; },
    }, callback: () => clock.calls.length === 1 ? new Promise<void>(resolve => { release = resolve; }) : undefined });
    clock.cleanup.push(() => release?.());
    await clock.fireNextAt(firstSecond);
    expect(job.isBusy()).toBe(true);
    await clock.fireNextAt(firstSecond + 1000);
    expect(clock.calls).toHaveLength(1);
    await clock.through(firstSecond + 1001);
    expect(protectedCount).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(job.isBusy()).toBe(false);
    await clock.fireNextAt(firstSecond + 2000);
    expect(clock.calls).toEqual([firstSecond, firstSecond + 2000]);
  });
});

it('recalculates an interval target changed by public trigger()', async () => {
  await withCronerTestClock(async clock => {
    const job = clock.create({ pattern: '* * * * * *', options: { interval: 5 } });
    clock.moveTo(firstSecond - 100);
    await job.trigger();
    // Timezone-aware currentRun() projects whole seconds.
    expect(job.currentRun()?.toISOString()).toBe(iso(firstSecond - 1000));
    await clock.fireNextAt(firstSecond - 1);
    expect(clock.nextDue()).toBe(firstSecond + 4000);
    await clock.through(firstSecond + 5000);
    expect(clock.calls).toEqual([firstSecond - 100, firstSecond + 4000]);
  });
});

it('preserves the dayOffset callback target', async () => {
  await withCronerTestClock(async clock => {
    const shifted = TARGET_AT + 86_400_000;
    const job = clock.create({ options: { dayOffset: 1 } });
    expect(job.nextRun()?.toISOString()).toBe(iso(shifted));
    await clock.fireNextAt(shifted);
    expect(clock.calls).toEqual([shifted]);
  });
});
