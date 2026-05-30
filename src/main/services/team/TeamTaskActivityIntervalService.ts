import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

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

type MutableTeamTask = TeamTask & {
  reviewIntervals?: TaskReviewInterval[];
};

const CRASH_REPAIR_GRACE_MS = 5_000;
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

function readTaskFile(filePath: string): MutableTeamTask | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as MutableTeamTask) : null;
  } catch {
    return null;
  }
}

function writeTaskFile(filePath: string, task: MutableTeamTask): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(task, null, 2));
  fs.renameSync(tempPath, filePath);
}

export class TeamTaskActivityIntervalService {
  private mutateTeamTasks(
    teamName: string,
    mutate: (task: MutableTeamTask) => boolean
  ): ActivityIntervalResult {
    const lockScope = path.join(getTeamsBasePath(), teamName, 'board-state');
    try {
      return withFileLockSync(lockScope, () => this.mutateTeamTasksUnlocked(teamName, mutate));
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to update task activity intervals: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { changedTasks: 0, failed: true };
    }
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
      const task = readTaskFile(filePath);
      if (!task) continue;
      if (!mutate(task)) continue;
      writeTaskFile(filePath, task);
      changedTasks += 1;
    }

    if (changedTasks > 0) {
      TeamTaskReader.invalidateAllTasksCache();
    }
    return { changedTasks };
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
    return this.mutateTeamTasks(teamName, (task) => {
      const changedWork = closeOpenWorkIntervals(task, at, memberName);
      const changedReview = closeOpenReviewIntervals(task, at, memberName);
      const materializedWork = materializePausedWorkInterval(task, at, memberName);
      const materializedReview = materializePausedReviewInterval(task, at, memberName);
      return changedWork || changedReview || materializedWork || materializedReview;
    });
  }

  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at = new Date().toISOString()
  ): ActivityIntervalResult {
    const memberKey = normalizeMemberName(memberName);
    if (!memberKey) return { changedTasks: 0 };

    return this.mutateTeamTasks(teamName, (task) => {
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
   * instead of once per member.
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

    return this.mutateTeamTasks(teamName, (task) => {
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
