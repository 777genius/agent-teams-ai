const kanbanStore = require('./kanbanStore.js');
const tasks = require('./tasks.js');
const reviewStateHelpers = require('./reviewState.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const { withTeamBoardLock } = require('./boardLock.js');

function getEffectiveReviewState(context, task) {
  const state = getKanbanState(context);
  const entry = state.tasks ? state.tasks[task.id] : undefined;
  return reviewStateHelpers.getEffectiveReviewState(task, entry).state;
}

function assertKanbanColumnAllowed(context, task, column, options = {}) {
  const transition = typeof options.transition === 'string' ? options.transition : 'direct';
  const label = `#${task.displayId || task.id}`;

  if (task.status === 'deleted') {
    throw new Error(`Task ${label} is deleted`);
  }
  if (task.status !== 'completed') {
    throw new Error(`Task ${label} must be completed before moving to ${String(column).toUpperCase()} column`);
  }

  const reviewState = getEffectiveReviewState(context, task);
  if (column === 'review') {
    if (transition === 'request_review') {
      if (reviewState === 'approved') {
        throw new Error(`Task ${label} is already approved; reopen work before requesting another review`);
      }
      return;
    }
    if (reviewState !== 'review') {
      throw new Error(`Task ${label} must be in review before moving to REVIEW column; use review_request first`);
    }
    return;
  }

  if (column === 'approved') {
    if (isHumanApprovalFlow(context) &&
        (transition === 'manual_approve' || transition === 'approve_review')) {
      throw new Error('Human approval required: use review_complete for AI review; only the app user may approve');
    }
    if (transition === 'manual_approve') {
      if (reviewState !== 'none') {
        throw new Error(
          `Task ${label} is already in reviewState=${reviewState}; use review_approve instead`
        );
      }
      return;
    }
    if (transition === 'approve_review') {
      if (reviewState !== 'review' && reviewState !== 'approved') {
        throw new Error(`Task ${label} must be in review before approval`);
      }
      return;
    }
    if (reviewState !== 'approved') {
      throw new Error(`Task ${label} must already be approved before repairing APPROVED column; use review_approve first`);
    }
  }
}

function getKanbanState(context) {
  return kanbanStore.readKanbanState(context.paths, context.teamName);
}

function setKanbanColumn(context, taskId, column, options = {}) {
  return withTeamBoardLock(context.paths, () => {
    const canonicalTaskId = tasks.resolveTaskId(context, taskId);
    const task = tasks.getTask(context, canonicalTaskId);
    assertKanbanColumnAllowed(context, task, String(column), options);
    kanbanStore.setKanbanColumn(context.paths, context.teamName, canonicalTaskId, String(column));
    return getKanbanState(context);
  });
}

function clearKanban(context, taskId, options) {
  return withTeamBoardLock(context.paths, () => {
    const canonicalTaskId = tasks.resolveTaskId(context, taskId);
    const task = tasks.getTask(context, canonicalTaskId);
    const state = getKanbanState(context);
    const hasTaskEntry = Boolean(state.tasks && state.tasks[canonicalTaskId]);
    const hasColumnOrderRef =
      state.columnOrder &&
      typeof state.columnOrder === 'object' &&
      Object.values(state.columnOrder).some(
        (orderedTaskIds) =>
          Array.isArray(orderedTaskIds) &&
          orderedTaskIds.some((entry) => String(entry) === String(canonicalTaskId))
      );
    if (!hasTaskEntry && !hasColumnOrderRef) {
      return state;
    }
    const transition = options && typeof options.transition === 'string' ? options.transition : 'direct';
    const allowedInternalTransitions = new Set(['request_changes', 'review_complete', 'rollback', 'status_reset', 'delete', 'restore']);
    const reviewState = getEffectiveReviewState(context, task);
    if (transition === 'direct' && reviewState !== 'none') {
      throw new Error(
        `Task #${task.displayId || task.id} is in reviewState=${reviewState}; use review tools or task status transitions instead of kanban_clear`
      );
    }
    if (transition !== 'direct' && !allowedInternalTransitions.has(transition)) {
      throw new Error(`Invalid kanban clear transition: ${transition}`);
    }
    kanbanStore.clearKanban(context.paths, context.teamName, canonicalTaskId, options);
    return getKanbanState(context);
  });
}

function listReviewers(context) {
  return getKanbanState(context).reviewers;
}

function addReviewer(context, reviewer) {
  return withTeamBoardLock(context.paths, () => {
    const resolvedReviewer = runtimeHelpers.assertExplicitTeamMemberName(context.paths, reviewer, 'reviewer', {
      allowLeadAliases: true,
    });
    const state = getKanbanState(context);
    const next = new Set(state.reviewers);
    next.add(String(resolvedReviewer));
    kanbanStore.writeKanbanState(context.paths, context.teamName, {
      ...state,
      reviewers: [...next],
    });
    return listReviewers(context);
  });
}

function removeReviewer(context, reviewer) {
  return withTeamBoardLock(context.paths, () => {
    const state = getKanbanState(context);
    const resolvedReviewer = runtimeHelpers.resolveExplicitTeamMemberName(context.paths, reviewer, {
      allowLeadAliases: true,
    });
    const reviewerNames = new Set(
      [reviewer, resolvedReviewer].filter((entry) => typeof entry === 'string' && entry.trim())
    );
    const next = state.reviewers.filter((entry) => !reviewerNames.has(entry));
    kanbanStore.writeKanbanState(context.paths, context.teamName, {
      ...state,
      reviewers: next,
    });
    return listReviewers(context);
  });
}

function isHumanApprovalFlow(context) {
  return kanbanStore.isHumanApprovalFlow(getKanbanState(context));
}

/**
 * Desktop user action only. `settings` may carry reviewFlow and/or reviewFlowPrompt;
 * omitted keys keep their persisted value and an empty prompt clears it.
 */
function setReviewFlowSettings(context, settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('review flow settings must be an object');
  }
  const hasFlow = settings.reviewFlow !== undefined;
  const hasPrompt = settings.reviewFlowPrompt !== undefined;
  if (!hasFlow && !hasPrompt) throw new Error('review flow settings are empty');
  if (hasFlow && !kanbanStore.isReviewFlow(settings.reviewFlow)) {
    throw new Error(`reviewFlow must be one of: ${kanbanStore.REVIEW_FLOWS.join(', ')}`);
  }
  const nextPrompt = hasPrompt ? kanbanStore.normalizeReviewFlowPrompt(settings.reviewFlowPrompt) : undefined;
  return withTeamBoardLock(context.paths, () => {
    const state = getKanbanState(context);
    const next = { ...state };
    if (hasFlow) next.reviewFlow = settings.reviewFlow;
    if (hasPrompt) {
      if (nextPrompt) next.reviewFlowPrompt = nextPrompt;
      else delete next.reviewFlowPrompt;
    }
    if (next.reviewFlow === state.reviewFlow && next.reviewFlowPrompt === state.reviewFlowPrompt) {
      return state;
    }
    kanbanStore.writeKanbanState(context.paths, context.teamName, next);
    return getKanbanState(context);
  });
}

function updateColumnOrder(context, columnId, orderedTaskIds) {
  return withTeamBoardLock(context.paths, () => {
    const canonicalIds = orderedTaskIds.map((taskId) => tasks.resolveTaskId(context, taskId));
    return kanbanStore.updateColumnOrder(context.paths, context.teamName, columnId, canonicalIds);
  });
}

module.exports = {
  getKanbanState,
  setKanbanColumn,
  isHumanApprovalFlow,
  setReviewFlowSettings,
  clearKanban,
  listReviewers,
  addReviewer,
  removeReviewer,
  updateColumnOrder,
};
