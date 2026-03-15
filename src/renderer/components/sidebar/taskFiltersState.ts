import { useSyncExternalStore } from 'react';

import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';

export type TaskStatusFilterId =
  | 'todo'
  | 'in_progress'
  | 'needs_fix'
  | 'done'
  | 'review'
  | 'approved';

export const STATUS_OPTIONS: { id: TaskStatusFilterId; label: string; color: string }[] = [
  { id: 'todo', label: 'TODO', color: '#3b82f6' },
  { id: 'in_progress', label: 'IN PROGRESS', color: '#eab308' },
  { id: 'needs_fix', label: 'NEEDS FIXES', color: '#f43f5e' },
  { id: 'done', label: 'DONE', color: '#22c55e' },
  { id: 'review', label: 'REVIEW', color: '#8b5cf6' },
  { id: 'approved', label: 'APPROVED', color: '#16a34a' },
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
  task: {
    status: string;
    reviewState?: 'none' | 'review' | 'needsFix' | 'approved';
    kanbanColumn?: 'review' | 'approved';
  },
  statusIds: Set<TaskStatusFilterId>
): boolean {
  if (statusIds.size === 0) return false;
  if (statusIds.size === STATUS_OPTIONS.length) return task.status !== 'deleted';

  const kanbanColumn = getTaskKanbanColumn(task);
  const inNeedsFix = task.reviewState === 'needsFix';
  const inTodo = task.status === 'pending' && !kanbanColumn && !inNeedsFix;
  const inProgress = task.status === 'in_progress' && !kanbanColumn;
  const inDone = task.status === 'completed' && !kanbanColumn && !inNeedsFix;
  const inReview = kanbanColumn === 'review';
  const inApproved = kanbanColumn === 'approved';

  return (
    (statusIds.has('todo') && inTodo) ||
    (statusIds.has('in_progress') && inProgress) ||
    (statusIds.has('needs_fix') && inNeedsFix) ||
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
  comments: { id?: string; createdAt: string }[] | undefined
): number {
  return getUnreadCount(readState, teamName, taskId, comments ?? []);
}
