import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { estimateCachedValueBytes } from './cacheMemoryEstimate';
import { withFileLockSync } from './fileLock';
import { TeamTaskReader } from './TeamTaskReader';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TaskReviewInterval,
  TeamTask,
} from '@shared/types';

interface ActivityIntervalResult {
  changedTasks: number;
  failed?: boolean;
}

interface TaskDirectorySignature {
  key: string;
}

interface TaskFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface CachedActivityTaskFile {
  signature: TaskFileSignature;
  task: MutableTeamTask | null;
  estimatedBytes: number;
}

interface ResumeMembersCacheEntry {
  memberKey: string;
  signatureKey: string;
}

type MemberActivityNoopOperation = 'pause-member' | 'resume-member';

type MutableTeamTask = TeamTask & {
  reviewIntervals?: TaskReviewInterval[];
};

const CRASH_REPAIR_GRACE_MS = 5_000;
const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024;
const TASK_FILE_CACHE_MAX_ENTRIES = 256;
const TASK_FILE_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const TASK_FILE_CACHE_MAX_ENTRY_BYTES = 512 * 1024;
const logger = createLogger('Service:TeamTaskActivityIntervalService');

function normalizeMemberName(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function parseIsoMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isClosedInterval(interval: { completedAt?: unknown } | null | undefined): boolean {
  return typeof interval?.completedAt === 'string' && parseIsoMs(interval.completedAt) > 0;
}

function hasValidStartedAt(interval: { startedAt?: unknown } | null | undefined): boolean {
  return typeof interval?.startedAt === 'string' && parseIsoMs(interval.startedAt) > 0;
}

function ensureCloseIso(startedAt: string, at: string): string {
  const startedAtMs = parseIsoMs(startedAt);
  const atMs = parseIsoMs(at);
  if (startedAtMs <= 0) return at;
  if (atMs <= startedAtMs) return toIso(startedAtMs);
  return toIso(atMs);
}

function resumeStartIso(activeStartedAt: string | null | undefined, at: string): string {
  const activeStartedAtMs = parseIsoMs(activeStartedAt ?? undefined);
  const atMs = parseIsoMs(at);
  if (activeStartedAtMs > 0 && activeStartedAtMs > atMs) {
    return toIso(activeStartedAtMs);
  }
  return atMs > 0 ? toIso(atMs) : toIso(Date.now());
}

function getStartedAtString(interval: { startedAt?: unknown } | null | undefined): string {
  return typeof interval?.startedAt === 'string' ? interval.startedAt : '';
}

function hasUsableCompletedAt(interval: { completedAt?: unknown } | null | undefined): boolean {
  return interval?.completedAt === undefined || isClosedInterval(interval);
}

function pauseCloseIso(
  interval: { startedAt?: unknown; completedAt?: unknown } | null | undefined,
  at: string
): string {
  const startedAt = getStartedAtString(interval);
  const closeAt = interval?.completedAt === undefined ? at : startedAt || at;
  return ensureCloseIso(startedAt, closeAt);
}

function crashRepairCloseIso(startedAt: string, member?: PersistedTeamLaunchMemberState): string {
  const startedAtMs = parseIsoMs(startedAt);
  const safeStartedAtMs = startedAtMs > 0 ? startedAtMs : Date.now();
  const evidenceMs = Math.max(
    parseIsoMs(member?.lastHeartbeatAt),
    parseIsoMs(member?.runtimeLastSeenAt),
    parseIsoMs(member?.lastRuntimeAliveAt)
  );
  const closeMs =
    evidenceMs > 0
      ? Math.max(safeStartedAtMs, evidenceMs + CRASH_REPAIR_GRACE_MS)
      : safeStartedAtMs + CRASH_REPAIR_GRACE_MS;
  const boundedCloseMs = Math.max(safeStartedAtMs, Math.min(Date.now(), closeMs));
  return toIso(boundedCloseMs);
}

function crashRepairIntervalCloseIso(
  interval: { startedAt?: unknown; completedAt?: unknown } | null | undefined,
  member?: PersistedTeamLaunchMemberState
): string {
  const startedAt = getStartedAtString(interval);
  if (interval?.completedAt === undefined) {
    return crashRepairCloseIso(startedAt, member);
  }
  return ensureCloseIso(startedAt, startedAt || crashRepairCloseIso(startedAt, member));
}

function hasOpenWorkInterval(task: MutableTeamTask): boolean {
  return (
    Array.isArray(task.workIntervals) &&
    task.workIntervals.some(
      (interval) => hasValidStartedAt(interval) && interval.completedAt === undefined
    )
  );
}

function hasOpenReviewInterval(task: MutableTeamTask, reviewer: string): boolean {
  const reviewerKey = normalizeMemberName(reviewer);
  return (
    Array.isArray(task.reviewIntervals) &&
    task.reviewIntervals.some(
      (interval) =>
        hasValidStartedAt(interval) &&
        interval.completedAt === undefined &&
        normalizeMemberName(interval.reviewer) === reviewerKey
    )
  );
}

function closeOpenWorkIntervals(task: MutableTeamTask, at: string, owner?: string): boolean {
  if (!Array.isArray(task.workIntervals)) return false;
  if (owner && normalizeMemberName(task.owner) !== normalizeMemberName(owner)) return false;

  let changed = false;
  task.workIntervals = task.workIntervals.map((interval) => {
    if (isClosedInterval(interval)) return interval;
    changed = true;
    return { ...interval, completedAt: pauseCloseIso(interval, at) };
  });
  return changed;
}

function closeOpenReviewIntervals(task: MutableTeamTask, at: string, reviewer?: string): boolean {
  if (!Array.isArray(task.reviewIntervals)) return false;
  const reviewerKey = normalizeMemberName(reviewer);

  let changed = false;
  task.reviewIntervals = task.reviewIntervals.map((interval) => {
    if (isClosedInterval(interval)) return interval;
    if (reviewerKey && normalizeMemberName(interval.reviewer) !== reviewerKey) return interval;
    changed = true;
    return { ...interval, completedAt: pauseCloseIso(interval, at) };
  });
  return changed;
}

function getActiveWorkStartedAt(task: MutableTeamTask): string | null {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'status_changed') {
      if (event.to === 'in_progress') {
        return parseIsoMs(event.timestamp) > 0 ? event.timestamp : null;
      }
      return null;
    }
    if (event.type === 'task_created') {
      return event.status === 'in_progress' && parseIsoMs(event.timestamp) > 0
        ? event.timestamp
        : null;
    }
  }
  return null;
}

