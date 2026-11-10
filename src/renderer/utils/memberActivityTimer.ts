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
// Oldest first, `null` until the renderer's keys have been listed once — on the first *write*, not
// the first read. Memory-only evictions rejoin this ordered list without re-listing storage.
let dormantTimerIds: string[] | null = null;
// A refused deletion must not hold a resident slot or orphan its disk key. Retry a bounded batch
// directly; overflow rejoins the dormant list, which already tracks retained disk state.
const PENDING_REMOVAL_LIMIT = MAX_TRACKED_ACTIVITY_TIMERS;
const pendingRemovalTimerIds = new Set<string>();
// Keys the producer has decided to write this frame but has not written yet. A backlog drain cannot
// tell such a key from dead weight: it is on disk, it is not resident, and nothing has read it. The
// set is the producer's own knowledge, handed over before the first write of the frame — see
// `declareActivityTimerKeys`.
// The declaration is keyed by the calling component, not global: two team lists open at once would
// otherwise replace each other's sets, and the second declaration would free the first one's
// unwritten anchors to the drain — the exact failure this exists to prevent.
const declaredByOwner = new Map<object, Set<string>>();

function isDeclaredTimerId(timerId: string): boolean {
  for (const ids of declaredByOwner.values()) {
    if (ids.has(timerId)) return true;
  }
  return false;
}

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMemberName(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function readStorageValue(key: string): { value: string | null; unreachable: boolean } {
  try {
    return { value: globalThis.localStorage?.getItem(key) ?? null, unreachable: false };
  } catch {
    // A throw is not an absence. The record may well be readable on the next tick, and reporting
    // "nothing here" would let the caller write a fresh baseline over banked elapsed time.
    return { value: null, unreachable: true };
  }
}

function safeStorageSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    // localStorage can be unavailable in tests or restricted browser contexts.
    return false;
  }
}

