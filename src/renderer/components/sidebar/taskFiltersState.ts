import { useSyncExternalStore } from 'react';

import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';

export type TaskStatusFilterId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export const STATUS_OPTIONS: { id: TaskStatusFilterId; label: string }[] = [
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
  { id: 'review', label: 'REVIEW' },
  { id: 'approved', label: 'APPROVED' },
];

export interface TaskFiltersState {
  statusIds: Set<TaskStatusFilterId>;
  teamName: string | null;
  unreadOnly: boolean;
}

export const defaultTaskFiltersState = (): TaskFiltersState => ({
  statusIds: new Set(STATUS_OPTIONS.map((o) => o.id)),
  teamName: null,
  unreadOnly: false,
});

export function taskMatchesStatus(
  task: { status: string; kanbanColumn?: 'review' | 'approved' },
  statusIds: Set<TaskStatusFilterId>
): boolean {
  if (statusIds.size === 0) return false;
  if (statusIds.size === STATUS_OPTIONS.length) return task.status !== 'deleted';

  const inTodo = task.status === 'pending' && !task.kanbanColumn;
  const inProgress = task.status === 'in_progress' && !task.kanbanColumn;
  const inDone = task.status === 'completed' && !task.kanbanColumn;
  const inReview = task.kanbanColumn === 'review';
  const inApproved = task.kanbanColumn === 'approved';

  return (
    (statusIds.has('todo') && inTodo) ||
    (statusIds.has('in_progress') && inProgress) ||
    (statusIds.has('done') && inDone) ||
    (statusIds.has('review') && inReview) ||
    (statusIds.has('approved') && inApproved)
  );
}

export function useReadStateSnapshot(): ReturnType<typeof getSnapshot> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getTaskUnreadCount(
  readState: ReturnType<typeof getSnapshot>,
  teamName: string,
  taskId: string,
  comments: { createdAt: string }[] | undefined
): number {
  return getUnreadCount(readState, teamName, taskId, comments ?? []);
}