function getActiveReviewStart(
  task: MutableTeamTask
): { reviewer: string; startedAt: string } | null {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'review_started') {
      const reviewer =
        typeof event.actor === 'string' && event.actor.trim() ? event.actor.trim() : '';
      return reviewer && parseIsoMs(event.timestamp) > 0
        ? { reviewer, startedAt: event.timestamp }
        : null;
    }
    if (
      event.type === 'review_approved' ||
      event.type === 'review_changes_requested' ||
      (event.type === 'status_changed' &&
        (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted')) ||
      event.type === 'task_created'
    ) {
      return null;
    }
  }
  return null;
}

function hasWorkIntervalForStart(task: MutableTeamTask, startedAt: string): boolean {
  const startedAtMs = parseIsoMs(startedAt);
  return (
    startedAtMs > 0 &&
    Array.isArray(task.workIntervals) &&
    task.workIntervals.some((interval) => parseIsoMs(interval.startedAt) === startedAtMs)
  );
}

function hasPersistedWorkIntervalAtOrAfter(task: MutableTeamTask, startedAt: string): boolean {
  const startedAtMs = parseIsoMs(startedAt);
  return (
    startedAtMs > 0 &&
    Array.isArray(task.workIntervals) &&
    task.workIntervals.some(
      (interval) =>
        hasValidStartedAt(interval) &&
        hasUsableCompletedAt(interval) &&
        parseIsoMs(interval.startedAt) >= startedAtMs
    )
  );
}