function safeStorageRemove(key: string): boolean {
  try {
    globalThis.localStorage?.removeItem(key);
    return true;
  } catch {
    // localStorage can be unavailable in tests or restricted browser contexts.
    return false;
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
): { timer: StoredActivityTimer | null; unreachable: boolean } {
  const cached = timers.get(timerId);
  if (cached?.startedAtMs === startedAtMs) {
    touchTimer(timerId);
    return {
      timer:
        cached.baseElapsedMs === baseElapsedMs
          ? cached
          : { ...cached, baseElapsedMs, elapsedMs: Math.max(baseElapsedMs, cached.elapsedMs) },
      unreachable: false,
    };
  }

  const stored = readStorageValue(storageKey(timerId));
  if (stored.unreachable) return { timer: null, unreachable: true };
  if (!stored.value) return { timer: null, unreachable: false };

  try {
    const parsed = JSON.parse(stored.value) as unknown;
    if (!isStoredTimer(parsed) || parsed.startedAtMs !== startedAtMs) {
      return { timer: null, unreachable: false };
    }
    const sanitized: StoredActivityTimer = {
      version: 1,
      startedAtMs: parsed.startedAtMs,
      baseElapsedMs,
      elapsedMs: Math.max(baseElapsedMs, parsed.elapsedMs),
      updatedAtMs: Math.max(parsed.startedAtMs, parsed.updatedAtMs),
      running: parsed.running,
      runId: parsed.runId ?? null,
    };
    makeRoomForResident(timerId, false);
    rememberTimer(timerId, sanitized);
    return { timer: sanitized, unreachable: false };
  } catch {
    return { timer: null, unreachable: false };
  }
}

function writeStoredTimer(timerId: string, timer: StoredActivityTimer): void {
  makeRoomForResident(timerId, true);
  rememberTimer(timerId, timer);
  const key = storageKey(timerId);
  const payload = JSON.stringify(timer);
  // Deletions a previous write could not complete free the same quota the backlog does, so they are
  // attempted on both paths, not only after a write that landed.
  drainPendingRemovals();
  if (safeStorageSet(key, payload)) {
    reapDormantTimers();
    return;
  }
  // The store refused the write. Bounding the resident map is not enough for a capacity-limited
  // store: the backlog is what fills the quota. Reclaim one oldest key, retry, and stop as soon as
  // the write lands, so a store that only needed one slot pays for exactly one — the anchor the
  // screen is showing must not be the thing that does not fit.
  for (let attempt = 0; attempt < QUOTA_RECLAIM_ATTEMPTS; attempt += 1) {
    if (reclaimOldestDormantTimers(1) === 0) return;
    if (safeStorageSet(key, payload)) return;
  }
}

// Bound memory on reads and writes. Prefer undeclared residents, then unbanked records, then touch
// order. Even a declared record can leave memory when every slot is live, but its disk state must
// survive. Reads never delete disk state: a later card in the same render may still need it.
function makeRoomForResident(timerId: string, persistEviction: boolean): void {
  while (timers.size + (timers.has(timerId) ? 0 : 1) > MAX_TRACKED_ACTIVITY_TIMERS) {
    const victimId =
      leastRecentlyTouchedTimerId(
        (timer, id) => !isDeclaredTimerId(id) && !holdsBankedPause(timer)
      ) ??
      leastRecentlyTouchedTimerId((_timer, id) => !isDeclaredTimerId(id)) ??
      leastRecentlyTouchedTimerId((timer) => !holdsBankedPause(timer)) ??
      leastRecentlyTouchedTimerId();
    if (victimId === null) return;
    forgetTimer(victimId);
    if (!persistEviction || isDeclaredTimerId(victimId)) {
      rememberDormantTimerId(victimId);
    } else if (!safeStorageRemove(storageKey(victimId))) queueRemoval(victimId);
  }
}

function touchTimer(timerId: string): void {
  touchSequence += 1;
  touchOrder.set(timerId, touchSequence);
}

function rememberTimer(timerId: string, timer: StoredActivityTimer): void {
  if (!timers.has(timerId)) forgetDormantTimerId(timerId);
  timers.set(timerId, timer);
  touchTimer(timerId);
}

function forgetTimer(timerId: string): void {
  timers.delete(timerId);
  touchOrder.delete(timerId);
}

// The incoming key cannot be this scan's victim, because `makeRoomForResident` only loops while the
// map is over its bound and a resident incoming key means the map is exactly at the bound — every
// insertion is guarded here, so `size > MAX` is unreachable for it. Stated as a dependency rather
// than enforced by a `timerId === incomingId` skip: the skip would be dead code the reader cannot
// test, and the guard that keeps it dead is one line above in the caller.
// `eligible`, when given, restricts the pass to the records the caller is willing to destroy; the
// caller falls back to the unrestricted ranking, so the map always shrinks by one and the eviction
// loop cannot spin.
function leastRecentlyTouchedTimerId(
  eligible?: (timer: StoredActivityTimer, timerId: string) => boolean
): string | null {
  let victimId: string | null = null;
  let victimTouch = Number.POSITIVE_INFINITY;
  for (const [timerId, touch] of touchOrder) {
    if (eligible) {
      const timer = timers.get(timerId);
      // The two Maps are written only together, so a resident missing from `timers` cannot happen;
      // the guard keeps a hypothetical drift from selecting no victim at all.
      if (!timer || !eligible(timer, timerId)) continue;
    }
    if (touch < victimTouch) {
      victimId = timerId;
      victimTouch = touch;
    }
  }
  return victimId;
}

function holdsBankedPause(timer: StoredActivityTimer): boolean {
  return !timer.running && timer.elapsedMs > timer.baseElapsedMs;
}

// Keys stored by earlier sessions are dead weight: a timer id embeds its anchor timestamp, so every
// new work interval, review cycle, task or team rotation adds a key nothing ever reads again, and
// without a reap the namespace grows for the whole lifetime of the app. Their only trustworthy age
// is the instant inside the key, so they are ranked from the key and their values are never read —
// a payload this build cannot interpret (a future schema, or a record whose read threw) must not be
// destroyed for that reason.
//
// Ownership comes from the producer's five-field id, including its normalized member and phase.
// Anchors preserve task timestamps verbatim, so rank them with the same parser the anchor producer
// accepts. A stricter date-shape filter would leave normally persisted anchors unreclaimable.

// One eighth of the excess per write: enough to converge a legacy namespace in a handful of
// writes, small enough that no single write takes a deletion burst of the whole backlog with it.
const DORMANT_REAP_DIVISOR = 8;
// A store that keeps refusing is not this module's to empty; give up after this many single-key
// reclaims rather than looping over a backlog that will not fit.
const QUOTA_RECLAIM_ATTEMPTS = 64;

function anchorMsFromTimerId(timerId: string): number {
  const segments = timerId.split(ID_SEGMENT_SEPARATOR);
  if (
    segments.length !== 5 ||
    (segments[2] !== 'work' && segments[2] !== 'review') ||
    normalizeMemberName(segments[1]) !== segments[1]
  ) {
    return 0;
  }
  return parseIsoMs(segments[4]);
}

function collectDormantTimerIds(): string[] | null {
  const storedIds = readStorageTimerIds();
  if (storedIds === null) return null;
  const ranked: { timerId: string; startedAtMs: number }[] = [];
  for (const timerId of storedIds) {
    if (timers.has(timerId)) continue;
    const startedAtMs = anchorMsFromTimerId(timerId);
    if (startedAtMs <= 0) continue;
    ranked.push({ timerId, startedAtMs });
  }
  ranked.sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs || compareTimerIds(left.timerId, right.timerId)
  );
  return ranked.map((entry) => entry.timerId);
}

