import type { TaskHistoryEvent, TeamReviewState } from '@shared/types';

import { getDerivedReviewState } from './taskHistory';

export type TaskChangeStateBucket = 'approved' | 'review' | 'completed' | 'active';

interface TaskChangeStateLike {
  status?: string | null;
  reviewState?: TeamReviewState | null;
  historyEvents?: unknown[];
  kanbanColumn?: 'review' | 'approved' | null;
}

function normalizeReviewState(value: unknown): TeamReviewState {
  return value === 'review' || value === 'needsFix' || value === 'approved' ? value : 'none';
}

function getEffectiveReviewState(task: TaskChangeStateLike): TeamReviewState {
  if (Array.isArray(task.historyEvents) && task.historyEvents.length > 0) {
    return getDerivedReviewState({ historyEvents: task.historyEvents as TaskHistoryEvent[] });
  }

  const explicit = normalizeReviewState(task.reviewState);
  if (explicit !== 'none') {
    return explicit;
  }

  if (task.kanbanColumn === 'review' || task.kanbanColumn === 'approved') {
    return task.kanbanColumn;
  }

  return 'none';
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
