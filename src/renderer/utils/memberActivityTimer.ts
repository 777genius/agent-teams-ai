import { isTeamTaskActivelyWorked } from '@shared/utils/teamTaskState';

import type { TeamTaskWithKanban } from '@shared/types';

export type MemberActivityPhase = 'work' | 'review';

export interface MemberActivityTimerAnchor {
  timerId: string;
  startedAt: string;
  startedAtMs: number;
  baseElapsedMs: number;
  runId?: string | null;
}

interface StoredActivityTimer {
  version: 1;
  startedAtMs: number;
  baseElapsedMs: number;
  elapsedMs: number;
  updatedAtMs: number;
  running: boolean;
  runId?: string | null;
}

const STORAGE_PREFIX = 'member-activity-timer:';
const ID_SEGMENT_SEPARATOR = '\u0000';
const MAX_UNOBSERVED_RUN_TRANSITION_MS = 5_000;
export const MAX_TRACKED_ACTIVITY_TIMERS = 200;
const timers = new Map<string, StoredActivityTimer>();
// Eviction ranks by the order this renderer last touched a key, never by the timestamps inside a
// record. A record can legitimately carry a timestamp ahead of the renderer clock (task data from
// another machine, a backward clock step), and such a key would outrank every timer the screen is
// reading for as long as it survives.
const touchOrder = new Map<string, number>();
let touchSequence = 0;
// Oldest first, `null` until the renderer's keys have been listed once. Never re-listed: the live
// set takes over the bookkeeping after that, so a rotating work interval costs a compare, not a
// walk of every other key in the origin.
let dormantTimerIds: string[] | null = null;

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMemberName(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function safeStorageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // localStorage can be unavailable in tests or restricted browser contexts.
  }
}

function safeStorageRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // localStorage can be unavailable in tests or restricted browser contexts.
  }
}

function storageKey(timerId: string): string {
  return `${STORAGE_PREFIX}${timerId}`;
}

function isStoredTimer(value: unknown): value is StoredActivityTimer {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StoredActivityTimer>;
  return (
    row.version === 1 &&
    typeof row.startedAtMs === 'number' &&
    Number.isFinite(row.startedAtMs) &&
    (row.baseElapsedMs === undefined ||
      (typeof row.baseElapsedMs === 'number' && Number.isFinite(row.baseElapsedMs))) &&
    typeof row.elapsedMs === 'number' &&
    Number.isFinite(row.elapsedMs) &&
    typeof row.updatedAtMs === 'number' &&
    Number.isFinite(row.updatedAtMs) &&
    typeof row.running === 'boolean' &&
    (row.runId === undefined || row.runId === null || typeof row.runId === 'string')
  );
}

function readStoredTimer(
  timerId: string,
  startedAtMs: number,
  baseElapsedMs: number
): StoredActivityTimer | null {
  const cached = timers.get(timerId);
  if (cached?.startedAtMs === startedAtMs) {
    touchTimer(timerId);
    return cached.baseElapsedMs === baseElapsedMs
      ? cached
      : { ...cached, baseElapsedMs, elapsedMs: Math.max(baseElapsedMs, cached.elapsedMs) };
  }

  const raw = safeStorageGet(storageKey(timerId));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredTimer(parsed) || parsed.startedAtMs !== startedAtMs) return null;
    const sanitized: StoredActivityTimer = {
      version: 1,
      startedAtMs: parsed.startedAtMs,
      baseElapsedMs,
      elapsedMs: Math.max(baseElapsedMs, parsed.elapsedMs),
      updatedAtMs: Math.max(parsed.startedAtMs, parsed.updatedAtMs),
      running: parsed.running,
      runId: parsed.runId ?? null,
    };
    makeRoomForTimer(timerId);
    rememberTimer(timerId, sanitized);
    return sanitized;
  } catch {
    return null;
  }
}

function writeStoredTimer(timerId: string, timer: StoredActivityTimer): void {
  makeRoomForTimer(timerId);
  rememberTimer(timerId, timer);
  safeStorageSet(storageKey(timerId), JSON.stringify(timer));
}