function hasReviewIntervalForStart(
  task: MutableTeamTask,
  reviewer: string,
  startedAt: string
): boolean {
  const reviewerKey = normalizeMemberName(reviewer);
  const startedAtMs = parseIsoMs(startedAt);
  return (
    reviewerKey.length > 0 &&
    startedAtMs > 0 &&
    Array.isArray(task.reviewIntervals) &&
    task.reviewIntervals.some(
      (interval) =>
        normalizeMemberName(interval.reviewer) === reviewerKey &&
        parseIsoMs(interval.startedAt) === startedAtMs
    )
  );
}

function hasPersistedReviewIntervalAtOrAfter(task: MutableTeamTask, startedAt: string): boolean {
  const startedAtMs = parseIsoMs(startedAt);
  return (
    startedAtMs > 0 &&
    Array.isArray(task.reviewIntervals) &&
    task.reviewIntervals.some(
      (interval) =>
        normalizeMemberName(interval?.reviewer).length > 0 &&
        hasValidStartedAt(interval) &&
        hasUsableCompletedAt(interval) &&
        parseIsoMs(interval.startedAt) >= startedAtMs
    )
  );
}

function materializePausedWorkInterval(task: MutableTeamTask, at: string, owner?: string): boolean {
  if (task.status !== 'in_progress') return false;
  if (owner && normalizeMemberName(task.owner) !== normalizeMemberName(owner)) return false;

  const startedAt = getActiveWorkStartedAt(task);
  if (
    !startedAt ||
    hasPersistedWorkIntervalAtOrAfter(task, startedAt) ||
    hasWorkIntervalForStart(task, startedAt)
  ) {
    return false;
  }
  task.workIntervals = [
    ...(Array.isArray(task.workIntervals) ? task.workIntervals : []),
    { startedAt, completedAt: ensureCloseIso(startedAt, at) },
  ];
  return true;
}

function materializePausedReviewInterval(
  task: MutableTeamTask,
  at: string,
  reviewer?: string
): boolean {
  if (task.status !== 'completed') return false;
  const activeReview = getActiveReviewStart(task);
  if (!activeReview) return false;
  if (reviewer && normalizeMemberName(activeReview.reviewer) !== normalizeMemberName(reviewer)) {
    return false;
  }
  if (
    hasPersistedReviewIntervalAtOrAfter(task, activeReview.startedAt) ||
    hasReviewIntervalForStart(task, activeReview.reviewer, activeReview.startedAt)
  ) {
    return false;
  }
  task.reviewIntervals = [
    ...(Array.isArray(task.reviewIntervals) ? task.reviewIntervals : []),
    {
      reviewer: activeReview.reviewer,
      startedAt: activeReview.startedAt,
      completedAt: ensureCloseIso(activeReview.startedAt, at),
    },
  ];
  return true;
}

function writeTaskFile(filePath: string, task: MutableTeamTask): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(task, null, 2));
  fs.renameSync(tempPath, filePath);
}

