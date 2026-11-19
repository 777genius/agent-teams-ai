import { normalizePathForComparison, stripTrailingSeparators } from '@shared/utils/platformPath';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskDeleted,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';

import type { GlobalTask, TeamSummary } from '@shared/types';

export function normalizePath(p: string): string {
  return stripTrailingSeparators(normalizePathForComparison(p));
}

/** Case-insensitive UI comparison key. Keep normalizePath for identity maps. */
export function normalizePathForMatching(p: string): string {
  return normalizePath(p).toLowerCase();
}

export interface TaskStatusCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

function incrementTaskStatus(
  counts: TaskStatusCounts,
  task: {
    status: string;
    reviewState?: string | null;
    kanbanColumn?: string | null;
    deletedAt?: string | null;
  }
): TaskStatusCounts {
  if (isTeamTaskDeleted(task)) return counts;
  if (getTeamTaskWorkflowColumn(task) === 'approved') {
    return { ...counts, completed: counts.completed + 1 };
  }
  if (isTeamTaskNeedsFixActionable(task)) {
    return task.status === 'in_progress'
      ? { ...counts, inProgress: counts.inProgress + 1 }
      : { ...counts, pending: counts.pending + 1 };
  }
  if (task.status === 'pending') return { ...counts, pending: counts.pending + 1 };
  if (isTeamTaskFinishedForDependency(task)) {
    return { ...counts, completed: counts.completed + 1 };
  }
  if (task.status === 'in_progress') return { ...counts, inProgress: counts.inProgress + 1 };
  return counts;
}

/** Build a map of normalized project path -> task status counts */
export function buildTaskCountsByProject(tasks: GlobalTask[]): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    if (!task.projectPath) continue;
    const key = normalizePath(task.projectPath);
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementTaskStatus(counts, task));
  }
  return map;
}

/** Preserve physical team counts; also roll up only backend-verified aliases into their logical team. */
export function buildTaskCountsByTeam(
  tasks: GlobalTask[],
  teams: readonly Pick<TeamSummary, 'teamName' | 'projectHistoryContexts'>[] = []
): Map<string, TaskStatusCounts> {
  const logicalByAlias = new Map<string, string>();
  for (const team of teams) {
    for (const context of team.projectHistoryContexts ?? []) {
      if (context.executionTeamName !== team.teamName) {
        logicalByAlias.set(context.executionTeamName, team.teamName);
      }
    }
  }

  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    const key = task.teamName;
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementTaskStatus(counts, task));
    const logicalName = logicalByAlias.get(key);
    if (logicalName) {
      const logicalCounts = map.get(logicalName) ?? { pending: 0, inProgress: 0, completed: 0 };
      map.set(logicalName, incrementTaskStatus(logicalCounts, task));
    }
  }
  return map;
}

/** Build a map of owner name (lowercase) -> task status counts (ignores deleted). */
export function buildTaskCountsByOwner(
  tasks: {
    owner?: string | null;
    status: string;
    reviewState?: string | null;
    kanbanColumn?: string | null;
    deletedAt?: string | null;
  }[]
): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    const owner = task.owner?.trim();
    if (!owner || isTeamTaskDeleted(task)) continue;
    if (getTeamTaskWorkflowColumn(task) === 'review') continue;
    const key = owner.toLowerCase();
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementTaskStatus(counts, task));
  }
  return map;
}
