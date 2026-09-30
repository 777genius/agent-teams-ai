import { normalizeTaskHistoryEvents } from '@shared/utils/taskHistory';
import { resolveReview } from 'agent-teams-controller/task-semantics';

import type { TeamReviewState } from '@shared/types';

interface ReviewStateLike {
  reviewState?: TeamReviewState | null;
  historyEvents?: unknown[];
  kanbanColumn?: 'review' | 'approved' | null;
  status?: string | null;
}

export function normalizeReviewState(value: unknown): TeamReviewState {
  return value === 'review' || value === 'needsFix' || value === 'approved' ? value : 'none';
}

export function getReviewStateFromTask(task: ReviewStateLike): TeamReviewState {
  const status = task.status;
  return resolveReview({
    key: '',
    status:
      status === 'pending' || status === 'in_progress' || status === 'deleted'
        ? status
        : 'completed',
    reviewState: normalizeReviewState(task.reviewState),
    history: normalizeTaskHistoryEvents(task.historyEvents),
    placement:
      task.kanbanColumn === 'review' || task.kanbanColumn === 'approved'
        ? { column: task.kanbanColumn }
        : null,
  }).state;
}

export function getKanbanColumnFromReviewState(
  reviewState: TeamReviewState
): 'review' | 'approved' | undefined {
  return reviewState === 'review' || reviewState === 'approved' ? reviewState : undefined;
}

export function getTaskKanbanColumn(task: ReviewStateLike): 'review' | 'approved' | undefined {
  return getKanbanColumnFromReviewState(getReviewStateFromTask(task));
}

export function isApprovedTask(task: ReviewStateLike): boolean {
  return getReviewStateFromTask(task) === 'approved';
}

export function isReviewTask(task: ReviewStateLike): boolean {
  return getReviewStateFromTask(task) === 'review';
}

export function isNeedsFixTask(task: ReviewStateLike): boolean {
  return getReviewStateFromTask(task) === 'needsFix';
}
