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
export function getDerivedReviewState(task: Pick<TeamTask, 'historyEvents'>): TeamReviewState {
  const events = getTaskHistoryEvents(task);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.type === 'review_requested' ||
      event.type === 'review_changes_requested' ||
      event.type === 'review_approved'
    ) {
      return event.to;
    }
    // A status_changed to in_progress after a review event resets review state
    if (event.type === 'status_changed' && event.to === 'in_progress') {
      return 'none';
    }
  }
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
