import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberActivityTimerId,
  declareActivityTimerKeys,
  deriveReviewActivityTimerAnchor,
  deriveWorkActivityTimerAnchor,
  MAX_TRACKED_ACTIVITY_TIMERS,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';

import type { TeamTaskWithKanban } from '@shared/types';

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

    const afterFirstWrite = storedTimerIds();
    // The backlog converges over writes rather than inside the frame that first touches it: one
    // write takes an eighth of the excess, so a namespace left by an unbounded build is swept
    // without any single render paying for the whole delete burst.
    expect(afterFirstWrite).toContain(activeId);
    expect(afterFirstWrite.length).toBeLessThan(staleCount + 1);
    expect(afterFirstWrite.length).toBeGreaterThan(MAX_TRACKED_ACTIVITY_TIMERS);

    // Two rounds of the cap: the resident set absorbs the first of them, the backlog is gone by
    // the last. Convergence is measured in writes, not in one synchronous burst.
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS * 2; index += 1) {
      const startedAtMs = Date.parse('2026-06-01T09:00:00.000Z') + index * 1_000;
      syncTaskTimer(`rotating-${index}`, startedAtMs, startedAtMs);
    }

    const remaining = storedTimerIds();
    expect(remaining.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(remaining).not.toContain(brokenId);
  });

  it('reclaims nothing while a read runs', () => {
    const staleMs = Date.parse('2026-04-01T09:00:00.000Z');
    const staleIds: string[] = [];
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const startedAtMs = staleMs + index * 1_000;
      const staleId = timerIdFor(`old-task-${index}`, startedAtMs);
      seedStoredTimer(staleId, startedAtMs, { elapsedMs: 45_000 });
      staleIds.push(staleId);
    }
    const before = storedTimerIds();

    // Reads are what the render phase does, in tree order: card #1's read must not be allowed to
    // take the record card #2 is about to read. Reclamation belongs to the write path, which React
    // runs after every render in the commit.
    for (const staleId of staleIds.slice(0, 20)) {
      readMemberActivityTimerElapsed({
        timerId: staleId,
        startedAtMs: staleIds.indexOf(staleId) * 1_000 + staleMs,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs: staleMs,
      });
    }

    expect(storedTimerIds()).toEqual(before);
  });

  it('keeps a displayed timer through another member first write', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const pausedId = timerIdFor('paused-task', nowMs - 4 * 3_600_000);
    // The oldest anchor in the namespace is systematically a long-running live timer, which is why
    // age-ranked reclamation may not run before the screen has read it.
    seedStoredTimer(pausedId, nowMs - 4 * 3_600_000, { elapsedMs: 45_000 });
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const startedAtMs = nowMs + index * 1_000;
      seedStoredTimer(timerIdFor(`legacy-${index}`, startedAtMs), startedAtMs);
    }

    readMemberActivityTimerElapsed({
      timerId: pausedId,
      startedAtMs: nowMs - 4 * 3_600_000,
      baseElapsedMs: 0,
      running: false,
      runId: null,
      nowMs,
    });
    syncTaskTimer('other-member', nowMs, nowMs);

    expect(storedTimerIds()).toContain(pausedId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs: nowMs - 4 * 3_600_000,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs,
      })
    ).toBe(45_000);
  });

  it('skips a resident that was hydrated after the backlog was listed', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const staleMs = nowMs - 86_400_000;
    const staleIds: string[] = [];
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const startedAtMs = staleMs + index * 1_000;
      const staleId = timerIdFor(`old-task-${index}`, startedAtMs);
      seedStoredTimer(staleId, startedAtMs);
      staleIds.push(staleId);
    }

    // The first write lists the backlog and takes its share of it, so one of those keys is now the
    // front of the age-ranked queue while still on disk. Reading it makes it a resident *after* the
    // snapshot was taken — the only way a key can be in both structures at once.
    syncTaskTimer('first-write', nowMs, nowMs);
    const hydratedId = staleIds[6];
    const hydratedMs = staleMs + 6 * 1_000;
    readMemberActivityTimerElapsed({
      timerId: hydratedId,
      startedAtMs: hydratedMs,
      baseElapsedMs: 0,
      running: false,
      runId: null,
      nowMs,
    });

    syncTaskTimer('second-write', nowMs + 1_000, nowMs + 1_000);

    // The reclaim walks the queue from the oldest end, and this key is at the front of it. Its
    // elapsed would still read `1_000` from the Map even if the reclaim deleted the record, so the
    // cache is exactly what hides that harm: a session reload would be the first time the label
    // moved. The key being on disk is the assertion that matters.
    expect(storedTimerIds()).toContain(hydratedId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: hydratedId,
        startedAtMs: hydratedMs,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs,
      })
    ).toBe(1_000);
  });

  it('lists the backlog once per session, not on every write', () => {
    const storage = globalThis.localStorage;
    const walkStorageKey = storage?.key.bind(storage);
    const keyCalls: number[] = [];
    vi.spyOn(storage, 'key').mockImplementation((index: number) => {
      keyCalls.push(index);
      return walkStorageKey?.(index) ?? null;
    });

    const baseMs = Date.parse('2026-05-07T09:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      const startedAtMs = baseMs + index * 1_000;
      syncTaskTimer(`listed-${index}`, startedAtMs, startedAtMs);
    }
    const listedOnce = keyCalls.length;
    expect(listedOnce).toBeGreaterThan(0);

    for (let index = 5; index < 10; index += 1) {
      const startedAtMs = baseMs + index * 1_000;
      syncTaskTimer(`listed-${index}`, startedAtMs, startedAtMs);
    }

    // A rotating work interval costs a compare against the live snapshot, never a second walk of
    // every other key in the origin.
    expect(keyCalls.length).toBe(listedOnce);
  });

  it('stops reclaiming when the store refuses to delete', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const startedAtMs = nowMs - (index + 1) * 1_000;
      seedStoredTimer(timerIdFor(`stuck-${index}`, startedAtMs), startedAtMs);
    }
    const before = storedTimerIds();
    const storage = globalThis.localStorage;
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is read-only');
    });

    syncTaskTimer('current-task', nowMs, nowMs);

    // Nothing is reclaimed, so nothing is claimed: the write still lands, the backlog is untouched,
    // and the reaper does not burn the rest of the list on deletions that cannot happen.
    expect(storedTimerIds().filter((id) => !before.includes(id))).toEqual([
      timerIdFor('current-task', nowMs),
    ]);
    expect(storedTimerIds().length).toBe(before.length + 1);
  });

  it('deletes a paused banked record last when the resident set is full', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const pausedId = timerIdFor('paused-banked', nowMs - 3_600_000);
    seedStoredTimer(pausedId, nowMs - 3_600_000, { elapsedMs: 900_000 });
    // Read once, then never again: the card hydrates its record and stops re-rendering, and a paused
    // timer has no persistence tick that could touch it. `baseElapsedMs` comes from *completed* work
    // intervals, so this 15-minute stretch exists only in this record — eviction ranking may not rest
    // on how often the parent list re-renders, so the shape of the record decides.
    readMemberActivityTimerElapsed({
      timerId: pausedId,
      startedAtMs: nowMs - 3_600_000,
      baseElapsedMs: 0,
      running: false,
      runId: null,
      nowMs,
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 60; index += 1) {
      const startedAtMs = nowMs + index * 1_000;
      syncTaskTimer(`rot-${index}`, startedAtMs, startedAtMs);
    }

    const remaining = storedTimerIds();
    expect(remaining).toContain(pausedId);
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs: nowMs - 3_600_000,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs,
      })
    ).toBe(900_000);
    // The preference costs the bound nothing: the rotating anchors absorb the eviction, and the
    // namespace is still at the cap.
    expect(remaining.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it('retries a deletion the store refused instead of orphaning the key', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const storage = globalThis.localStorage;
    const removeOriginal = storage.removeItem.bind(storage);
    let refusing = true;
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (refusing) throw new Error('SecurityError: storage is read-only');
      removeOriginal(key);
    });

    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const startedAtMs = nowMs + index * 1_000;
      syncTaskTimer(`resident-${index}`, startedAtMs, startedAtMs);
    }
    const victimId = timerIdFor('resident-0', nowMs);

    // One write past the cap evicts the least recently touched resident while the store is refusing
    // deletions. The Map slot is still freed — the memory bound is the invariant — so without a retry
    // queue the key would belong to neither bookkeeping structure and nothing in this session could
    // ever reclaim it.
    syncTaskTimer('overflow', nowMs + MAX_TRACKED_ACTIVITY_TIMERS * 1_000, nowMs);
    expect(storedTimerIds()).toContain(victimId);

    refusing = false;
    const drainedId = timerIdFor(
      'after-refusal',
      nowMs + (MAX_TRACKED_ACTIVITY_TIMERS + 1) * 1_000
    );
    syncTaskTimer('after-refusal', nowMs + (MAX_TRACKED_ACTIVITY_TIMERS + 1) * 1_000, nowMs);

    const remaining = storedTimerIds();
    expect(remaining).not.toContain(victimId);
    expect(remaining).toContain(drainedId);
    expect(remaining.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it('puts a record restored by a read into the eviction queue like any other resident', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const restoredId = timerIdFor('restored', nowMs);
    seedStoredTimer(restoredId, nowMs, { running: true, elapsedMs: 10_000 });

    readMemberActivityTimerElapsed({
      timerId: restoredId,
      startedAtMs: nowMs,
      baseElapsedMs: 0,
      running: true,
      runId: 'run-1',
      nowMs,
    });

    for (let index = 1; index <= MAX_TRACKED_ACTIVITY_TIMERS + 10; index += 1) {
      const startedAtMs = nowMs + index * 1_000;
      syncTaskTimer(`rotating-${index}`, startedAtMs, startedAtMs);
    }

    // Hydration is a touch: a restored record that never re-enters the ranking would be invisible to
    // eviction, and the cap the store exists to enforce would silently stop applying to it.
    expect(storedTimerIds()).not.toContain(restoredId);
    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
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
    const ancientIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const oldMs = nowMs - 100_000_000 - index * 1_000;
      const id = timerIdFor(`ancient-${index}`, oldMs);
      seedStoredTimer(id, oldMs);
      ancientIds.push(id);
    }

    const storage = globalThis.localStorage;
    const currentId = timerIdFor('current-task', nowMs);
    vi.spyOn(storage, 'getItem').mockImplementation((key: string) => {
      // Every seeded record is unreadable, but the incoming key is not — otherwise this write would
      // be gated by the unreachable-read guard below and the sweep would never run at all.
      if (key.startsWith(STORAGE_PREFIX) && key !== `${STORAGE_PREFIX}${currentId}`) {
        throw new Error('SecurityError: storage read blocked');
      }
      return null;
    });

    syncTaskTimer('current-task', nowMs, nowMs);

    const remaining = storedTimerIds();
    // 206 seeded + the new key, minus the one key the first write's share of the backlog takes.
    expect(remaining).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS + 6);
    expect(remaining).toContain(currentId);
    unreadableIds.forEach((unreadableId) => expect(remaining).toContain(unreadableId));
    // The value was never consulted: the victim is the oldest *anchor*, and it would have been the
    // same victim if that record had parsed cleanly.
    expect(remaining).not.toContain(ancientIds[ancientIds.length - 1]);
    expect(remaining.filter((id) => ancientIds.includes(id))).toHaveLength(ancientIds.length - 1);
  });

  it('does not write a baseline over a record it could not read', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const pausedId = timerIdFor('banked-pause', nowMs - 3_600_000);
    seedStoredTimer(pausedId, nowMs - 3_600_000, { elapsedMs: 45_000 });
    const payloadBefore = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${pausedId}`);

    const storage = globalThis.localStorage;
    const readOriginal = storage?.getItem.bind(storage);
    let blocked = true;
    vi.spyOn(storage, 'getItem').mockImplementation((key: string) => {
      if (blocked && key === `${STORAGE_PREFIX}${pausedId}`) {
        throw new Error('SecurityError: transient storage read failure');
      }
      return readOriginal ? readOriginal(key) : null;
    });

    // A throw is not an empty slot. The sync still renders this tick's baseline, but persisting it
    // would replace the banked 45 s that is (transiently) unreadable with a record that says zero,
    // and the elapsed would be gone for good even though nothing evicted it.
    expect(
      syncMemberActivityTimer({
        timerId: pausedId,
        startedAtMs: nowMs - 3_600_000,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs,
      })
    ).toBe(0);
    // Inspected through the unpatched storage, because the point is what is on disk while the read
    // is failing — and that read is still blocked at this instant.
    expect(readOriginal ? readOriginal(`${STORAGE_PREFIX}${pausedId}`) : null).toBe(payloadBefore);

    // The next tick reads it again: skipping the write is a retry, not a loss.
    blocked = false;
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs: nowMs - 3_600_000,
        baseElapsedMs: 0,
        running: false,
        runId: null,
        nowMs,
      })
    ).toBe(45_000);
  });

  it('keeps the run clock in the elapsed it returns when the record cannot be read', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const startedAtMs = nowMs - 30_000;
    const runningId = timerIdFor('running-unreadable', startedAtMs);
    seedStoredTimer(runningId, startedAtMs, { elapsedMs: 30_000 });
    const payloadBefore = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${runningId}`);

    const storage = globalThis.localStorage;
    const readOriginal = storage?.getItem.bind(storage);
    vi.spyOn(storage, 'getItem').mockImplementation((key: string) => {
      if (key === `${STORAGE_PREFIX}${runningId}`) {
        throw new Error('SecurityError: transient storage read failure');
      }
      return readOriginal ? readOriginal(key) : null;
    });

    // Skipping the write must not skip the clock. The record is transiently unreachable, but the
    // caller just said this run is live and when it started, so the elapsed for this tick is that
    // gap; returning the baseline instead would flash 0s on the card and jump back on the next tick.
    expect(
      syncMemberActivityTimer({
        timerId: runningId,
        startedAtMs,
        baseElapsedMs: 0,
        running: true,
        runId: 'run-1',
        nowMs,
      })
    ).toBe(30_000);
    expect(readOriginal ? readOriginal(`${STORAGE_PREFIX}${runningId}`) : null).toBe(payloadBefore);
  });

  it('leaves keys another feature stored untouched', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const storage = globalThis.localStorage;
    // A parseable date alone does not establish ownership. Even timestamp-shaped foreign keys
    // must stay untouched unless their full structure matches the timer producer. Dates below
    // predate the backlog so any wrongly admitted key would be reclaimed first.
    const foreignIds = [
      'opaque-key-without-an-anchor',
      'legacy-cache-19',
      'session-2026',
      'cache-index-7',
      'plainword',
      'v2:abc',
      '2025-01-01',
      '2025-01-01T00:00:00Z',
      'alpha' + '\u0000' + 'bob' + '\u0000' + 'work' + '\u0000' + 'task-9',
      ['alpha', 'bob', 'work', '2025-01-01T00:00:00Z'].join('\u0000'),
      ['alpha', 'bob', 'cache', 'task-9', '2025-01-01T00:00:00Z'].join('\u0000'),
      ['alpha', ' Bob ', 'work', 'task-9', '2025-01-01T00:00:00Z'].join('\u0000'),
      ['alpha', 'bob', 'work', 'task-9', 'not-a-date'].join('\u0000'),
      ['alpha', 'bob', 'work', 'task-9', '2025-01-01T00:00:00Z', 'extra'].join('\u0000'),
    ];
    foreignIds.forEach((foreignId, index) => {
      storage?.setItem(`${STORAGE_PREFIX}${foreignId}`, `not-this-modules-data-${index}`);
    });

    // A record from a newer build, stamped with the oldest anchor in the namespace: the ranker reads
    // the id, not the value, so this key is reclaimed on the same age terms as its neighbours. It is
    // not destroyed *for being* version 2 — an identical v1 record at this anchor would share its
    // fate — and that is the whole guarantee the retention rule makes.
    const futureVersionId = timerIdFor('future-version', nowMs - 200_000_000);
    const futureVersionKey = `${STORAGE_PREFIX}${futureVersionId}`;
    storage?.setItem(
      futureVersionKey,
      JSON.stringify({
        version: 2,
        startedAtMs: nowMs - 200_000_000,
        elapsedMs: 500_000,
        updatedAtMs: nowMs - 200_000_000,
        running: true,
      })
    );
    const futureVersionPayload = storage?.getItem(futureVersionKey);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS - 1; index += 1) {
      const oldMs = nowMs - 100_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`oldest-${index}`, oldMs), oldMs);
    }

    const writtenId = syncTaskTimer('replacement-task', nowMs, nowMs);

    foreignIds.forEach((foreignId, index) => {
      expect(storage?.getItem(`${STORAGE_PREFIX}${foreignId}`)).toBe(
        `not-this-modules-data-${index}`
      );
    });
    expect(storedTimerIds()).toContain(writtenId);
    expect(futureVersionPayload).toContain('"version":2');
    expect(storage?.getItem(futureVersionKey)).toBeNull();
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

  it('protects a declared paused member before historical banked resident timers', () => {
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const liveId = timerIdFor('banked-0', startedAtMs);
    declareActivityTimerKeys({}, [liveId]);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const atMs = startedAtMs + index * 1_000;
      const timerId = syncTaskTimer(`banked-${index}`, atMs, atMs + 90_000);
      syncMemberActivityTimer({
        timerId,
        startedAtMs: atMs,
        running: false,
        runId: 'run-1',
        nowMs: atMs + 90_000,
      });
    }

    // Every resident holds banked time. The current paused member was touched first, but the
    // producer still declares it; a historical paused member must absorb the destructive eviction.
    syncTaskTimer('next-running', startedAtMs + 1_000_000, startedAtMs + 1_000_000);
    expect(storedTimerIds()).toContain(liveId);
    expect(storedTimerIds()).not.toContain(timerIdFor('banked-1', startedAtMs + 1_000));
    expect(storedTimerIds()).toHaveLength(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(
      readMemberActivityTimerElapsed({
        timerId: liveId,
        startedAtMs,
        running: false,
        runId: 'run-1',
        nowMs: startedAtMs + 2_000_000,
      })
    ).toBe(90_000);
  });

  it('preserves declared disk state when every resident is live and reaps it after withdrawal', () => {
    const owner = {};
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const anchors = Array.from({ length: MAX_TRACKED_ACTIVITY_TIMERS + 1 }, (_, index) => ({
      timerId: timerIdFor(`live-${index}`, startedAtMs + index * 1_000),
      startedAtMs: startedAtMs + index * 1_000,
    }));
    declareActivityTimerKeys(
      owner,
      anchors.map((anchor) => anchor.timerId)
    );
    for (const anchor of anchors) {
      seedStoredTimer(anchor.timerId, anchor.startedAtMs, { elapsedMs: 90_000 });
      syncMemberActivityTimer({ ...anchor, running: false, nowMs: startedAtMs + 1_000_000 });
    }
    const storage = globalThis.localStorage;
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS + 1);
    const readStorage = vi.spyOn(storage, 'getItem');
    const walkStorage = vi.spyOn(storage, 'key');

    // Reading the evicted first card must hit disk, proving that declaration did not unbound the
    // resident Map. Repeated round trips also exercise deduplication of retained dormant ids.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const anchor of anchors) {
        expect(
          readMemberActivityTimerElapsed({
            ...anchor,
            running: false,
            nowMs: startedAtMs + 1_000_000,
          })
        ).toBe(90_000);
      }
    }
    expect(readStorage).toHaveBeenCalledWith(`${STORAGE_PREFIX}${anchors[0].timerId}`);
    const last = anchors[anchors.length - 1];
    syncMemberActivityTimer({ ...last, running: false, nowMs: startedAtMs + 1_000_000 });
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS + 1);
    expect(walkStorage).not.toHaveBeenCalled();

    declareActivityTimerKeys(owner, []);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      syncMemberActivityTimer({ ...last, running: false, nowMs: startedAtMs + 1_000_000 });
    }
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(storage.getItem(`${STORAGE_PREFIX}${anchors[0].timerId}`)).toBeNull();
    expect(walkStorage).not.toHaveBeenCalled();
  });

  it('defers a pending deletion while its evicted timer is declared again', () => {
    const owner = {};
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const storage = globalThis.localStorage;
    const removeOriginal = storage.removeItem.bind(storage);
    let refusing = true;
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (refusing) throw new Error('SecurityError: storage is read-only');
      removeOriginal(key);
    });
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const atMs = startedAtMs + index * 1_000;
      syncTaskTimer(`pending-${index}`, atMs, atMs + 90_000);
    }
    const victimId = timerIdFor('pending-0', startedAtMs);
    const victimKey = `${STORAGE_PREFIX}${victimId}`;
    const victimPayload = storage.getItem(victimKey);
    const latestMs = startedAtMs + 1_000_000;
    syncTaskTimer('pending-overflow', latestMs, latestMs);

    // The failed eviction queued a delete before this owner's next declaration. Recovery must not
    // execute that stale intent against an interval the producer now knows is current.
    declareActivityTimerKeys(owner, [victimId]);
    refusing = false;
    syncTaskTimer('pending-overflow', latestMs, latestMs + 5_000);
    expect(storage.getItem(victimKey)).toBe(victimPayload);
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS + 1);

    declareActivityTimerKeys(owner, []);
    syncTaskTimer('pending-overflow', latestMs, latestMs + 10_000);
    expect(storage.getItem(victimKey)).toBeNull();
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it('reclaims a written resident that leaves memory after the one-time backlog snapshot', () => {
    const startedAtMs = Date.parse('2026-05-07T09:00:00.000Z');
    const anchors = Array.from({ length: 600 }, (_, index) => ({
      timerId: timerIdFor(`mixed-${index}`, startedAtMs + index * 1_000),
      startedAtMs: startedAtMs + index * 1_000,
    }));
    for (const anchor of anchors) seedStoredTimer(anchor.timerId, anchor.startedAtMs);
    // Snapshot collection excludes key 0 because the first write has already made it resident.
    syncMemberActivityTimer({ ...anchors[0], running: false, nowMs: startedAtMs + 1_000_000 });
    for (const anchor of anchors.slice(300, 500)) {
      readMemberActivityTimerElapsed({ ...anchor, running: false, nowMs: startedAtMs + 1_000_000 });
    }
    const storage = globalThis.localStorage;
    const walkStorage = vi.spyOn(storage, 'key');
    const removeStorage = vi.spyOn(storage, 'removeItem');
    for (let index = 0; index < 2_000; index += 1) {
      syncMemberActivityTimer({ ...anchors[499], running: false, nowMs: startedAtMs + 1_000_000 });
    }

    // Read eviction must return key 0 to the oldest end of the drain, without another disk scan.
    expect(removeStorage.mock.calls[0]?.[0]).toBe(`${STORAGE_PREFIX}${anchors[0].timerId}`);
    expect(storage.getItem(`${STORAGE_PREFIX}${anchors[0].timerId}`)).toBeNull();
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(walkStorage).not.toHaveBeenCalled();
  });

  it('spares declared keys from the drain, before and after the backlog is listed', () => {
    const owner = {};
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    // Oldest of all, and declared before the backlog is ever listed, so it never enters that list.
    const earlyMs = nowMs - 120_000_000;
    const earlyId = timerIdFor('declared-early', earlyMs);
    seedStoredTimer(earlyId, earlyMs, { elapsedMs: 90_000 });
    // Younger than every backlog key, so the first burst does not reach it and it *is* in the list —
    // the only thing that can save it later is the skip taken at deletion time.
    const lateMs = nowMs - 89_000_000;
    const lateId = timerIdFor('declared-late', lateMs);
    seedStoredTimer(lateId, lateMs, { elapsedMs: 80_000 });
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const staleMs = nowMs - 90_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`backlog-${index}`, staleMs), staleMs);
    }
    const earlyKey = `${STORAGE_PREFIX}${earlyId}`;
    const lateKey = `${STORAGE_PREFIX}${lateId}`;
    const earlyPayload = globalThis.localStorage?.getItem(earlyKey);
    const latePayload = globalThis.localStorage?.getItem(lateKey);

    // The first write lists the backlog and reclaims from it in the same call. `earlyId` is declared
    // before that happens, so the burst walks past it. This is the member whose card is not on screen:
    // nothing has read its key, it holds the oldest anchor and a banked pause, and the producer's
    // effect is the only thing that knows it is live.
    declareActivityTimerKeys(owner, [earlyId]);
    syncTaskTimer('first-write', nowMs, nowMs);
    expect(globalThis.localStorage?.getItem(earlyKey)).toBe(earlyPayload);
    expect(globalThis.localStorage?.getItem(lateKey)).toBe(latePayload);

    // Now declared after the list was built. Enough writes follow to drain everything older than it,
    // which is what makes this an assertion about the deletion-time skip rather than about the
    // amortized budget: without the skip this key is the next victim in line.
    declareActivityTimerKeys(owner, [earlyId, lateId]);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const busyMs = nowMs + 10_000 + index * 1_000;
      syncTaskTimer(`while-declared-${index}`, busyMs, busyMs);
    }
    expect(storedTimerIds().filter((id) => id.includes('backlog-'))).toHaveLength(0);
    expect(globalThis.localStorage?.getItem(earlyKey)).toBe(earlyPayload);
    expect(globalThis.localStorage?.getItem(lateKey)).toBe(latePayload);

    // A declaration is replaced, not accumulated. A spared key stays in the backlog list rather than
    // being consumed by the scan, so the moment the producer stops declaring it the drain reaches it
    // again — the exemption lasts for the frame that granted it, not until the next session.
    declareActivityTimerKeys(owner, []);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const laterMs = nowMs + 500_000 + index * 1_000;
      syncTaskTimer(`after-replaced-${index}`, laterMs, laterMs);
    }

    expect(storedTimerIds()).not.toContain(lateId);
    expect(storedTimerIds()).not.toContain(earlyId);
    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it("keeps each list's declaration when two lists declare in the same frame", () => {
    const teamA = {};
    const teamB = {};
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const aMs = nowMs - 120_000_000;
    const aId = timerIdFor('team-a-live', aMs);
    const bMs = nowMs - 110_000_000;
    const bId = timerIdFor('team-b-live', bMs);
    seedStoredTimer(aId, aMs, { elapsedMs: 90_000 });
    seedStoredTimer(bId, bMs, { elapsedMs: 80_000 });
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const staleMs = nowMs - 100_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`backlog-${index}`, staleMs), staleMs);
    }
    const aKey = `${STORAGE_PREFIX}${aId}`;
    const bKey = `${STORAGE_PREFIX}${bId}`;
    const aPayload = globalThis.localStorage?.getItem(aKey);
    const bPayload = globalThis.localStorage?.getItem(bKey);

    // Two team lists can be mounted at once, each writing its own anchors. A declaration is
    // therefore per caller: if the second replaced the first's set instead of adding its own, one of
    // these two keys would be the oldest thing in the backlog and the first write would take it.
    declareActivityTimerKeys(teamA, [aId]);
    declareActivityTimerKeys(teamB, [bId]);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const busyMs = nowMs + 10_000 + index * 1_000;
      syncTaskTimer(`both-declared-${index}`, busyMs, busyMs);
    }

    expect(storedTimerIds().filter((id) => id.includes('backlog-'))).toHaveLength(0);
    expect(globalThis.localStorage?.getItem(aKey)).toBe(aPayload);
    expect(globalThis.localStorage?.getItem(bKey)).toBe(bPayload);

    // Withdrawing one owner must not withdraw the other with it.
    declareActivityTimerKeys(teamA, []);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const laterMs = nowMs + 900_000 + index * 1_000;
      syncTaskTimer(`after-a-withdrew-${index}`, laterMs, laterMs);
    }

    expect(storedTimerIds()).not.toContain(aId);
    expect(globalThis.localStorage?.getItem(bKey)).toBe(bPayload);
    // The bound holds up to the keys that are currently declared: team B's live anchor is the one
    // record above the cap, and it is there because a caller said it is about to write it. That is
    // the documented cost of the exemption, not a leak — withdraw the declaration and it goes.
    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS + 1);
    declareActivityTimerKeys(teamB, []);
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS; index += 1) {
      const finalMs = nowMs + 2_000_000 + index * 1_000;
      syncTaskTimer(`after-b-withdrew-${index}`, finalMs, finalMs);
    }
    expect(storedTimerIds()).not.toContain(bId);
    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it('deletes nothing while one render pass hydrates more anchors than the map holds', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const anchors: { timerId: string; startedAtMs: number }[] = [];
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const startedAtMs = nowMs - 2_000_000 + index * 1_000;
      const timerId = timerIdFor(`read-${index}`, startedAtMs);
      seedStoredTimer(timerId, startedAtMs);
      anchors.push({ timerId, startedAtMs });
    }
    const pausedId = timerIdFor('paused-card', nowMs - 3_600_000);
    seedStoredTimer(pausedId, nowMs - 3_600_000, { elapsedMs: 45_000 });
    const keysBefore = storedTimerIds().length;

    // A roster bigger than the resident bound, read in one pass. Freeing a Map slot is not consuming
    // the record: the frame that evicts it is the frame that would have displayed it, and a paused
    // member's banked elapsed lives nowhere else.
    for (const anchor of anchors) {
      readMemberActivityTimerElapsed({
        timerId: anchor.timerId,
        startedAtMs: anchor.startedAtMs,
        running: true,
        runId: 'run-1',
        nowMs,
      });
    }
    readMemberActivityTimerElapsed({
      timerId: pausedId,
      startedAtMs: nowMs - 3_600_000,
      running: false,
      runId: 'run-1',
      nowMs,
    });

    expect(storedTimerIds()).toHaveLength(keysBefore);
    expect(
      readMemberActivityTimerElapsed({
        timerId: pausedId,
        startedAtMs: nowMs - 3_600_000,
        running: false,
        runId: 'run-1',
        nowMs,
      })
    ).toBe(45_000);
  });

  it.each([
    '2026-01-01T00:00Z',
    '2026-01-01T00:00+02:00',
    '2026-01-01T00:00:00.123456Z',
    '2026-01-01T00:00:00+0200',
    '2026-01-01',
    '2026-01-01T00:00:00',
    'Thu, 01 Jan 2026 00:00:00 GMT',
  ])('reclaims restarted producer timers whose anchor is %s', (startedAt) => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const task: TeamTaskWithKanban = {
      id: 'producer-task',
      displayId: 'producer',
      subject: 'Producer timestamp retention',
      status: 'in_progress',
      createdAt: startedAt,
      reviewState: 'none',
      workIntervals: [{ startedAt }],
      reviewIntervals: [{ reviewer: 'bob', startedAt }],
    };
    const params = { teamName: 'alpha', memberName: ' Bob ' };
    const anchors = [
      deriveWorkActivityTimerAnchor(task, params),
      deriveReviewActivityTimerAnchor(task, params),
    ];
    for (const anchor of anchors) {
      expect(anchor).not.toBeNull();
      if (!anchor) throw new Error('Expected a producer anchor');
      expect(anchor.startedAt).toBe(startedAt);
      syncMemberActivityTimer({ ...anchor, running: false, nowMs });
      expect(storedTimerIds()).toContain(anchor.timerId);
    }
    // Restart discards the resident map. The exact normally written keys must enter the backlog.
    resetMemberActivityTimerStoreForTests();
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 20; index += 1) {
      const staleMs = nowMs - 4_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`backlog-${index}`, staleMs), staleMs);
    }

    for (let index = 0; index < 60; index += 1) {
      const laterMs = nowMs + index * 1_000;
      syncTaskTimer(`rotate-${index}`, laterMs, laterMs);
    }

    // Stop adding keys so the amortized drain can converge instead of chasing new insertions.
    const steadyMs = nowMs + 59_000;
    for (let index = 0; index < 32; index += 1) {
      syncTaskTimer('rotate-59', steadyMs, steadyMs + index * 1_000);
    }

    const remaining = storedTimerIds();
    for (const anchor of anchors) expect(remaining).not.toContain(anchor?.timerId);
    expect(remaining.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
  });

  it.each(['length', 'key'] as const)(
    'retries the backlog snapshot after storage %s enumeration recovers',
    (failingOperation) => {
      const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
      const storage = globalThis.localStorage;
      for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS * 2; index += 1) {
        const atMs = nowMs - 1_000_000 + index * 1_000;
        seedStoredTimer(timerIdFor(`enumeration-${index}`, atMs), atMs, { elapsedMs: 45_000 });
      }
      const readKey = storage.key.bind(storage);
      const enumeration =
        failingOperation === 'length'
          ? vi.spyOn(storage, 'length', 'get').mockImplementation(() => {
              throw new Error('SecurityError: transient enumeration failure');
            })
          : vi.spyOn(storage, 'key').mockImplementation((index: number) => {
              if (index > 0) throw new Error('SecurityError: partial enumeration failure');
              return readKey(index);
            });
      const removeStorage = vi.spyOn(storage, 'removeItem');
      syncTaskTimer('enumeration-current', nowMs, nowMs);
      expect(removeStorage).not.toHaveBeenCalled();
      const enumerationCalls = enumeration.mock.calls.length;

      // A read while the namespace cannot be listed still returns its stored elapsed and neither
      // retries enumeration nor deletes another card's state during render.
      const firstMs = nowMs - 1_000_000;
      expect(
        readMemberActivityTimerElapsed({
          timerId: timerIdFor('enumeration-0', firstMs),
          startedAtMs: firstMs,
          running: false,
          nowMs,
        })
      ).toBe(45_000);
      expect(enumeration.mock.calls).toHaveLength(enumerationCalls);
      expect(removeStorage).not.toHaveBeenCalled();

      enumeration.mockRestore();
      const walkStorage = vi.spyOn(storage, 'key');
      syncTaskTimer('enumeration-current', nowMs, nowMs);
      const recoveredScanCalls = walkStorage.mock.calls.length;
      expect(recoveredScanCalls).toBeGreaterThan(0);
      for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS * 2; index += 1) {
        syncTaskTimer('enumeration-current', nowMs, nowMs);
      }
      expect(storage.length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
      expect(storage.getItem(`${STORAGE_PREFIX}${timerIdFor('enumeration-0', firstMs)}`)).toContain(
        '45000'
      );
      expect(walkStorage.mock.calls).toHaveLength(recoveredScanCalls);
    }
  );

  it('keeps overflowed failed evictions reachable after the pending deletion batch fills', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    const storage = globalThis.localStorage;
    const removeOriginal = storage.removeItem.bind(storage);
    let refusing = true;
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (refusing) throw new Error('SecurityError: transient deletion failure');
      removeOriginal(key);
    });
    const total = MAX_TRACKED_ACTIVITY_TIMERS * 2 + 40;
    for (let index = 0; index < total; index += 1) {
      const atMs = nowMs + index * 1_000;
      syncTaskTimer(`refused-eviction-${index}`, atMs, atMs);
    }
    // Writes succeed independently of deletes: more than one retry batch has left memory while
    // every disk record remains. The oldest overflowed id was never in the initial snapshot.
    expect(storage.length).toBe(total);
    const overflowMs = nowMs + MAX_TRACKED_ACTIVITY_TIMERS * 1_000;
    const overflowId = timerIdFor(`refused-eviction-${MAX_TRACKED_ACTIVITY_TIMERS}`, overflowMs);
    expect(storage.getItem(`${STORAGE_PREFIX}${overflowId}`)).not.toBeNull();
    const walkStorage = vi.spyOn(storage, 'key');
    refusing = false;
    const latestMs = nowMs + (total - 1) * 1_000;
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS * 2; index += 1) {
      syncTaskTimer(`refused-eviction-${total - 1}`, latestMs, latestMs);
    }

    expect(storage.getItem(`${STORAGE_PREFIX}${overflowId}`)).toBeNull();
    expect(storage.length).toBe(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(walkStorage).not.toHaveBeenCalled();
  });

  it('keeps a refused backlog key in the list so the bound holds once storage recovers', () => {
    const nowMs = Date.parse('2026-05-07T09:00:00.000Z');
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 40; index += 1) {
      const staleMs = nowMs - 5_000_000 + index * 1_000;
      seedStoredTimer(timerIdFor(`backlog-${index}`, staleMs), staleMs);
    }

    const storage = globalThis.localStorage;
    const removeOriginal = storage?.removeItem.bind(storage);
    let refusing = true;
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (refusing && key.startsWith(STORAGE_PREFIX)) {
        throw new Error('QuotaExceededError: the origin refuses deletions');
      }
      return removeOriginal ? removeOriginal(key) : undefined;
    });

    // Every write meets a refusal, so every write would otherwise drop one key from the only
    // structure that ever listed it.
    for (let index = 0; index < 60; index += 1) {
      const busyMs = nowMs + index * 1_000;
      syncTaskTimer(`while-refusing-${index}`, busyMs, busyMs);
    }
    refusing = false;
    for (let index = 0; index < MAX_TRACKED_ACTIVITY_TIMERS + 60; index += 1) {
      const laterMs = nowMs + 100_000 + index * 1_000;
      syncTaskTimer(`after-recovery-${index}`, laterMs, laterMs);
    }

    expect(storedTimerIds().length).toBeLessThanOrEqual(MAX_TRACKED_ACTIVITY_TIMERS);
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
