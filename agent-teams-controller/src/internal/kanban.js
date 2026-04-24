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
    const allowedInternalTransitions = new Set(['request_changes', 'rollback', 'status_reset', 'delete', 'restore']);
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

function updateColumnOrder(context, columnId, orderedTaskIds) {
  return withTeamBoardLock(context.paths, () => {
    const canonicalIds = orderedTaskIds.map((taskId) => tasks.resolveTaskId(context, taskId));
    return kanbanStore.updateColumnOrder(context.paths, context.teamName, columnId, canonicalIds);
  });
}

module.exports = {
  getKanbanState,
  setKanbanColumn,
  clearKanban,
  listReviewers,
  addReviewer,
  removeReviewer,
  updateColumnOrder,
};
