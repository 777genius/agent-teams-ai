export type TaskMutationWorkflowColumn = 'review' | 'approved';

export interface TaskMutationReviewSnapshot {
  status: string;
  reviewState?: unknown;
  historyEvents?: readonly unknown[];
  kanbanColumn?: unknown;
}

type TaskMutationReviewState = 'none' | 'review' | 'needsFix' | 'approved';

const REVIEW_EVENT_TYPES = new Set([
  'review_requested',
  'review_changes_requested',
  'review_approved',
  'review_started',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeReviewState(value: unknown): TaskMutationReviewState {
  return value === 'review' || value === 'needsFix' || value === 'approved' ? value : 'none';
}

function normalizeReviewStateForStatus(
  value: unknown,
  status: string
): TaskMutationReviewState | null {
  const reviewState = normalizeReviewState(value);
  if (reviewState === 'none') {
    return null;
  }
  if (status === 'in_progress' || status === 'deleted') {
    return 'none';
  }
  if (status === 'pending') {
    return reviewState === 'needsFix' ? 'needsFix' : 'none';
  }
  return reviewState;
}

function deriveReviewStateFromHistory(historyEvents: readonly unknown[]): unknown {
  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];
    if (!isRecord(event) || typeof event.type !== 'string') {
      continue;
    }
    if (REVIEW_EVENT_TYPES.has(event.type)) {
      return event.to;
    }
    if (event.type === 'status_changed' && (event.to === 'in_progress' || event.to === 'deleted')) {
      return 'none';
    }
    if (event.type !== 'status_changed' || event.to !== 'pending') {
      continue;
    }

    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = historyEvents[previousIndex];
      if (!isRecord(previous) || typeof previous.type !== 'string') {
        continue;
      }
      if (REVIEW_EVENT_TYPES.has(previous.type)) {
        return previous.to === 'needsFix' ? 'needsFix' : 'none';
      }
      if (
        previous.type === 'task_created' ||
        (previous.type === 'status_changed' &&
          (previous.to === 'in_progress' || previous.to === 'pending' || previous.to === 'deleted'))
      ) {
        return 'none';
      }
    }
    return 'none';
  }
  return null;
}

function resolveReviewState(snapshot: TaskMutationReviewSnapshot): TaskMutationReviewState {
  if (snapshot.historyEvents && snapshot.historyEvents.length > 0) {
    const derived = deriveReviewStateFromHistory(snapshot.historyEvents);
    if (derived !== null) {
      return normalizeReviewStateForStatus(derived, snapshot.status) ?? 'none';
    }
  }

  const explicit = normalizeReviewStateForStatus(snapshot.reviewState, snapshot.status);
  if (explicit) {
    return explicit;
  }
  if (snapshot.kanbanColumn === 'review' || snapshot.kanbanColumn === 'approved') {
    return normalizeReviewStateForStatus(snapshot.kanbanColumn, snapshot.status) ?? 'none';
  }
  return 'none';
}

function resolveWorkflowColumn(
  status: string,
  reviewState: TaskMutationReviewState,
  kanbanColumn: unknown
): TaskMutationWorkflowColumn | undefined {
  if (status === 'deleted' || status === 'pending') {
    return undefined;
  }
  if (kanbanColumn === 'approved' || kanbanColumn === 'review') {
    return kanbanColumn;
  }
  if (reviewState === 'approved' || reviewState === 'review') {
    return reviewState;
  }
  return undefined;
}

export function resolveTaskMutationWorkflowColumn(
  snapshot: TaskMutationReviewSnapshot
): TaskMutationWorkflowColumn | undefined {
  const kanbanWorkflowColumn = resolveWorkflowColumn(
    snapshot.status,
    'none',
    snapshot.kanbanColumn
  );
  if (kanbanWorkflowColumn) {
    return kanbanWorkflowColumn;
  }

  return resolveWorkflowColumn(
    snapshot.status,
    resolveReviewState(snapshot),
    snapshot.kanbanColumn
  );
}
