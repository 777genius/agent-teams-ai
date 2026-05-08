import { getTasksBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { TeamTaskReader } from './TeamTaskReader';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TaskReviewInterval,
  TeamTask,
} from '@shared/types';

interface ActivityIntervalResult {
  changedTasks: number;
}

type MutableTeamTask = TeamTask & {
  reviewIntervals?: TaskReviewInterval[];
};

const CRASH_REPAIR_GRACE_MS = 5_000;

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

function ensureCloseIso(startedAt: string, at: string): string {
  const startedAtMs = parseIsoMs(startedAt);
  const atMs = parseIsoMs(at);
  if (startedAtMs <= 0) return at;
  if (atMs <= startedAtMs) return toIso(startedAtMs);
  return toIso(atMs);
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

function hasOpenWorkInterval(task: MutableTeamTask): boolean {
  return (
    Array.isArray(task.workIntervals) &&
    task.workIntervals.some((interval) => !interval.completedAt)
  );
}

function hasOpenReviewInterval(task: MutableTeamTask, reviewer: string): boolean {
  const reviewerKey = normalizeMemberName(reviewer);
  return (
    Array.isArray(task.reviewIntervals) &&
    task.reviewIntervals.some(
      (interval) => !interval.completedAt && normalizeMemberName(interval.reviewer) === reviewerKey
    )
  );
}

function closeOpenWorkIntervals(task: MutableTeamTask, at: string, owner?: string): boolean {
  if (!Array.isArray(task.workIntervals)) return false;
  if (owner && normalizeMemberName(task.owner) !== normalizeMemberName(owner)) return false;

  let changed = false;
  task.workIntervals = task.workIntervals.map((interval) => {
    if (interval.completedAt) return interval;
    changed = true;
    return { ...interval, completedAt: ensureCloseIso(interval.startedAt, at) };
  });
  return changed;
}

function closeOpenReviewIntervals(task: MutableTeamTask, at: string, reviewer?: string): boolean {
  if (!Array.isArray(task.reviewIntervals)) return false;
  const reviewerKey = normalizeMemberName(reviewer);

  let changed = false;
  task.reviewIntervals = task.reviewIntervals.map((interval) => {
    if (interval.completedAt) return interval;
    if (reviewerKey && normalizeMemberName(interval.reviewer) !== reviewerKey) return interval;
    changed = true;
    return { ...interval, completedAt: ensureCloseIso(interval.startedAt, at) };
  });
  return changed;
}

function getActiveReviewActor(task: MutableTeamTask): string | null {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'review_started') {
      return typeof event.actor === 'string' && event.actor.trim() ? event.actor.trim() : null;
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
    const tasksDir = path.join(getTasksBasePath(), teamName);
    let entries: string[];
    try {
      entries = fs.readdirSync(tasksDir);
    } catch {
      return { changedTasks: 0 };
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
      return changedWork || changedReview;
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
      return changedWork || changedReview;
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
        task.workIntervals = [
          ...(Array.isArray(task.workIntervals) ? task.workIntervals : []),
          { startedAt: at },
        ];
        changed = true;
      }

      const activeReviewer = getActiveReviewActor(task);
      if (
        activeReviewer &&
        normalizeMemberName(activeReviewer) === memberKey &&
        !hasOpenReviewInterval(task, activeReviewer)
      ) {
        task.reviewIntervals = [
          ...(Array.isArray(task.reviewIntervals) ? task.reviewIntervals : []),
          { reviewer: activeReviewer, startedAt: at },
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
          if (interval.completedAt) return interval;
          changed = true;
          return { ...interval, completedAt: crashRepairCloseIso(interval.startedAt, ownerMember) };
        });
      }

      if (Array.isArray(task.reviewIntervals)) {
        task.reviewIntervals = task.reviewIntervals.map((interval) => {
          if (interval.completedAt) return interval;
          const reviewerMember = memberByName.get(normalizeMemberName(interval.reviewer));
          changed = true;
          return {
            ...interval,
            completedAt: crashRepairCloseIso(interval.startedAt, reviewerMember),
          };
        });
      }

      return changed;
    });
  }
}
