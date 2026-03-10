import type { TeamTask } from '@shared/types';

const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksLikeCanonicalTaskId(taskId: string): boolean {
  return UUID_TASK_ID_PATTERN.test(taskId.trim());
}

export function deriveTaskDisplayId(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) return normalized;
  return looksLikeCanonicalTaskId(normalized) ? normalized.slice(0, 8).toLowerCase() : normalized;
}

export function getTaskDisplayId(task: Pick<TeamTask, 'id' | 'displayId'>): string {
  return task.displayId?.trim() || deriveTaskDisplayId(task.id);
}

export function formatTaskDisplayLabel(task: Pick<TeamTask, 'id' | 'displayId'>): string {
  return `#${getTaskDisplayId(task)}`;
}

export function taskMatchesRef(
  task: Pick<TeamTask, 'id' | 'displayId'>,
  ref: string | null | undefined
): boolean {
  if (!ref) return false;
  const normalized = ref.trim();
  if (!normalized) return false;
  return task.id === normalized || getTaskDisplayId(task) === normalized;
}
