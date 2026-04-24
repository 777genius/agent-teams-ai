const REVIEW_STATES = new Set(['none', 'review', 'needsFix', 'approved']);
const REVIEW_COLUMNS = new Set(['review', 'approved']);
const REVIEW_LIFECYCLE_EVENTS = new Set([
  'review_requested',
  'review_changes_requested',
  'review_approved',
  'review_started',
]);
const REVIEW_RESET_STATUSES = new Set(['in_progress', 'deleted']);

function normalizeReviewState(value) {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : '';
  return REVIEW_STATES.has(normalized) ? normalized : 'none';
}

function eventReviewState(event) {
  if (!event || typeof event !== 'object' || !REVIEW_LIFECYCLE_EVENTS.has(event.type)) {
    return null;
  }
  return normalizeReviewState(event.to);
}

function derivePendingReviewState(events, startIndex) {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;

    const reviewState = eventReviewState(event);
    if (reviewState) {
      return reviewState === 'needsFix'
        ? { state: 'needsFix', source: 'history_pending_needs_fix' }
        : { state: 'none', source: 'history_pending_reset' };
    }

    if (
      event.type === 'task_created' ||
      (event.type === 'status_changed' &&
        (REVIEW_RESET_STATUSES.has(event.to) || event.to === 'pending'))
    ) {
      return { state: 'none', source: 'history_pending_reset' };
    }
  }

  return { state: 'none', source: 'history_pending_reset' };
}

function getReviewStateFromHistory(task) {
  const events = Array.isArray(task && task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;

    const reviewState = eventReviewState(event);
    if (reviewState) {
      return {
        state: reviewState,
        source: `history_${event.type}`,
      };
    }

    if (event.type === 'status_changed') {
      if (REVIEW_RESET_STATUSES.has(event.to)) {
        return {
          state: 'none',
          source: 'history_status_reset',
        };
      }
      if (event.to === 'pending') {
        return derivePendingReviewState(events, index);
      }
    }
  }

  return null;
}

function getEffectiveReviewState(task, kanbanEntry) {
  const historyState = getReviewStateFromHistory(task);
  if (historyState) {
    return historyState;
  }

  const status = typeof task?.status === 'string' ? task.status.trim() : '';
  const normalizeFallback = (state, source) => {
    const normalized = normalizeReviewState(state);
    if (normalized === 'none') {
      return null;
    }

    if (status === 'in_progress' || status === 'deleted') {
      return {
        state: 'none',
        source: `${source}_status_reset`,
      };
    }

    if (status === 'pending') {
      return normalized === 'needsFix'
        ? { state: 'needsFix', source: `${source}_pending_needs_fix` }
        : { state: 'none', source: `${source}_pending_reset` };
    }

    if (status === 'completed') {
      return normalized === 'review' || normalized === 'approved'
        ? { state: normalized, source }
        : { state: 'none', source: `${source}_completed_reset` };
    }

    return { state: normalized, source };
  };

  const persisted = normalizeReviewState(task && task.reviewState);
  const persistedFallback = normalizeFallback(persisted, 'task_review_state');
  if (persistedFallback) {
    return persistedFallback;
  }

  if (kanbanEntry && REVIEW_COLUMNS.has(kanbanEntry.column)) {
    const kanbanFallback = normalizeFallback(kanbanEntry.column, 'kanban_column');
    if (kanbanFallback) {
      return kanbanFallback;
    }
  }

  return {
    state: 'none',
    source: 'none',
  };
}

module.exports = {
  REVIEW_COLUMNS,
  REVIEW_LIFECYCLE_EVENTS,
  REVIEW_RESET_STATUSES,
  REVIEW_STATES,
  getEffectiveReviewState,
  getReviewStateFromHistory,
  normalizeReviewState,
};
