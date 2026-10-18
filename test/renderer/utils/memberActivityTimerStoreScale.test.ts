import { afterEach, describe, expect, it } from 'vitest';

import {
  createMemberActivityTimerId,
  MAX_TRACKED_ACTIVITY_TIMERS,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
  syncMemberActivityTimer,
} from '@renderer/utils/memberActivityTimer';

const PREFIX = 'member-activity-timer:';
const FOREIGN_PREFIX = 'another-feature-cache:';
const MEMBERS = ['ana', 'bo', 'cy', 'dev', 'eli', 'fay', 'gus', 'hal'];
const CYCLES = 300;
const LEGACY_KEYS = 2400;
const FOREIGN_KEYS = 1600;

function ownKeyStats(): { keys: number; chars: number } {
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

function foreignKeyCount(): number {
  const storage = globalThis.localStorage;
  let keys = 0;
  if (!storage) return keys;
  for (let index = 0; index < storage.length; index += 1) {
    if (storage.key(index)?.startsWith(FOREIGN_PREFIX)) keys += 1;
  }
  return keys;
}

// A namespace as an unbounded build leaves it: records older than this session's first render, and
// the origin itself much larger than this module's own keys, so one full enumeration costs what a
// full enumeration costs in a real renderer.
function seedLegacyKeys(count: number, baseMs: number): void {
  for (let index = 0; index < count; index += 1) {
    // Newer than the two anchors on screen: an age-ranked reclaim reaches the *displayed* timers last
    // only if it never reaches them at all, which is what this harness is for.
    const startedAtMs = baseMs + (index + 1) * 60_000;
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

function seedForeignKeys(count: number): void {
  for (let index = 0; index < count; index += 1) {
    globalThis.localStorage?.setItem(`${FOREIGN_PREFIX}entry-${index}`, `${index}`);
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

function readElapsed(
  anchor: { timerId: string; startedAtMs: number },
  running: boolean,
  nowMs: number
) {
  return readMemberActivityTimerElapsed({
    timerId: anchor.timerId,
    startedAtMs: anchor.startedAtMs,
    baseElapsedMs: 0,
    running,
    runId: running ? 'run-1' : null,
    nowMs,
  });
}

function churnWorkload(): {
  keys: number;
  chars: number;
  foreign: number;
  runningElapsed: number;
  pausedElapsed: number;
  firstTouchMs: number;
  loopMs: number;
} {
  resetMemberActivityTimerStoreForTests();
  globalThis.localStorage?.clear();
  const baseMs = Date.parse('2026-05-07T09:00:00.000Z');
  const seedStart = performance.now();
  seedLegacyKeys(LEGACY_KEYS, baseMs);
  seedForeignKeys(FOREIGN_KEYS);
  const seedMs = performance.now() - seedStart;

  // The two cards that stay on screen. Their records were written by an earlier session and are read
  // in the render pass — before any effect writes — exactly as `CurrentTaskIndicator` does.
  const running = anchorFor(0, 'ana', 'work', baseMs);
  const paused = anchorFor(0, 'bo', 'work', baseMs);
  globalThis.localStorage?.setItem(
    `${PREFIX}${running.timerId}`,
    JSON.stringify({
      version: 1,
      startedAtMs: running.startedAtMs,
      baseElapsedMs: 0,
      elapsedMs: 0,
      updatedAtMs: running.startedAtMs,
      running: true,
      runId: 'run-1',
    })
  );
  globalThis.localStorage?.setItem(
    `${PREFIX}${paused.timerId}`,
    JSON.stringify({
      version: 1,
      startedAtMs: paused.startedAtMs,
      baseElapsedMs: 0,
      elapsedMs: 45_000,
      updatedAtMs: paused.startedAtMs + 45_000,
      running: false,
      runId: null,
    })
  );

  const firstTouchStart = performance.now();
  // Render phase, in tree order: every displayed timer reads before the first effect write runs, so
  // no reclaim can be reached by a card whose own read has not happened yet.
  readElapsed(running, true, running.startedAtMs);
  readElapsed(paused, false, paused.startedAtMs + 45_000);
  // Commit phase: the first effect writes of the session, for a third member.
  const other = anchorFor(0, 'cy', 'work', baseMs);
  syncMemberActivityTimer({
    timerId: other.timerId,
    startedAtMs: other.startedAtMs,
    running: true,
    runId: 'run-1',
    nowMs: other.startedAtMs + 1_000,
  });
  const firstTouchMs = performance.now() - firstTouchStart;

  const finalNowMs = baseMs + ((CYCLES - 1) * 16 + 15) * 1000 + 1000;
  const loopStart = performance.now();
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
        readElapsed(anchor, true, nowMs);
        readElapsed(running, true, nowMs);
        readElapsed(paused, false, nowMs);
      }
    }
  }
  const loopMs = performance.now() - loopStart;
  const { keys, chars } = ownKeyStats();
  const foreign = foreignKeyCount();
  const runningElapsed = readElapsed(running, true, finalNowMs);
  const pausedElapsed = readElapsed(paused, false, finalNowMs);
  console.log(
    `SCALE legacy=${LEGACY_KEYS} foreign=${FOREIGN_KEYS} keys=${keys} chars=${chars} ` +
      `seedMs=${seedMs.toFixed(0)} firstTouchMs=${firstTouchMs.toFixed(0)} loopMs=${loopMs.toFixed(0)}`
  );
  return { keys, chars, foreign, runningElapsed, pausedElapsed, firstTouchMs, loopMs };
}

describe('memberActivityTimer store scale', () => {
  afterEach(() => {
    resetMemberActivityTimerStoreForTests();
    globalThis.localStorage?.clear();
  });

  // Four thousand origin keys are walked more than once here, and happy-dom's `Storage.key(i)` is
  // itself linear in the store size — the walk, not the reclaim, is what the budget pays for.
  it('holds the cap and the on-screen elapsed over 4 800 anchors, on a legacy namespace', () => {
    const outcome = churnWorkload();
    // Exactly the cap: the backlog is gone and the resident set is full, so the harness would also
    // fail if the reclaim silently stopped doing anything at all.
    expect(outcome.keys).toBe(MAX_TRACKED_ACTIVITY_TIMERS);
    expect(outcome.foreign).toBe(FOREIGN_KEYS);
    expect(outcome.runningElapsed).toBe(4_800_000);
    expect(outcome.pausedElapsed).toBe(45_000);
  }, 180_000);
});
