import type { TaskHistoryEvent, TeamReviewState, TeamTask, TeamTaskStatus } from '@shared/types';

/** Shared event vocabulary; raw worker records are classified without trusting other fields. */
export function isTaskReviewDecisionEventType(type: unknown): boolean {
  return (
    type === 'review_changes_requested' ||
    type === 'review_approved' ||
    type === 'review_disapproved'
  );
}

export function isTaskReviewLifecycleEventType(type: unknown): boolean {
  return (
    type === 'review_requested' || type === 'review_started' || isTaskReviewDecisionEventType(type)
  );
}

function isReviewLifecycleEvent(
  event: TaskHistoryEvent
): event is Extract<TaskHistoryEvent, { to: TeamReviewState }> {
  return isTaskReviewLifecycleEventType(event.type);
}

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
    if (isReviewLifecycleEvent(event)) {
      return event.to;
    }
    if (event.type === 'status_changed' && (event.to === 'in_progress' || event.to === 'deleted')) {
      return 'none';
    }
    if (event.type === 'status_changed' && event.to === 'pending') {
      for (let previousIndex = i - 1; previousIndex >= 0; previousIndex--) {
        const previous = events[previousIndex];
        if (isReviewLifecycleEvent(previous)) {
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
