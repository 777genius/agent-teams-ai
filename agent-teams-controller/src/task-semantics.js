/* global module */
// Normalized board facts only. Adapters own parsing, identity, and authoritative reads.
const REVIEW_EVENT_STATES = Object.freeze({
  review_requested: 'review',
  review_started: 'review',
  review_changes_requested: 'needsFix',
  review_approved: 'approved',
});
const STATUS_COLUMNS = Object.freeze({
  todo: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
});
const BOARD_COLUMNS = new Set(['todo', 'in_progress', 'review', 'approved', 'done']);

function historicalReview(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'review_reset') {
      return { state: 'none', source: 'history_review_reset' };
    }
    if (REVIEW_EVENT_STATES[event.kind]) {
      return { state: REVIEW_EVENT_STATES[event.kind], source: `history_${event.kind}` };
    }
    if (event.kind !== 'status_changed') continue;
    if (event.to === 'in_progress' || event.to === 'deleted') {
      return { state: 'none', source: 'history_status_reset' };
    }
    if (event.to !== 'pending') continue;
    // A pending transition closes the current cycle unless the preceding
    // review event explicitly requested fixes. Append order is authoritative.
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const earlier = events[previous];
      if (earlier.kind === 'review_reset') break;
      if (REVIEW_EVENT_STATES[earlier.kind]) {
        return {
          state: REVIEW_EVENT_STATES[earlier.kind] === 'needsFix' ? 'needsFix' : 'none',
          source: REVIEW_EVENT_STATES[earlier.kind] === 'needsFix'
            ? 'history_pending_needs_fix'
            : 'history_pending_reset',
        };
      }
      if (earlier.kind === 'task_created' ||
        (earlier.kind === 'status_changed' &&
          (earlier.to === 'in_progress' || earlier.to === 'pending' || earlier.to === 'deleted'))) {
        break;
      }
    }
    return { state: 'none', source: 'history_pending_reset' };
  }
  return null;
}

function reviewForStatus(state, status, source) {
  if (state === 'none') return null;
  if (status === 'in_progress' || status === 'deleted') {
    return { state: 'none', source: `${source}_status_reset` };
  }
  if (status === 'pending') {
    return {
      state: state === 'needsFix' ? 'needsFix' : 'none',
      source: `${source}_pending_${state === 'needsFix' ? 'needs_fix' : 'reset'}`,
    };
  }
  return { state, source };
}

function resolveReview(snapshot) {
  const historical = historicalReview(snapshot.history);
  if (historical) {
    const constrained = reviewForStatus(historical.state, snapshot.status, historical.source);
    return constrained || historical;
  }
  const persisted = reviewForStatus(snapshot.reviewState, snapshot.status, 'task_review_state');
  if (persisted) return persisted;
  const placement = snapshot.placement?.column;
  if (placement === 'review' || placement === 'approved') {
    return reviewForStatus(placement, snapshot.status, 'kanban_column');
  }
  return { state: 'none', source: 'none' };
}

function resolveTaskSemantics(snapshot) {
  const review = resolveReview(snapshot);
  const placement = snapshot.placement?.column;
  const deleted = snapshot.status === 'deleted';
  const workflowColumn = deleted || snapshot.status === 'pending'
    ? null
    : placement === 'review' || placement === 'approved'
      ? placement
      : review.state === 'review' || review.state === 'approved'
        ? review.state
        : null;
  const visibleColumn = deleted
    ? null
    : placement && BOARD_COLUMNS.has(placement)
      ? placement
      : workflowColumn || (snapshot.status === 'completed'
        ? 'done'
        : snapshot.status === 'in_progress' ? 'in_progress' : 'todo');
  const needsFixActionable = !deleted && workflowColumn === null && review.state === 'needsFix';
  const finishedForDependency = workflowColumn === 'approved' ||
    (workflowColumn !== 'review' && !needsFixActionable && snapshot.status === 'completed');
  return {
    review,
    workflowColumn,
    visibleColumn,
    needsFixActionable,
    finishedForDependency,
    terminalForActionableWork: deleted || finishedForDependency,
  };
}

