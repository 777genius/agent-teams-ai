import { getReviewStateFromTask } from './reviewState';

import type { TeamReviewState } from '@shared/types';

export type TaskChangeStateBucket = 'approved' | 'review' | 'completed' | 'active';

interface TaskChangeStateLike {
  status?: string | null;
  reviewState?: TeamReviewState | null;
  historyEvents?: unknown[];
  kanbanColumn?: 'review' | 'approved' | null;
}

function getEffectiveReviewState(task: TaskChangeStateLike): TeamReviewState {
  return getReviewStateFromTask(task);
}

export function getTaskChangeStateBucket(task: TaskChangeStateLike): TaskChangeStateBucket {
  const reviewState = getEffectiveReviewState(task);
  if (reviewState === 'approved') return 'approved';
  if (reviewState === 'review') return 'review';
  return task.status === 'completed' ? 'completed' : 'active';
}

export function isTaskChangeSummaryCacheable(
  taskOrBucket: TaskChangeStateLike | TaskChangeStateBucket
): boolean {
  const bucket =
    typeof taskOrBucket === 'string' ? taskOrBucket : getTaskChangeStateBucket(taskOrBucket);
  return bucket === 'completed' || bucket === 'approved';
}

/**
 * Whether a task can display its file changes in the UI.
 * Unlike `isTaskChangeSummaryCacheable` (permanent-cache gate for terminal states),
 * this returns true for any task that could plausibly have changes:
 * in_progress, review, approved, completed — everything except pending/backlog.
 */
export function canDisplayTaskChanges(
  taskOrBucket: TaskChangeStateLike | TaskChangeStateBucket
): boolean {
  if (typeof taskOrBucket === 'string') {
    return taskOrBucket !== 'active';
  }
  const bucket = getTaskChangeStateBucket(taskOrBucket);
  if (bucket !== 'active') return true;
  // 'active' bucket includes both pending and in_progress — show for in_progress only
  return taskOrBucket.status === 'in_progress';
}
