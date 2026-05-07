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
const MAX_UNOBSERVED_RUN_TRANSITION_MS = 5_000;
const timers = new Map<string, StoredActivityTimer>();

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
    timers.set(timerId, sanitized);
    return sanitized;
  } catch {
    return null;
  }
}

function writeStoredTimer(timerId: string, timer: StoredActivityTimer): void {
  timers.set(timerId, timer);
  safeStorageSet(storageKey(timerId), JSON.stringify(timer));
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
  return [teamName, normalizeMemberName(memberName), phase, taskId, startedAt].join('\u0000');
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
  return materializeElapsed(timer, nowMs, runId);
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
    if (startedAtMs > 0 && !interval?.completedAt) {
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

  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'review_started') {
      if (normalizeMemberName(event.actor) !== memberKey) {
        return null;
      }
      const startedAtMs = parseIsoMs(event.timestamp);
      if (startedAtMs <= 0) return null;
      return {
        startedAt: event.timestamp,
        startedAtMs,
        baseElapsedMs: 0,
        timerId: createMemberActivityTimerId({
          teamName: params.teamName,
          memberName: params.memberName,
          phase: 'review',
          taskId: task.id,
          startedAt: event.timestamp,
        }),
      };
    }

    if (
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

export function resetMemberActivityTimerStoreForTests(): void {
  timers.clear();
}
