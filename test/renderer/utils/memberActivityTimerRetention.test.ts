import { afterEach, describe, expect, it, vi } from 'vitest';

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
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('evicts the least recently observed timers first', () => {
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 30; index += 1) {
      const atMs = startedAtMs + index * 1_000;
      ids.push(syncTaskTimer(`ordered-${index}`, atMs, atMs));
    }

    const survivors = storedTimerIds();
    expect(survivors).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(survivors).toEqual(expect.arrayContaining(ids.slice(-MAX_TRACKED_ACTIVITY_TIMERS)));
    expect(survivors).not.toContain(ids[0]);
  });

  it('keeps a displayed paused timer and its accumulated elapsed', () => {
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const pausedId = timerIdFor('paused-task', startedAtMs);
    syncMemberActivityTimer({
      timerId: pausedId,
      startedAtMs,
      running: true,
      runId: 'run-1',
      nowMs: startedAtMs,
    });
    syncMemberActivityTimer({
      timerId: pausedId,
      startedAtMs,
      running: false,
      runId: 'run-1',
      nowMs: startedAtMs + 90_000,
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 60; index += 1) {
      const rotationMs = startedAtMs + 100_000 + index * 1_000;
      syncTaskTimer(`rotation-${index}`, rotationMs, rotationMs);
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: rotationMs + 500,
      });
    }

    expect(storedTimerIds()).toContain(pausedId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: startedAtMs + 400_000,
      })
    ).toBe(90_000);
  });

  it('keeps a displayed paused timer whose render clock stopped advancing', () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    const pausedId = timerIdFor('frozen-task', startedAtMs);
    syncMemberActivityTimer({
      timerId: pausedId,
      startedAtMs,
      running: true,
      runId: 'run-1',
      nowMs: startedAtMs,
    });
    syncMemberActivityTimer({
      timerId: pausedId,
      startedAtMs,
      baseElapsedMs: 0,
      running: false,
      runId: 'run-1',
      nowMs: startedAtMs + 90_000,
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 60; index += 1) {
      const rotationMs = startedAtMs + 100_000 + index * 1_000;
      vi.setSystemTime(rotationMs);
      syncTaskTimer(`rotation-${index}`, rotationMs, rotationMs);
      // A paused card keeps re-rendering with the clock it last captured.
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: startedAtMs + 90_000,
      });
    }

    expect(storedTimerIds()).toContain(pausedId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: startedAtMs + 90_000,
      })
    ).toBe(90_000);
  });

  it('keeps a paused card whose stored record was left running', () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    vi.setSystemTime(startedAtMs);
    // An interrupted pause sync leaves the persisted record claiming it is still running,
    // so only the reader knows that this timer is paused.
    const stuckId = timerIdFor('stuck-task', startedAtMs);
    syncMemberActivityTimer({
      timerId: stuckId,
      startedAtMs,
      running: true,
      runId: 'run-1',
      nowMs: startedAtMs,
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 60; index += 1) {
      const rotationMs = startedAtMs + 100_000 + index * 1_000;
      vi.setSystemTime(rotationMs);
      syncTaskTimer(`rotation-${index}`, rotationMs, rotationMs);
      readMemberActivityTimerElapsed({
        timerId: stuckId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: rotationMs,
      });
    }

    expect(storedTimerIds()).toContain(stuckId);
  });

  it('keeps the timer on screen when stored keys are stamped ahead of the render clock', () => {
    vi.useFakeTimers();
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    vi.setSystemTime(nowMs);

    // A producer clock ran ahead of this renderer, so every key left by earlier sessions is
    // stamped in the future. No age comparison can rank such a key below a timer that is
    // on screen, and any order that tries will evict the one thing the user is looking at.
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const aheadMs = nowMs + 3_600_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`ahead-${index}`, aheadMs), aheadMs);
    }

    const onScreenStartedAtMs = nowMs - 90_000;
    const onScreenId = timerIdFor('on-screen', onScreenStartedAtMs);
    syncMemberActivityTimer({
      timerId: onScreenId,
      startedAtMs: onScreenStartedAtMs,
      running: true,
      runId: 'run-1',
      nowMs: onScreenStartedAtMs,
    });
    syncMemberActivityTimer({
      timerId: onScreenId,
      startedAtMs: onScreenStartedAtMs,
      running: false,
      runId: 'run-1',
      nowMs,
    });

    for (let index = 0; index < 80; index += 1) {
      readMemberActivityTimerElapsed({
        timerId: onScreenId,
        startedAtMs: onScreenStartedAtMs,
        running: false,
        runId: 'run-1',
        nowMs,
      });
      const rotationMs = nowMs + index * 1_000;
      syncTaskTimer(`rotation-${index}`, rotationMs, rotationMs);
    }

    expect(storedTimerIds()).toContain(onScreenId);
    expect(storedTimerIds()).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(
      readMemberActivityTimerElapsed({
        timerId: onScreenId,
        startedAtMs: onScreenStartedAtMs,
        running: false,
        runId: 'run-1',
        nowMs,
      })
    ).toBe(90_000);
  });

  it('drops the least recently touched timer, not the one with the oldest anchor', () => {
    const recentMs = Date.parse('2026-05-07T09:00:00.000Z');
    const oldMs = Date.parse('2026-04-01T09:00:00.000Z');
    const viewedId = timerIdFor('old-but-viewed', oldMs);
    const abandonedId = timerIdFor('new-but-abandoned', recentMs);

    syncMemberActivityTimer({
      timerId: abandonedId,
      startedAtMs: recentMs,
      running: true,
      runId: 'run-1',
      nowMs: recentMs,
    });
    syncMemberActivityTimer({
      timerId: viewedId,
      startedAtMs: oldMs,
      running: true,
      runId: 'run-1',
      nowMs: recentMs,
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const fillerMs = recentMs + 1_000 + index * 1_000;
      syncTaskTimer(`filler-${index}`, fillerMs, fillerMs);
      readMemberActivityTimerElapsed({
        timerId: viewedId,
        startedAtMs: oldMs,
        running: false,
        runId: 'run-1',
        nowMs: fillerMs,
      });
    }

    expect(storedTimerIds()).toContain(viewedId);
    expect(storedTimerIds()).not.toContain(abandonedId);
  });

  it('ranks stored keys from the id alone and never reads their values', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const staleId = timerIdFor('stale-anchor', nowMs - 86_400_000);
    // The payload claims a future update; the anchor inside the id is a day old. Ranking by the
    // payload would need one read per key and would keep a record nothing on screen uses.
    seedStoredTimer(staleId, nowMs - 86_400_000, {
      elapsedMs: 500_000,
      updatedAtMs: nowMs + 1_000_000,
    });

    const storage = globalThis.localStorage;
    const readStorageKey = storage?.getItem.bind(storage);
    const reads: string[] = [];
    vi.spyOn(storage, 'getItem').mockImplementation((key: string) => {
      reads.push(key);
      return readStorageKey ? readStorageKey(key) : null;
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 5; index += 1) {
      const drainMs = nowMs + index * 1_000;
      syncTaskTimer(`drain-${index}`, drainMs, drainMs);
    }

    expect(reads).not.toContain(`${STORAGE_PREFIX}${staleId}`);
    expect(storedTimerIds()).not.toContain(staleId);
  });

  it('keeps stored keys whose value it cannot read', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    // The readable-budget case: these keys are the newest in storage, so an age-based reclaim keeps
    // them. Ranking them from their payload instead would see a throw where a record lives.
    const unreadableIds = Array.from(
      { length: MAX_TRACKED_ACTIVITY_TIMERS - 2 },
      (_unused, index) => {
        const atMs = nowMs - index * 1_000;
        const id = timerIdFor(`unreadable-${index}`, atMs);
        seedStoredTimer(id, atMs);
        return id;
      }
    );
    for (let index = 0; index < 8; index += 1) {
      const oldMs = nowMs - 100_000_000 - index * 1_000;
      seedStoredTimer(timerIdFor(`ancient-${index}`, oldMs), oldMs);
    }

    const storage = globalThis.localStorage;
    vi.spyOn(storage, 'getItem').mockImplementation((key: string) => {
      if (key.startsWith(STORAGE_PREFIX)) throw new Error('SecurityError: storage read blocked');
      return null;
    });

    syncTaskTimer('current-task', nowMs, nowMs);

    const remaining = storedTimerIds();
    expect(remaining).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS);
    unreadableIds.forEach((unreadableId) => expect(remaining).toContain(unreadableId));
  });

  it('leaves payloads and keys it does not understand untouched', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const storage = globalThis.localStorage;
    const foreignKey = `${STORAGE_PREFIX}opaque-key-without-an-anchor`;
    const futureVersionId = timerIdFor('future-version', nowMs - 1_000);
    const futureVersionKey = `${STORAGE_PREFIX}${futureVersionId}`;
    const futureVersionPayload = JSON.stringify({
      version: 2,
      startedAtMs: nowMs - 1_000,
      elapsedMs: 500_000,
      updatedAtMs: nowMs - 1_000,
      running: true,
    });
    storage?.setItem(futureVersionKey, futureVersionPayload);
    storage?.setItem(foreignKey, 'not-json');
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS - 2; index += 1) {
      const oldMs = nowMs - 100_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`oldest-${index}`, oldMs), oldMs);
    }

    syncTaskTimer('replacement-task', nowMs, nowMs);

    expect(storage?.getItem(futureVersionKey)).toBe(futureVersionPayload);
    expect(storage?.getItem(foreignKey)).toBe('not-json');
  });

  it('does not reclaim the key it is about to restore', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const oldestId = timerIdFor('oldest', nowMs - 500_000);
    const restoringId = timerIdFor('restoring', nowMs - 400_000);
    seedStoredTimer(oldestId, nowMs - 500_000);
    seedStoredTimer(restoringId, nowMs - 400_000, { elapsedMs: 45_000 });
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS - 2; index += 1) {
      const newerMs = nowMs + index * 1_000;
      seedStoredTimer(timerIdFor(`newer-${index}`, newerMs), newerMs);
    }

    // The listing happens for the oldest key, so `restoringId` is already queued for reclamation
    // by the time a render asks for it.
    syncTaskTimer('oldest', nowMs - 500_000, nowMs);
    expect(
      readMemberActivityTimerElapsed({
        timerId: restoringId,
        startedAtMs: nowMs - 400_000,
        running: false,
        runId: 'run-1',
        nowMs,
      })
    ).toBe(45_000);
    expect(globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${restoringId}`)).toContain('45000');
  });

  it('frees room before writing so a capacity-limited store keeps the new anchor', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      seedStoredTimer(timerIdFor(`full-${index}`, nowMs - (index + 1) * 1_000), nowMs);
    }

    const storage = globalThis.localStorage;
    const writeStorageKey = storage?.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key: string, value: string) => {
      if (storage && storage.length >= MAX_TRACKED_ACTIVITY_TIMERS) {
        throw new Error('QuotaExceededError: storage is full');
      }
      writeStorageKey?.(key, value);
    });

    const liveId = timerIdFor('live-task', nowMs);
    syncMemberActivityTimer({
      timerId: liveId,
      startedAtMs: nowMs,
      running: true,
      runId: 'run-1',
      nowMs,
    });

    expect(storedTimerIds()).toContain(liveId);
    expect(storedTimerIds()).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS);
  });
});

function seedStoredTimer(
  timerId: string,
  startedAtMs: number,
  overrides: Record<string, unknown> = {}
): void {
  globalThis.localStorage?.setItem(
    `${STORAGE_PREFIX}${timerId}`,
    JSON.stringify({
      version: 1,
      startedAtMs,
      baseElapsedMs: 0,
      elapsedMs: 1_000,
      updatedAtMs: startedAtMs,
      running: false,
      runId: null,
      ...overrides,
    })
  );
}