// Timer ids embed the anchor timestamp, so every new work interval, review cycle,
// task or team rotation adds keys that nothing ever reads again. Without a bound the
// in-memory map and the renderer's localStorage grow for the whole app lifetime.
function makeRoomForTimer(timerId: string): void {
  if (dormantTimerIds === null) {
    dormantTimerIds = collectDormantTimerIds(timerId);
  }
  drainDormantTimers(timerId);

  while (timers.size + (timers.has(timerId) ? 0 : 1) > MAX_TRACKED_ACTIVITY_TIMERS) {
    const victimId = leastRecentlyTouchedTimerId();
    if (victimId === null) return;
    forgetTimer(victimId);
    safeStorageRemove(storageKey(victimId));
  }
}

function touchTimer(timerId: string): void {
  touchSequence += 1;
  touchOrder.set(timerId, touchSequence);
}

function rememberTimer(timerId: string, timer: StoredActivityTimer): void {
  timers.set(timerId, timer);
  touchTimer(timerId);
}

function forgetTimer(timerId: string): void {
  timers.delete(timerId);
  touchOrder.delete(timerId);
}

// Only ever called when the incoming key is not resident yet, so it cannot be its own victim.
function leastRecentlyTouchedTimerId(): string | null {
  let victimId: string | null = null;
  let victimTouch = Number.POSITIVE_INFINITY;
  for (const [timerId, touch] of touchOrder) {
    if (touch < victimTouch) {
      victimId = timerId;
      victimTouch = touch;
    }
  }
  return victimId;
}

// Keys stored by earlier sessions are dead weight as soon as this session needs the room. Their
// only trustworthy age is the anchor timestamp the id itself carries, so they are ranked from the
// key and their values are never read: a payload this build cannot interpret — a future schema, or
// a record whose read threw — must still not be destroyed for that reason.
function collectDormantTimerIds(incomingTimerId: string): string[] {
  const ranked: { timerId: string; startedAtMs: number }[] = [];
  for (const timerId of readStorageTimerIds()) {
    if (timerId === incomingTimerId || timers.has(timerId)) continue;
    const startedAtMs = parseIsoMs(timerId.slice(timerId.lastIndexOf(ID_SEGMENT_SEPARATOR) + 1));
    if (startedAtMs <= 0) continue;
    ranked.push({ timerId, startedAtMs });
  }
  ranked.sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs || compareTimerIds(left.timerId, right.timerId)
  );
  return ranked.map((entry) => entry.timerId);
}

function drainDormantTimers(incomingTimerId: string): void {
  const resident = timers.size + (timers.has(incomingTimerId) ? 0 : 1);
  const budget = Math.max(0, MAX_TRACKED_ACTIVITY_TIMERS - resident);
  const dormant = dormantTimerIds;
  if (!dormant) return;

  while (dormant.length > budget) {
    const timerId = dormant.shift();
    if (timerId === undefined) return;
    if (timerId === incomingTimerId || timers.has(timerId)) continue;
    safeStorageRemove(storageKey(timerId));
  }
}

function compareTimerIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function readStorageTimerIds(): string[] {
  const ids: string[] = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return ids;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) ids.push(key.slice(STORAGE_PREFIX.length));
    }
  } catch {
    // localStorage can be unavailable in tests or restricted browser contexts.
  }
  return ids;
}

function createInitialTimer(
  startedAtMs: number,
  baseElapsedMs: number,
  running: boolean,
  nowMs: number,
  runId: string | null | undefined
): StoredActivityTimer {
  if (running) {
    return {
      version: 1,
      startedAtMs,
      baseElapsedMs,
      elapsedMs: baseElapsedMs,
      updatedAtMs: startedAtMs,
      running: true,
      runId,
    };
  }

  return {
    version: 1,
    startedAtMs,
    baseElapsedMs,
    elapsedMs: baseElapsedMs,
    updatedAtMs: nowMs,
    running: false,
    runId,
  };
}

function materializeElapsed(
  timer: StoredActivityTimer,
  nowMs: number,
  runId: string | null | undefined
): number {
  const baseElapsedMs = Math.max(0, timer.baseElapsedMs);
  if (!timer.running) return Math.max(baseElapsedMs, timer.elapsedMs);

  const rawGapMs = Math.max(0, nowMs - timer.updatedAtMs);
  const sameRun = (timer.runId ?? null) === (runId ?? null);
  const gapMs = sameRun ? rawGapMs : Math.min(rawGapMs, MAX_UNOBSERVED_RUN_TRANSITION_MS);
  return Math.max(baseElapsedMs, timer.elapsedMs + gapMs);
}