function listDormantTimerIds(): string[] {
  if (dormantTimerIds === null) {
    dormantTimerIds = collectDormantTimerIds();
  }
  return dormantTimerIds ?? []; // An incomplete enumeration remains retryable on a later write.
}

// An initial resident was excluded from the one-time snapshot. If it later leaves memory without
// a disk delete, insert it by anchor age so the drain can reach it once no owner declares it.
// Binary insertion also deduplicates ids already listed, without another localStorage scan.
function rememberDormantTimerId(timerId: string): void {
  if (dormantTimerIds === null) return; // The first snapshot will include it.
  const startedAtMs = anchorMsFromTimerId(timerId);
  if (startedAtMs <= 0) return;
  let low = 0;
  let high = dormantTimerIds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidateId = dormantTimerIds[middle];
    const rank =
      anchorMsFromTimerId(candidateId) - startedAtMs || compareTimerIds(candidateId, timerId);
    if (rank < 0) low = middle + 1;
    else high = middle;
  }
  if (dormantTimerIds[low] !== timerId) dormantTimerIds.splice(low, 0, timerId);
}

// Keep disk inventory disjoint from residents, and drop keys whose pending delete succeeded.
function forgetDormantTimerId(timerId: string): void {
  if (dormantTimerIds === null) return;
  const index = dormantTimerIds.indexOf(timerId);
  if (index >= 0) dormantTimerIds.splice(index, 1);
}

// Deletes up to `count` of the oldest backlog keys, oldest anchor first, and reports how many were
// actually reclaimed. Residents are skipped: a key this session has read is a key the screen is
// displaying, and React reads every displayed timer during the render phase, before the effect that
// writes — so by the time anything here runs, the visible set is resident. Keys the producer has
// declared but not written yet are skipped for the same reason.
//
// The scan advances by index instead of consuming the list, so a skipped key stays where it is and
// the next call considers it again. Consuming it here would be the quiet failure mode: the list is
// built once per session, so a key dropped from it is invisible to every later drain no matter how
// long it stays on disk.
function reclaimOldestDormantTimers(count: number): number {
  const dormant = listDormantTimerIds();
  let reclaimed = 0;
  let index = 0;
  while (index < dormant.length && reclaimed < count) {
    const timerId = dormant[index];
    if (timers.has(timerId) || isDeclaredTimerId(timerId)) {
      index += 1;
      continue;
    }
    if (!safeStorageRemove(storageKey(timerId))) {
      // Storage refuses deletions (read-only or restricted). Stop rather than keep claiming a
      // reclamation that did not happen, and leave the key at the head of the list: the next write
      // tries it again. Dropping it would leave the namespace over the bound for the rest of the
      // session while this module believed it had already reclaimed the room.
      return reclaimed;
    }
    dormant.splice(index, 1);
    reclaimed += 1;
  }
  return reclaimed;
}

