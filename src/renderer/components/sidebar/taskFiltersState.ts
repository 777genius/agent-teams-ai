import { useSyncExternalStore } from 'react';

import { getSnapshot, getUnreadCount, subscribe } from '@renderer/services/commentReadStorage';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';

export type TaskStatusFilterId =
  | 'todo'
  | 'in_progress'
  | 'needs_fix'
  | 'done'
  | 'review'
  | 'approved';

export const STATUS_OPTIONS = [
  { id: 'todo', labelKey: 'todo', color: '#3b82f6' },
  { id: 'in_progress', labelKey: 'inProgress', color: '#eab308' },
  { id: 'needs_fix', labelKey: 'needsFix', color: '#f43f5e' },
  { id: 'done', labelKey: 'done', color: '#22c55e' },
  { id: 'review', labelKey: 'review', color: '#8b5cf6' },
  { id: 'approved', labelKey: 'approved', color: '#16a34a' },
] as const satisfies readonly { id: TaskStatusFilterId; labelKey: string; color: string }[];

export type ReadFilter = 'all' | 'unread' | 'read';

export interface TaskFiltersState {
  statusIds: Set<TaskStatusFilterId>;
  teamName: string | null;
  projectPath: string | null;
  /** @deprecated Use readFilter instead */
  unreadOnly: boolean;
  readFilter: ReadFilter;
}

export const defaultTaskFiltersState = (): TaskFiltersState => ({
  statusIds: new Set(STATUS_OPTIONS.map((o) => o.id)),
  teamName: null,
  projectPath: null,
  unreadOnly: false,
  readFilter: 'all',
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

  const kanbanColumn = getTeamTaskWorkflowColumn(task);
  const inNeedsFix = isTeamTaskNeedsFixActionable(task);
  const inTodo = task.status === 'pending' && !kanbanColumn && !inNeedsFix;
  const inProgress = task.status === 'in_progress' && !kanbanColumn && !inNeedsFix;
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
