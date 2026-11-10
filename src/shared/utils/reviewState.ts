import { getDerivedReviewStateFromHistory } from '@shared/utils/taskHistory';

import type { TaskHistoryEvent, TeamReviewState } from '@shared/types';

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
  const fallbackStatus = typeof task.status === 'string' ? task.status : null;
  const normalizeForStatus = (value: unknown): TeamReviewState | null => {
    const explicit = normalizeReviewState(value);
    if (explicit === 'none') return null;

    if (fallbackStatus === 'in_progress' || fallbackStatus === 'deleted') {
      return 'none';
    }
    if (fallbackStatus === 'pending') {
      return explicit === 'needsFix' ? 'needsFix' : 'none';
    }
    if (fallbackStatus === 'completed') {
      return explicit === 'review' || explicit === 'approved' || explicit === 'needsFix'
        ? explicit
        : 'none';
    }
    return explicit;
  };

  // Prefer derivation from historyEvents when available
  if (Array.isArray(task.historyEvents) && task.historyEvents.length > 0) {
    const derived = getDerivedReviewStateFromHistory({
      historyEvents: task.historyEvents as TaskHistoryEvent[],
    });
    if (derived !== null) {
      return normalizeForStatus(derived) ?? 'none';
    }
  }

  const explicit = normalizeForStatus(task.reviewState);
  if (explicit) return explicit;

  if (task.kanbanColumn === 'review' || task.kanbanColumn === 'approved') {
    return normalizeForStatus(task.kanbanColumn) ?? 'none';
  }

  return 'none';
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