export function createMemberActivityTimerId({
  teamName,
  memberName,
  phase,
  taskId,
  startedAt,
}: {
  teamName: string;
  memberName: string;
  phase: MemberActivityPhase;
  taskId: string;
  startedAt: string;
}): string {
  // The anchor timestamp is the last segment: eviction ranks stored keys by it without reading
  // their values, so producers and the rank parser must agree on its position.
  return [teamName, normalizeMemberName(memberName), phase, taskId, startedAt].join(
    ID_SEGMENT_SEPARATOR
  );
}

export function syncMemberActivityTimer({
  timerId,
  startedAtMs,
  baseElapsedMs = 0,
  running,
  runId,
  nowMs = Date.now(),
}: {
  timerId: string;
  startedAtMs: number;
  baseElapsedMs?: number;
  running: boolean;
  runId?: string | null;
  nowMs?: number;
}): number {
  const existing =
    readStoredTimer(timerId, startedAtMs, baseElapsedMs) ??
    createInitialTimer(startedAtMs, baseElapsedMs, running, nowMs, runId);
  const elapsedMs = materializeElapsed(existing, nowMs, runId);
  const next: StoredActivityTimer = {
    version: 1,
    startedAtMs,
    baseElapsedMs,
    elapsedMs,
    updatedAtMs: nowMs,
    running,
    runId,
  };
  writeStoredTimer(timerId, next);
  return elapsedMs;
}

export function readMemberActivityTimerElapsed({
  timerId,
  startedAtMs,
  baseElapsedMs = 0,
  running,
  runId,
  nowMs = Date.now(),
}: {
  timerId: string;
  startedAtMs: number;
  baseElapsedMs?: number;
  running: boolean;
  runId?: string | null;
  nowMs?: number;
}): number {
  const timer =
    readStoredTimer(timerId, startedAtMs, baseElapsedMs) ??
    createInitialTimer(startedAtMs, baseElapsedMs, running, nowMs, runId);
  // Either side reporting it paused is enough: a record left running by an interrupted pause sync
  // must not resume accruing, because only the reader knows the timer stopped.
  return materializeElapsed(running ? timer : { ...timer, running: false }, nowMs, runId);
}

export function formatMemberActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function deriveWorkActivityTimerAnchor(
  task: TeamTaskWithKanban,
  params: {
    teamName: string;
    memberName: string;
  }
): MemberActivityTimerAnchor | null {
  if (!isTeamTaskActivelyWorked(task)) return null;

  const intervals = Array.isArray(task.workIntervals) ? task.workIntervals : [];
  let baseElapsedMs = 0;
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    const interval = intervals[index];
    const startedAtMs = parseIsoMs(interval?.startedAt);
    if (startedAtMs > 0 && interval?.completedAt === undefined) {
      for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
        const previous = intervals[previousIndex];
        const previousStartedAtMs = parseIsoMs(previous?.startedAt);
        const previousCompletedAtMs = parseIsoMs(previous?.completedAt);
        if (previousStartedAtMs > 0 && previousCompletedAtMs > previousStartedAtMs) {
          baseElapsedMs += previousCompletedAtMs - previousStartedAtMs;
        }
      }
      return {
        startedAt: interval.startedAt,
        startedAtMs,
        baseElapsedMs,
        timerId: createMemberActivityTimerId({
          teamName: params.teamName,
          memberName: params.memberName,
          phase: 'work',
          taskId: task.id,
          startedAt: interval.startedAt,
        }),
      };
    }
  }
  if (intervals.length > 0) return null;

  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'status_changed' && event.to === 'in_progress') {
      const startedAtMs = parseIsoMs(event.timestamp);
      if (startedAtMs > 0) {
        return {
          startedAt: event.timestamp,
          startedAtMs,
          baseElapsedMs: 0,
          timerId: createMemberActivityTimerId({
            teamName: params.teamName,
            memberName: params.memberName,
            phase: 'work',
            taskId: task.id,
            startedAt: event.timestamp,
          }),
        };
      }
    }
    if (event.type === 'task_created' && event.status === 'in_progress') {
      const startedAtMs = parseIsoMs(event.timestamp);
      if (startedAtMs > 0) {
        return {
          startedAt: event.timestamp,
          startedAtMs,
          baseElapsedMs: 0,
          timerId: createMemberActivityTimerId({
            teamName: params.teamName,
            memberName: params.memberName,
            phase: 'work',
            taskId: task.id,
            startedAt: event.timestamp,
          }),
        };
      }
    }
  }

  return null;
}

