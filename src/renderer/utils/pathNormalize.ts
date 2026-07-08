import { normalizePathForComparison, stripTrailingSeparators } from '@shared/utils/platformPath';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskDeleted,
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';

import type { GlobalTask } from '@shared/types';

export function normalizePath(p: string): string {
  return stripTrailingSeparators(normalizePathForComparison(p));
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

/** Build a map of team name -> task status counts */
export function buildTaskCountsByTeam(tasks: GlobalTask[]): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    const key = task.teamName;
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementTaskStatus(counts, task));
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
