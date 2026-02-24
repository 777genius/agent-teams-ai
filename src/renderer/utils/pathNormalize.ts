import type { GlobalTask } from '@shared/types';

export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  // Preserve root paths like "/" or "C:/"
  if (s !== '/' && !/^[A-Za-z]:\/$/.test(s)) {
    while (s.endsWith('/')) s = s.slice(0, -1);
  }
  return s.toLowerCase();
}

export interface TaskStatusCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

function incrementStatus(counts: TaskStatusCounts, status: string): TaskStatusCounts {
  if (status === 'pending') return { ...counts, pending: counts.pending + 1 };
  if (status === 'in_progress') return { ...counts, inProgress: counts.inProgress + 1 };
  if (status === 'completed') return { ...counts, completed: counts.completed + 1 };
  return counts;
}

/** Build a map of normalized project path -> task status counts */
export function buildTaskCountsByProject(tasks: GlobalTask[]): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    if (!task.projectPath) continue;
    const key = normalizePath(task.projectPath);
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementStatus(counts, task.status));
  }
  return map;
}

/** Build a map of team name -> task status counts */
export function buildTaskCountsByTeam(tasks: GlobalTask[]): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    const key = task.teamName;
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementStatus(counts, task.status));
  }
  return map;
}

/** Build a map of owner name (lowercase) -> task status counts (ignores deleted). */
export function buildTaskCountsByOwner(
  tasks: { owner?: string | null; status: string }[]
): Map<string, TaskStatusCounts> {
  const map = new Map<string, TaskStatusCounts>();
  for (const task of tasks) {
    const owner = task.owner?.trim();
    if (!owner || task.status === 'deleted') continue;
    const key = owner.toLowerCase();
    const counts = map.get(key) ?? { pending: 0, inProgress: 0, completed: 0 };
    map.set(key, incrementStatus(counts, task.status));
  }
  return map;
}