export function deriveReviewActivityTimerAnchor(
  task: TeamTaskWithKanban,
  params: {
    teamName: string;
    memberName: string;
  }
): MemberActivityTimerAnchor | null {
  const memberKey = normalizeMemberName(params.memberName);
  if (!memberKey) return null;

  const reviewIntervals = Array.isArray(task.reviewIntervals) ? task.reviewIntervals : [];
  for (let index = reviewIntervals.length - 1; index >= 0; index -= 1) {
    const interval = reviewIntervals[index];
    if (
      normalizeMemberName(interval?.reviewer) !== memberKey ||
      interval?.completedAt !== undefined
    ) {
      continue;
    }
    const startedAtMs = parseIsoMs(interval.startedAt);
    if (startedAtMs <= 0) return null;

    const cycleStartedAtMs = getCurrentReviewCycleStartedAtMs(task, startedAtMs);
    let baseElapsedMs = 0;
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = reviewIntervals[previousIndex];
      if (normalizeMemberName(previous?.reviewer) !== memberKey) continue;
      const previousStartedAtMs = parseIsoMs(previous?.startedAt);
      const previousCompletedAtMs = parseIsoMs(previous?.completedAt);
      if (
        previousStartedAtMs >= cycleStartedAtMs &&
        previousStartedAtMs > 0 &&
        previousCompletedAtMs > previousStartedAtMs
      ) {
        baseElapsedMs += previousCompletedAtMs - previousStartedAtMs;
      }
    }

    return {
      startedAt: interval.startedAt,
      startedAtMs,
      baseElapsedMs,
      timerId: createMemberActivityTimerId({
        teamName: params.teamName,
        memberName: params.memberName,
        phase: 'review',
        taskId: task.id,
        startedAt: interval.startedAt,
      }),
    };
  }

  const anchorEvent = getCurrentReviewTimerAnchorEvent(task, memberKey);
  if (!anchorEvent) return null;

  const startedAtMs = parseIsoMs(anchorEvent.timestamp);
  if (startedAtMs <= 0) return null;

  return {
    startedAt: anchorEvent.timestamp,
    startedAtMs,
    baseElapsedMs: 0,
    timerId: createMemberActivityTimerId({
      teamName: params.teamName,
      memberName: params.memberName,
      phase: 'review',
      taskId: task.id,
      startedAt: anchorEvent.timestamp,
    }),
  };
}

function getCurrentReviewTimerAnchorEvent(
  task: TeamTaskWithKanban,
  memberKey: string
): { timestamp: string } | null {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'review_started') {
      return normalizeMemberName(event.actor) === memberKey ? { timestamp: event.timestamp } : null;
    }

    if (
      event.type === 'review_requested' ||
      event.type === 'review_approved' ||
      event.type === 'review_changes_requested' ||
      event.type === 'task_created' ||
      (event.type === 'status_changed' &&
        (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted'))
    ) {
      return null;
    }
  }

  return null;
}

function getCurrentReviewCycleStartedAtMs(task: TeamTaskWithKanban, fallbackMs: number): number {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'review_started') {
      const startedAtMs = parseIsoMs(event.timestamp);
      return startedAtMs > 0 ? startedAtMs : fallbackMs;
    }
    if (
      event.type === 'review_approved' ||
      event.type === 'review_changes_requested' ||
      event.type === 'task_created' ||
      (event.type === 'status_changed' &&
        (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted'))
    ) {
      return fallbackMs;
    }
  }
  return fallbackMs;
}

export function resetMemberActivityTimerStoreForTests(): void {
  timers.clear();
  touchOrder.clear();
  touchSequence = 0;
  dormantTimerIds = null;
}
