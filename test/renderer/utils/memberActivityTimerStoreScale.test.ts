import { afterEach, describe, expect, it } from 'vitest';

import {
  createMemberActivityTimerId,
  MAX_TRACKED_ACTIVITY_TIMERS,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';

const PREFIX = 'member-activity-timer:';
const MEMBERS = ['ana', 'bo', 'cy', 'dev', 'eli', 'fay', 'gus', 'hal'];
const CYCLES = 300;

function storageStats(): { keys: number; chars: number } {
  const storage = globalThis.localStorage;
  let keys = 0;
  let chars = 0;
  if (!storage) return { keys, chars };
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    keys += 1;
    chars += key.length + (storage.getItem(key) ?? '').length;
  }
  return { keys, chars };
}

function seedLegacyKeys(count: number, baseMs: number): void {
  for (let index = 0; index < count; index += 1) {
    const startedAtMs = baseMs - (count - index) * 60_000;
    const timerId = createMemberActivityTimerId({
      teamName: 'legacy',
      memberName: 'old-member',
      phase: 'work',
      taskId: `legacy-task-${index}`,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    globalThis.localStorage?.setItem(
      `${PREFIX}${timerId}`,
      JSON.stringify({
        version: 1,
        startedAtMs,
        baseElapsedMs: 0,
        elapsedMs: 30_000,
        updatedAtMs: startedAtMs + 30_000,
        running: false,
        runId: null,
      })
    );
  }
}

function anchorFor(cycle: number, member: string, phase: 'work' | 'review', baseMs: number) {
  const startedAtMs =
    baseMs + (cycle * 16 + MEMBERS.indexOf(member) * 2 + (phase === 'work' ? 0 : 1)) * 1000;
  return {
    startedAtMs,
    timerId: createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: member,
      phase,
      taskId: `task-${cycle}`,
      startedAt: new Date(startedAtMs).toISOString(),
    }),
  };
}

function churnWorkload(legacyKeys: number): {
  keys: number;
  chars: number;
  runningElapsed: number;
  pausedElapsed: number;
} {
  resetMemberActivityTimerStoreForTests();
  globalThis.localStorage?.clear();
  const baseMs = Date.parse('2026-05-07T09:00:00.000Z');
  if (legacyKeys > 0) seedLegacyKeys(legacyKeys, baseMs);

  const running = anchorFor(0, 'ana', 'work', baseMs);
  const paused = anchorFor(0, 'bo', 'work', baseMs);
  syncMemberActivityTimer({
    timerId: running.timerId,
    startedAtMs: running.startedAtMs,
    running: true,
    runId: 'run-1',
    nowMs: running.startedAtMs,
  });
  syncMemberActivityTimer({
    timerId: paused.timerId,
    startedAtMs: paused.startedAtMs,
    running: true,
    runId: 'run-1',
    nowMs: paused.startedAtMs,
  });
  syncMemberActivityTimer({
    timerId: paused.timerId,
    startedAtMs: paused.startedAtMs,
    running: false,
    runId: 'run-1',
    nowMs: paused.startedAtMs + 45_000,
  });

  const finalNowMs = baseMs + ((CYCLES - 1) * 16 + 15) * 1000 + 1000;
  const start = performance.now();
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    for (const phase of ['work', 'review'] as const) {
      for (const member of MEMBERS) {
        const anchor = anchorFor(cycle, member, phase, baseMs);
        const nowMs = anchor.startedAtMs + 1_000;
        syncMemberActivityTimer({
          timerId: anchor.timerId,
          startedAtMs: anchor.startedAtMs,
          running: true,
          runId: 'run-1',
          nowMs,
        });
        // The two cards that stay on screen re-read on every parent render.
        readMemberActivityTimerElapsed({
          timerId: running.timerId,
          startedAtMs: running.startedAtMs,
          running: true,
          runId: 'run-1',
          nowMs,
        });
        readMemberActivityTimerElapsed({
          timerId: paused.timerId,
          startedAtMs: paused.startedAtMs,
          running: false,
          runId: 'run-1',
          nowMs,
        });
      }
    }
  }
  const totalMs = performance.now() - start;
  const { keys, chars } = storageStats();
  const runningElapsed = readMemberActivityTimerElapsed({
    timerId: running.timerId,
    startedAtMs: running.startedAtMs,
    running: true,
    runId: 'run-1',
    nowMs: finalNowMs,
  });
  const pausedElapsed = readMemberActivityTimerElapsed({
    timerId: paused.timerId,
    startedAtMs: paused.startedAtMs,
    running: false,
    runId: 'run-1',
    nowMs: finalNowMs,
  });
  console.log(`SCALE legacy=${legacyKeys} keys=${keys} chars=${chars} ms=${totalMs.toFixed(0)}`);
  return { keys, chars, runningElapsed, pausedElapsed };
}

describe('memberActivityTimer store scale', () => {
  afterEach(() => {
    resetMemberActivityTimerStoreForTests();
    globalThis.localStorage?.clear();
  });

  it('holds the cap and the on-screen elapsed over 4 800 anchors, empty or legacy', () => {
    for (const legacyKeys of [0, 2400]) {
      const outcome = churnWorkload(legacyKeys);
      expect(outcome.keys).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
      expect(outcome.runningElapsed).toBe(4_800_000);
      expect(outcome.pausedElapsed).toBe(45_000);
    }
  });
});