function buildTaskFileSignature(stat: fs.Stats): TaskFileSignature {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function taskFileSignaturesEqual(a: TaskFileSignature, b: TaskFileSignature): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

export class TeamTaskActivityIntervalService {
  private readonly resumeMembersCache = new Map<string, ResumeMembersCacheEntry>();
  private readonly memberActivityNoopCache = new Map<string, string>();
  private readonly taskFileCache = new Map<string, CachedActivityTaskFile>();
  private taskFileCacheBytes = 0;

  private getBoardStateLockPath(teamName: string): string {
    return `${path.join(getTeamsBasePath(), teamName, 'board-state')}.lock`;
  }

  private getMemberActivityNoopCacheKey(
    teamName: string,
    operation: MemberActivityNoopOperation,
    memberKey: string
  ): string {
    return `${teamName}\u0000${operation}\u0000${memberKey}`;
  }

  private clearMemberActivityNoopCacheForTeam(teamName: string): void {
    const prefix = `${teamName}\u0000`;
    for (const key of this.memberActivityNoopCache.keys()) {
      if (key.startsWith(prefix)) {
        this.memberActivityNoopCache.delete(key);
      }
    }
  }

  private clearActivityNoopCachesForTeam(teamName: string): void {
    this.clearMemberActivityNoopCacheForTeam(teamName);
    this.resumeMembersCache.delete(teamName);
  }

  private getCachedTaskFile(
    filePath: string,
    signature: TaskFileSignature
  ): MutableTeamTask | null | undefined {
    const cached = this.taskFileCache.get(filePath);
    if (!cached) return undefined;
    if (!taskFileSignaturesEqual(cached.signature, signature)) {
      this.deleteCachedTaskFile(filePath);
      return undefined;
    }
    this.taskFileCache.delete(filePath);
    this.taskFileCache.set(filePath, cached);
    return cached.task ? structuredClone(cached.task) : null;
  }

  private deleteCachedTaskFile(filePath: string): void {
    const cached = this.taskFileCache.get(filePath);
    if (!cached) {
      return;
    }
    this.taskFileCacheBytes = Math.max(0, this.taskFileCacheBytes - cached.estimatedBytes);
    this.taskFileCache.delete(filePath);
  }

  private evictOldestTaskFileCacheEntry(): boolean {
    const oldestKey = this.taskFileCache.keys().next().value;
    if (oldestKey === undefined) {
      return false;
    }
    this.deleteCachedTaskFile(oldestKey);
    return true;
  }

  private trimTaskFileCache(): void {
    while (
      this.taskFileCache.size > TASK_FILE_CACHE_MAX_ENTRIES ||
      this.taskFileCacheBytes > TASK_FILE_CACHE_MAX_BYTES
    ) {
      if (!this.evictOldestTaskFileCacheEntry()) {
        return;
      }
    }
  }

  private setCachedTaskFile(
    filePath: string,
    signature: TaskFileSignature,
    task: MutableTeamTask | null
  ): void {
    const estimatedBytes = task ? estimateCachedValueBytes(task) : 0;
    this.deleteCachedTaskFile(filePath);
    if (estimatedBytes > TASK_FILE_CACHE_MAX_ENTRY_BYTES) {
      return;
    }
    this.taskFileCache.set(filePath, {
      signature,
      task: task ? structuredClone(task) : null,
      estimatedBytes,
    });
    this.taskFileCacheBytes += estimatedBytes;
    this.trimTaskFileCache();
  }

  private readTaskFile(filePath: string): MutableTeamTask | null {
    let signature: TaskFileSignature;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_TASK_FILE_BYTES) {
        this.deleteCachedTaskFile(filePath);
        return null;
      }
      signature = buildTaskFileSignature(stat);
      const cached = this.getCachedTaskFile(filePath, signature);
      if (cached !== undefined) {
        return cached;
      }
    } catch {
      this.deleteCachedTaskFile(filePath);
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      const task = parsed && typeof parsed === 'object' ? (parsed as MutableTeamTask) : null;
      this.setCachedTaskFile(filePath, signature, task);
      return task;
    } catch {
      this.setCachedTaskFile(filePath, signature, null);
      return null;
    }
  }

  private cacheWrittenTaskFile(filePath: string, task: MutableTeamTask): void {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_TASK_FILE_BYTES) {
        this.deleteCachedTaskFile(filePath);
        return;
      }
      this.setCachedTaskFile(filePath, buildTaskFileSignature(stat), task);
    } catch {
      this.deleteCachedTaskFile(filePath);
    }
  }

  private mutateTeamTasksWithLock(
    teamName: string,
    run: () => ActivityIntervalResult
  ): ActivityIntervalResult {
    const lockScope = path.join(getTeamsBasePath(), teamName, 'board-state');
    try {
      return withFileLockSync(lockScope, run);
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to update task activity intervals: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { changedTasks: 0, failed: true };
    }
  }

  private mutateTeamTasks(
    teamName: string,
    mutate: (task: MutableTeamTask) => boolean
  ): ActivityIntervalResult {
    const result = this.mutateTeamTasksWithLock(teamName, () =>
      this.mutateTeamTasksUnlocked(teamName, mutate)
    );
    if (result.changedTasks > 0 || result.failed) {
      this.clearActivityNoopCachesForTeam(teamName);
    }
    return result;
  }

  private mutateMemberTasksWithNoopCache(
    teamName: string,
    operation: MemberActivityNoopOperation,
    memberKey: string,
    mutate: (task: MutableTeamTask) => boolean
  ): ActivityIntervalResult {
    const cacheKey = this.getMemberActivityNoopCacheKey(teamName, operation, memberKey);
    const cachedSignatureKey = this.memberActivityNoopCache.get(cacheKey);
    if (cachedSignatureKey) {
      const beforeLockSignature = this.readTaskDirectorySignature(teamName);
      if (
        beforeLockSignature &&
        beforeLockSignature.key === cachedSignatureKey &&
        !fs.existsSync(this.getBoardStateLockPath(teamName))
      ) {
        return { changedTasks: 0 };
      }
    }

    const result = this.mutateTeamTasksWithLock(teamName, () => {
      const beforeSignature = this.readTaskDirectorySignature(teamName);
      if (beforeSignature && this.memberActivityNoopCache.get(cacheKey) === beforeSignature.key) {
        return { changedTasks: 0 };
      }

      const mutationResult = this.mutateTeamTasksUnlocked(teamName, mutate);
      if (mutationResult.changedTasks > 0) {
        this.clearActivityNoopCachesForTeam(teamName);
        return mutationResult;
      }

      const nextSignature = beforeSignature ?? this.readTaskDirectorySignature(teamName);
      if (nextSignature) {
        this.memberActivityNoopCache.set(cacheKey, nextSignature.key);
      } else {
        this.memberActivityNoopCache.delete(cacheKey);
      }
      return mutationResult;
    });

    if (result.changedTasks > 0 || result.failed) {
      this.clearActivityNoopCachesForTeam(teamName);
    }
    return result;
  }

  private mutateTeamTasksUnlocked(
    teamName: string,
    mutate: (task: MutableTeamTask) => boolean
  ): ActivityIntervalResult {
    const tasksDir = path.join(getTasksBasePath(), teamName);
    let entries: string[];
    try {
      entries = fs.readdirSync(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { changedTasks: 0 };
      }
      throw error;
    }

    let changedTasks = 0;
    for (const fileName of entries) {
      if (!fileName.endsWith('.json') || fileName.startsWith('.')) continue;
      const filePath = path.join(tasksDir, fileName);
      const task = this.readTaskFile(filePath);
      if (!task) continue;
      if (!mutate(task)) continue;
      writeTaskFile(filePath, task);
      this.cacheWrittenTaskFile(filePath, task);
      changedTasks += 1;
    }

    if (changedTasks > 0) {
      TeamTaskReader.invalidateAllTasksCache();
    }
    return { changedTasks };
  }

  private readTaskDirectorySignature(teamName: string): TaskDirectorySignature | null {
    const tasksDir = path.join(getTasksBasePath(), teamName);
    let entries: string[];
    try {
      entries = fs
        .readdirSync(tasksDir)
        .filter((fileName) => fileName.endsWith('.json') && !fileName.startsWith('.'))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { key: 'missing' };
      }
      return null;
    }

    const parts: string[] = [];
    for (const fileName of entries) {
      try {
        const stat = fs.statSync(path.join(tasksDir, fileName));
        if (!stat.isFile()) continue;
        parts.push([fileName, stat.size, stat.mtimeMs, stat.ctimeMs].join('\0'));
      } catch {
        return null;
      }
    }
    return { key: parts.join('\0\0') };
  }

  private makeMemberSetKey(memberKeys: ReadonlySet<string>): string {
    return [...memberKeys].sort().join('\0');
  }

  pauseActiveIntervalsForTeam(
    teamName: string,
    at = new Date().toISOString()
  ): ActivityIntervalResult {
    return this.mutateTeamTasks(teamName, (task) => {
      const changedWork = closeOpenWorkIntervals(task, at);
      const changedReview = closeOpenReviewIntervals(task, at);
      const materializedWork = materializePausedWorkInterval(task, at);
      const materializedReview = materializePausedReviewInterval(task, at);
      return changedWork || changedReview || materializedWork || materializedReview;
    });
  }

  pauseActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at = new Date().toISOString()
  ): ActivityIntervalResult {
    const memberKey = normalizeMemberName(memberName);
    const mutate = (task: MutableTeamTask): boolean => {
      const changedWork = closeOpenWorkIntervals(task, at, memberName);
      const changedReview = closeOpenReviewIntervals(task, at, memberName);
      const materializedWork = materializePausedWorkInterval(task, at, memberName);
      const materializedReview = materializePausedReviewInterval(task, at, memberName);
      return changedWork || changedReview || materializedWork || materializedReview;
    };

    if (!memberKey) {
      return this.mutateTeamTasks(teamName, mutate);
    }
    return this.mutateMemberTasksWithNoopCache(teamName, 'pause-member', memberKey, mutate);
  }

  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at = new Date().toISOString()
  ): ActivityIntervalResult {
    const memberKey = normalizeMemberName(memberName);
    if (!memberKey) return { changedTasks: 0 };

    return this.mutateMemberTasksWithNoopCache(teamName, 'resume-member', memberKey, (task) => {
      let changed = false;

      if (
        task.status === 'in_progress' &&
        normalizeMemberName(task.owner) === memberKey &&
        !hasOpenWorkInterval(task)
      ) {
        const activeStartedAt = getActiveWorkStartedAt(task);
        task.workIntervals = [
          ...(Array.isArray(task.workIntervals) ? task.workIntervals : []),
          { startedAt: resumeStartIso(activeStartedAt, at) },
        ];
        changed = true;
      }

      const activeReview = getActiveReviewStart(task);
      if (
        task.status === 'completed' &&
        activeReview &&
        normalizeMemberName(activeReview.reviewer) === memberKey &&
        !hasOpenReviewInterval(task, activeReview.reviewer)
      ) {
        task.reviewIntervals = [
          ...(Array.isArray(task.reviewIntervals) ? task.reviewIntervals : []),
          {
            reviewer: activeReview.reviewer,
            startedAt: resumeStartIso(activeReview.startedAt, at),
          },
        ];
        changed = true;
      }

      return changed;
    });
  }

  /**
   * Batched equivalent of resumeActiveIntervalsForMember for several members in a
   * single task-file pass. During launch the live-status loop resumes every alive
   * member every audit cycle; doing that per member meant one synchronous
   * file-lock + read of every task file PER member PER cycle. This applies the
   * identical per-member resume logic against a member set in one locked pass, so
   * the mutations are exactly the same but the lock + reads happen once per cycle
   * instead of once per member. After a no-op pass, a task-file signature skips
   * unchanged repeat cycles without parsing every task JSON again.
   */
  resumeActiveIntervalsForMembers(
    teamName: string,
    memberNames: readonly string[],
    at = new Date().toISOString()
  ): ActivityIntervalResult {
    const memberKeys = new Set(
      memberNames.map((name) => normalizeMemberName(name)).filter((key): key is string => !!key)
    );
    if (memberKeys.size === 0) return { changedTasks: 0 };
    const memberKey = this.makeMemberSetKey(memberKeys);

    const cachedBeforeLock = this.resumeMembersCache.get(teamName);
    if (cachedBeforeLock?.memberKey === memberKey) {
      const beforeLockSignature = this.readTaskDirectorySignature(teamName);
      if (
        beforeLockSignature &&
        cachedBeforeLock.signatureKey === beforeLockSignature.key &&
        !fs.existsSync(this.getBoardStateLockPath(teamName))
      ) {
        return { changedTasks: 0 };
      }
    }

    const result = this.mutateTeamTasksWithLock(teamName, () => {
      const beforeSignature = this.readTaskDirectorySignature(teamName);
      const cached = this.resumeMembersCache.get(teamName);
      if (
        beforeSignature &&
        cached?.memberKey === memberKey &&
        cached.signatureKey === beforeSignature.key
      ) {
        return { changedTasks: 0 };
      }

      const mutationResult = this.mutateTeamTasksUnlocked(teamName, (task) => {
        let changed = false;

        if (
          task.status === 'in_progress' &&
          memberKeys.has(normalizeMemberName(task.owner)) &&
          !hasOpenWorkInterval(task)
        ) {
          const activeStartedAt = getActiveWorkStartedAt(task);
          task.workIntervals = [
            ...(Array.isArray(task.workIntervals) ? task.workIntervals : []),
            { startedAt: resumeStartIso(activeStartedAt, at) },
          ];
          changed = true;
        }

        const activeReview = getActiveReviewStart(task);
        if (
          task.status === 'completed' &&
          activeReview &&
          memberKeys.has(normalizeMemberName(activeReview.reviewer)) &&
          !hasOpenReviewInterval(task, activeReview.reviewer)
        ) {
          task.reviewIntervals = [
            ...(Array.isArray(task.reviewIntervals) ? task.reviewIntervals : []),
            {
              reviewer: activeReview.reviewer,
              startedAt: resumeStartIso(activeReview.startedAt, at),
            },
          ];
          changed = true;
        }

        return changed;
      });

      const nextSignature =
        mutationResult.changedTasks > 0
          ? this.readTaskDirectorySignature(teamName)
          : beforeSignature;
      if (nextSignature) {
        this.resumeMembersCache.set(teamName, {
          memberKey,
          signatureKey: nextSignature.key,
        });
      } else {
        this.resumeMembersCache.delete(teamName);
      }
      return mutationResult;
    });

    if (result.failed) {
      this.clearActivityNoopCachesForTeam(teamName);
    } else if (result.changedTasks > 0) {
      this.clearMemberActivityNoopCacheForTeam(teamName);
    }
    return result;
  }

  repairStaleIntervalsAfterCrash(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): ActivityIntervalResult {
    const memberByName = new Map<string, PersistedTeamLaunchMemberState>();
    for (const member of Object.values(launchSnapshot?.members ?? {})) {
      memberByName.set(normalizeMemberName(member.name), member);
    }

    return this.mutateTeamTasks(teamName, (task) => {
      let changed = false;
      if (Array.isArray(task.workIntervals)) {
        const ownerMember = memberByName.get(normalizeMemberName(task.owner));
        task.workIntervals = task.workIntervals.map((interval) => {
          if (isClosedInterval(interval)) return interval;
          changed = true;
          return { ...interval, completedAt: crashRepairIntervalCloseIso(interval, ownerMember) };
        });
      }
      if (task.status === 'in_progress') {
        const ownerMember = memberByName.get(normalizeMemberName(task.owner));
        const startedAt = getActiveWorkStartedAt(task);
        if (
          startedAt &&
          !hasPersistedWorkIntervalAtOrAfter(task, startedAt) &&
          !hasWorkIntervalForStart(task, startedAt)
        ) {
          task.workIntervals = [
            ...(Array.isArray(task.workIntervals) ? task.workIntervals : []),
            { startedAt, completedAt: crashRepairCloseIso(startedAt, ownerMember) },
          ];
          changed = true;
        }
      }

      if (Array.isArray(task.reviewIntervals)) {
        task.reviewIntervals = task.reviewIntervals.map((interval) => {
          if (isClosedInterval(interval)) return interval;
          const reviewerMember = memberByName.get(normalizeMemberName(interval.reviewer));
          changed = true;
          return {
            ...interval,
            completedAt: crashRepairIntervalCloseIso(interval, reviewerMember),
          };
        });
      }
      if (task.status === 'completed') {
        const activeReview = getActiveReviewStart(task);
        if (
          activeReview &&
          !hasPersistedReviewIntervalAtOrAfter(task, activeReview.startedAt) &&
          !hasReviewIntervalForStart(task, activeReview.reviewer, activeReview.startedAt)
        ) {
          const reviewerMember = memberByName.get(normalizeMemberName(activeReview.reviewer));
          task.reviewIntervals = [
            ...(Array.isArray(task.reviewIntervals) ? task.reviewIntervals : []),
            {
              reviewer: activeReview.reviewer,
              startedAt: activeReview.startedAt,
              completedAt: crashRepairCloseIso(activeReview.startedAt, reviewerMember),
            },
          ];
          changed = true;
        }
      }

      return changed;
    });
  }
}