function resolveBlockers(blockers) {
  let unknown = false;
  for (const blocker of blockers) {
    if (blocker.kind === 'unknown') {
      unknown = true;
      continue;
    }
    if (blocker.kind === 'known_absent' || blocker.task.status === 'deleted') continue;
    if (!resolveTaskSemantics(blocker.task).finishedForDependency) {
      return { allowed: false, reason: 'blocked_open_dependency' };
    }
  }
  return unknown
    ? { allowed: false, reason: 'insufficient_knowledge' }
    : { allowed: true, reason: 'allowed' };
}

function planColumnTransition({ task, targetColumn, blockers }) {
  const current = resolveTaskSemantics(task);
  if (!BOARD_COLUMNS.has(targetColumn)) {
    return { allowed: false, reason: 'state_conflict' };
  }
  if (targetColumn === 'review' &&
    (task.status !== 'completed' ||
      current.visibleColumn === 'approved' ||
      current.review.state === 'approved')) {
    return { allowed: false, reason: 'state_conflict' };
  }
  if (targetColumn === 'approved' && task.status !== 'completed') {
    return { allowed: false, reason: 'state_conflict' };
  }
  const status = STATUS_COLUMNS[targetColumn];
  if (status) {
    // A review event hidden by the current status can become active again after completion.
    // Decide the reset against the target status as well as the current display state.
    const reviewAfterCompletion = targetColumn === 'done'
      ? resolveReview({ ...task, status: 'completed' })
      : null;
    const resetReview = targetColumn === 'done' &&
      current.review.source !== 'history_review_reset' &&
      (current.workflowColumn !== null || current.review.state !== 'none' ||
        reviewAfterCompletion.state !== 'none');
    if (((status === 'in_progress' || status === 'completed') && status !== task.status) || resetReview) {
      const dependency = resolveBlockers(blockers);
      if (!dependency.allowed) return dependency;
    }
    if (current.visibleColumn === targetColumn && task.status === status &&
      task.placement === null && !resetReview) {
      return { allowed: true, reason: 'allowed', transition: { kind: 'none' } };
    }
    return {
      allowed: true,
      reason: 'allowed',
      transition: {
        kind: 'set_status',
        status,
        clearPlacement: task.placement !== null,
        resetReview,
      },
    };
  }
  if (targetColumn === 'review') {
    if (current.visibleColumn === 'review' && current.review.state === 'review') {
      return { allowed: true, reason: 'allowed', transition: { kind: 'none' } };
    }
    return { allowed: true, reason: 'allowed', transition: { kind: 'request_review' } };
  }
  if (current.visibleColumn === 'approved' &&
    (current.review.state === 'approved' ||
      (current.review.state === 'none' && task.placement?.column === 'approved'))) {
    return { allowed: true, reason: 'allowed', transition: { kind: 'none' } };
  }
  if (current.workflowColumn !== null &&
    current.review.state !== 'review' && current.review.state !== 'approved') {
    return { allowed: false, reason: 'state_conflict' };
  }
  return {
    allowed: true,
    reason: 'allowed',
    transition: {
      kind: current.review.state === 'review' || current.review.state === 'approved'
        ? 'approve_review'
        : 'manual_approve',
    },
  };
}

function resolveColumnOrder({
  canonicalKeys,
  explicitKeys,
  canonicalColumnComplete,
  sourceRevision,
  explicitOrderRevision,
}) {
  if (!canonicalColumnComplete || !sourceRevision || sourceRevision !== explicitOrderRevision) {
    return { allowed: false, reason: 'insufficient_knowledge' };
  }
  const canonical = new Set(canonicalKeys);
  if (canonical.size !== canonicalKeys.length) {
    return { allowed: false, reason: 'state_conflict' };
  }
  const ordered = [];
  const seen = new Set();
  for (const key of explicitKeys) {
    if (canonical.has(key) && !seen.has(key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  for (const key of canonicalKeys) {
    if (!seen.has(key)) ordered.push(key);
  }
  return { allowed: true, reason: 'allowed', orderedKeys: ordered };
}

module.exports = {
  resolveReviewHistory: historicalReview,
  resolveReview,
  resolveTaskSemantics,
  resolveBlockers,
  planColumnTransition,
  resolveColumnOrder,
};
