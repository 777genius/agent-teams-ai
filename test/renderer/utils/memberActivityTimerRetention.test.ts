import { afterEach, describe, expect, it } from 'vitest';

import {
  createMemberActivityTimerId,
  MAX_TRACKED_ACTIVITY_TIMERS,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';

const STORAGE_PREFIX = 'member-activity-timer:';

function timerIdFor(taskId: string, startedAtMs: number): string {
  return createMemberActivityTimerId({
    teamName: 'alpha',
    memberName: 'bob',
    phase: 'work',
    taskId,
    startedAt: new Date(startedAtMs).toISOString(),
  });
}

function syncTaskTimer(taskId: string, startedAtMs: number, nowMs: number): string {
  const timerId = timerIdFor(taskId, startedAtMs);
  syncMemberActivityTimer({ timerId, startedAtMs, running: true, runId: 'run-1', nowMs });
  return timerId;
}

function storedTimerIds(): string[] {
  const storage = globalThis.localStorage;
  const ids: string[] = [];
  if (!storage) return ids;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) ids.push(key.slice(STORAGE_PREFIX.length));
  }
  return ids;
}

describe('memberActivityTimer retention', () => {
  afterEach(() => {
    resetMemberActivityTimerStoreForTests();
    globalThis.localStorage?.clear();
  });

  it('keeps the timer store bounded while work intervals keep rotating', () => {
    const baseMs = Date.parse('2026-05-07T09:00:00.000Z');
    const total = MAX_TRACKED_ACTIVITY_TIMERS + 120;
    for (let index = 0; index < total; index += 1) {
      syncTaskTimer(`task-${index}`, baseMs + index * 1_000, baseMs + index * 1_000);
    }
    const newestId = timerIdFor(`task-${total - 1}`, baseMs + (total - 1) * 1_000);

    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(storedTimerIds()).toContain(newestId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: newestId,
        startedAtMs: baseMs + (total - 1) * 1_000,
        running: true,
        runId: 'run-1',
        nowMs: baseMs + (total - 1) * 1_000 + 30_000,
      })
    ).toBe(30_000);
  });

  it('sweeps stale keys left over from earlier sessions', () => {
    const staleMs = Date.parse('2026-04-01T09:00:00.000Z');
    const staleCount = MAX_TRACKED_ACTIVITY_TIMERS + 40;
    for (let index = 0; index < staleCount; index += 1) {
      const startedAtMs = staleMs + index * 1_000;
      const staleId = timerIdFor(`old-task-${index}`, startedAtMs);
      globalThis.localStorage?.setItem(
        `${STORAGE_PREFIX}${staleId}`,
        JSON.stringify({
          version: 1,
          startedAtMs,
          baseElapsedMs: 0,
          elapsedMs: 1_000,
          updatedAtMs: startedAtMs,
          running: false,
          runId: null,
        })
      );
    }
    const brokenId = timerIdFor('broken-task', staleMs);
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${brokenId}`, 'not-json');
    expect(storedTimerIds().length).toBe(staleCount + 1);

    const activeId = syncTaskTimer(
      'active-task',
      Date.parse('2026-05-07T09:00:00.000Z'),
      Date.parse('2026-05-07T09:00:05.000Z')
    );

    const remaining = storedTimerIds();
    expect(remaining.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(remaining).toContain(activeId);
    expect(remaining).not.toContain(brokenId);
  });

  it('preserves elapsed time for the timer that is still observed', () => {
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const keptId = syncTaskTimer('kept-task', startedAtMs, startedAtMs + 5_000);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 50; index += 1) {
      syncTaskTimer(`filler-${index}`, startedAtMs - 1_000_000 + index, startedAtMs + 1_000);
    }
    syncMemberActivityTimer({
      timerId: keptId,
      startedAtMs,
      running: true,
      runId: 'run-1',
      nowMs: startedAtMs + 40_000,
    });

    expect(storedTimerIds()).toContain(keptId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: keptId,
        startedAtMs,
        running: true,
        runId: 'run-1',
        nowMs: startedAtMs + 45_000,
      })
    ).toBe(45_000);
  });
});