function queueRemoval(timerId: string): void {
  if (pendingRemovalTimerIds.size < PENDING_REMOVAL_LIMIT) pendingRemovalTimerIds.add(timerId);
  else rememberDormantTimerId(timerId);
}

// A deletion the store refused, retried from the write path — the same path that reclaims, and the
// only one that can. A key re-hydrated since it was queued is on screen again, so its fresh record
// must survive and the queue entry is dropped without a delete. One refusal ends the pass: a store
// that will not delete this key will not delete the next either.
function drainPendingRemovals(): void {
  for (const timerId of pendingRemovalTimerIds) {
    if (timers.has(timerId)) {
      pendingRemovalTimerIds.delete(timerId);
      continue;
    }
    if (isDeclaredTimerId(timerId)) continue;
    if (!safeStorageRemove(storageKey(timerId))) return;
    forgetDormantTimerId(timerId);
    pendingRemovalTimerIds.delete(timerId);
  }
}

// Reclaimed from the write path only. Reaping from a read would run inside the render pass, before
// the cards further down the list have read their own records, and delete what the same frame is
// about to display.
function reapDormantTimers(): void {
  const excess = timers.size + listDormantTimerIds().length - MAX_TRACKED_ACTIVITY_TIMERS;
  if (excess <= 0) return;
  reclaimOldestDormantTimers(Math.max(1, Math.ceil(excess / DORMANT_REAP_DIVISOR)));
}

function compareTimerIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function readStorageTimerIds(): string[] | null {
  const ids: string[] = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) ids.push(key.slice(STORAGE_PREFIX.length));
    }
  } catch {
    return null; // A partial listing cannot establish that every retained disk key is tracked.
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

/**
 * Replace the set of timer keys the caller intends to write next. Every member card is written by an
 * effect, and effects flush in sequence, so the first write of a frame can drain a backlog that
 * still holds the anchors later in that same frame are about to write. Nothing in this module can
 * see that plan — the key is not resident, nothing has read it, and its record on disk is exactly as
 * old as the live interval it belongs to. The caller has the set, so it hands it over here, before
 * the first write, and the drain skips it.
 *
 * A caller declares for itself: `owner` is any object that lives as long as the declaring
 * component (a `useRef` value is the natural one), and an empty list withdraws the declaration.
 * Within one owner the set is replaced, never unioned, so a key the producer stops declaring is
 * ordinary backlog again.
 * Declaring does not create a record; it withholds one from every deletion path until the
 * declaration is replaced by one that omits it.
 */
export function declareActivityTimerKeys(owner: object, timerIds: readonly string[]): void {
  if (timerIds.length === 0) {
    declaredByOwner.delete(owner);
    return;
  }
  let ids = declaredByOwner.get(owner);
  if (!ids) {
    ids = new Set<string>();
    declaredByOwner.set(owner, ids);
  }
  ids.clear();
  for (const timerId of timerIds) {
    if (timerId) ids.add(timerId);
  }
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
  const stored = readStoredTimer(timerId, startedAtMs, baseElapsedMs);
  const existing =
    stored.timer ?? createInitialTimer(startedAtMs, baseElapsedMs, running, nowMs, runId);
  const elapsedMs = materializeElapsed(existing, nowMs, runId);
  if (!stored.timer && stored.unreachable) {
    // Nothing was read, and the storage said so by throwing rather than by being empty. Writing this
    // tick's baseline would destroy banked elapsed that is probably still on disk, so the tick is
    // skipped and the next persistence attempt re-reads it.
    return elapsedMs;
  }
  writeStoredTimer(timerId, {
    version: 1,
    startedAtMs,
    baseElapsedMs,
    elapsedMs,
    updatedAtMs: nowMs,
    running,
    runId,
  });
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
    readStoredTimer(timerId, startedAtMs, baseElapsedMs).timer ??
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
      event.type === 'review_disapproved' ||
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
      event.type === 'review_disapproved' ||
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
  pendingRemovalTimerIds.clear();
  declaredByOwner.clear();
}
