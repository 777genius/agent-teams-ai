import type { TaskHistoryEvent, TeamReviewState, TeamTask, TeamTaskStatus } from '@shared/types';

/** Extract historyEvents from a task, defaulting to empty array. */
export function getTaskHistoryEvents(task: Pick<TeamTask, 'historyEvents'>): TaskHistoryEvent[] {
  return Array.isArray(task.historyEvents) ? task.historyEvents : [];
}

/** Derive the current task status from historyEvents. Falls back to task.status if no events. */
export function getDerivedTaskStatus(
  task: Pick<TeamTask, 'historyEvents' | 'status'>
): TeamTaskStatus {
  const events = getTaskHistoryEvents(task);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'task_created') return event.status;
    if (event.type === 'status_changed') return event.to;
  }
  return task.status;
}

/** Derive the current review state from historyEvents. */
export function getDerivedReviewStateFromHistory(
  task: Pick<TeamTask, 'historyEvents'>
): TeamReviewState | null {
  const events = getTaskHistoryEvents(task);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.type === 'review_requested' ||
      event.type === 'review_changes_requested' ||
      event.type === 'review_approved' ||
      event.type === 'review_completed' ||
      event.type === 'human_approved' ||
      event.type === 'review_started'
    ) {
      return event.to;
    }
    if (event.type === 'status_changed' && (event.to === 'in_progress' || event.to === 'deleted')) {
      return 'none';
    }
    if (event.type === 'status_changed' && event.to === 'pending') {
      for (let previousIndex = i - 1; previousIndex >= 0; previousIndex--) {
        const previous = events[previousIndex];
        if (
          previous.type === 'review_requested' ||
          previous.type === 'review_changes_requested' ||
          previous.type === 'review_approved' ||
          previous.type === 'review_completed' ||
          previous.type === 'human_approved' ||
          previous.type === 'review_started'
        ) {
          return previous.to === 'needsFix' ? 'needsFix' : 'none';
        }
        if (
          previous.type === 'task_created' ||
          (previous.type === 'status_changed' &&
            (previous.to === 'in_progress' ||
              previous.to === 'pending' ||
              previous.to === 'deleted'))
        ) {
          return 'none';
        }
      }
      return 'none';
    }
  }
  return null;
}

/**
 * Which stage the open review cycle is in: the lead's sign-off (second cycle of the
 * lead_then_human flow) or a regular reviewer cycle. Null when no review cycle is open.
 * Mirrors getCurrentReviewStage in agent-teams-controller/src/internal/reviewState.js.
 */
export function getCurrentReviewStage(
  task: Pick<TeamTask, 'historyEvents'>
): 'lead_signoff' | 'reviewer' | null {
  const events = getTaskHistoryEvents(task);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'review_requested') {
      return event.stage === 'lead_signoff' ? 'lead_signoff' : 'reviewer';
    }
    if (
      event.type === 'review_changes_requested' ||
      event.type === 'review_approved' ||
      event.type === 'review_completed' ||
      event.type === 'human_approved' ||
      event.type === 'task_created' ||
      (event.type === 'status_changed' &&
        (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted'))
    ) {
      return null;
    }
  }
  return null;
}

/** Derive the current review state from historyEvents. */
export function getDerivedReviewState(task: Pick<TeamTask, 'historyEvents'>): TeamReviewState {
  const derived = getDerivedReviewStateFromHistory(task);
  if (derived) return derived;
  return 'none';
}

/** Get a full workflow snapshot from historyEvents. */
export function getTaskWorkflowSnapshot(task: Pick<TeamTask, 'historyEvents' | 'status'>): {
  status: TeamTaskStatus;
  reviewState: TeamReviewState;
} {
  return {
    status: getDerivedTaskStatus(task),
    reviewState: getDerivedReviewState(task),
  };
}
