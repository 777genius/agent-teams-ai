const taskSemantics = require('../task-semantics.js');

const REVIEW_STATES = new Set(['none', 'review', 'needsFix', 'approved']);
const REVIEW_COLUMNS = new Set(['review', 'approved']);
const REVIEW_LIFECYCLE_EVENTS = new Set([
  'review_requested',
  'review_changes_requested',
  'review_approved',
  'review_started',
]);
const REVIEW_RESET_STATUSES = new Set(['in_progress', 'deleted']);
const BOARD_COLUMNS = new Set(['todo', 'in_progress', 'review', 'approved', 'done']);
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);

function normalizeReviewState(value) {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : '';
  return REVIEW_STATES.has(normalized) ? normalized : 'none';
}

function normalizeHistoryEvent(event) {
  if (!event || typeof event !== 'object') return { kind: 'other' };
  if (event.type === 'review_reset') return { kind: 'review_reset' };
  if (REVIEW_LIFECYCLE_EVENTS.has(event.type)) {
    // Raw events carry `to`; do not turn a malformed event into a real review state.
    return normalizeReviewState(event.to) === 'none' ? { kind: 'other' } : { kind: event.type };
  }
  if (event.type === 'status_changed' && TASK_STATUSES.has(event.to)) {
    return { kind: 'status_changed', to: event.to };
  }
  return { kind: event.type === 'task_created' ? 'task_created' : 'other' };
}

function normalizeTaskSemanticSnapshot(task, kanbanEntry) {
  const status = typeof task?.status === 'string' ? task.status.trim() : '';
  const column = kanbanEntry && BOARD_COLUMNS.has(kanbanEntry.column) ? kanbanEntry.column : null;
  return {
    key: String(task?.id ?? ''),
    // Controller readers validate task status. A malformed row must not become terminal.
    status: TASK_STATUSES.has(status) ? status : 'pending',
    reviewState: normalizeReviewState(task?.reviewState),
    history: (Array.isArray(task?.historyEvents) ? task.historyEvents : []).map(normalizeHistoryEvent),
    placement: column ? { column } : null,
  };
}

function getReviewStateFromHistory(task) {
  const snapshot = normalizeTaskSemanticSnapshot(task, null);
  return taskSemantics.resolveReviewHistory(snapshot.history);
}

function getEffectiveReviewState(task, kanbanEntry) {
  return taskSemantics.resolveReview(normalizeTaskSemanticSnapshot(task, kanbanEntry));
}

module.exports = {
  REVIEW_COLUMNS,
  REVIEW_LIFECYCLE_EVENTS,
  REVIEW_RESET_STATUSES,
  REVIEW_STATES,
  getEffectiveReviewState,
  getReviewStateFromHistory,
  normalizeReviewState,
  normalizeTaskSemanticSnapshot,
};
