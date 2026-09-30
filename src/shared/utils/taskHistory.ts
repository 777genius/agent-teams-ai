import { resolveReviewHistory } from 'agent-teams-controller/task-semantics';

import type { TaskHistoryEvent, TeamReviewState, TeamTask, TeamTaskStatus } from '@shared/types';
import type { NormalizedTaskHistoryEvent } from 'agent-teams-controller/task-semantics';

/** Extract historyEvents from a task, defaulting to empty array. */
export function getTaskHistoryEvents(task: Pick<TeamTask, 'historyEvents'>): TaskHistoryEvent[] {
  return Array.isArray(task.historyEvents) ? task.historyEvents : [];
}

/** Adapt persisted events without changing their append order or stored representation. */
export function normalizeTaskHistoryEvent(event: unknown): NormalizedTaskHistoryEvent {
  if (!event || typeof event !== 'object') return { kind: 'other' };
  const raw = event as Record<string, unknown>;
  switch (raw.type) {
    case 'task_created':
      return { kind: 'task_created' };
    case 'status_changed':
      return raw.to === 'pending' ||
        raw.to === 'in_progress' ||
        raw.to === 'completed' ||
        raw.to === 'deleted'
        ? { kind: 'status_changed', to: raw.to }
        : { kind: 'other' };
    case 'review_reset':
      return { kind: 'review_reset' };
    case 'review_requested':
    case 'review_started':
    case 'review_changes_requested':
    case 'review_approved': {
      const to = typeof raw.to === 'string' ? raw.to.trim() : '';
      return to === 'review' || to === 'needsFix' || to === 'approved'
        ? { kind: raw.type }
        : { kind: 'other' };
    }
    default:
      return { kind: 'other' };
  }
}

export function normalizeTaskHistoryEvents(
  events: readonly unknown[] | null | undefined
): NormalizedTaskHistoryEvent[] {
  return Array.isArray(events) ? events.map(normalizeTaskHistoryEvent) : [];
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
  return resolveReviewHistory(normalizeTaskHistoryEvents(task.historyEvents))?.state ?? null;
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
