const kanbanStore = require('./kanbanStore.js');
const tasks = require('./tasks.js');

function getKanbanState(context) {
  return kanbanStore.readKanbanState(context.paths, context.teamName);
}

function setKanbanColumn(context, taskId, column) {
  const canonicalTaskId = tasks.resolveTaskId(context, taskId);
  kanbanStore.setKanbanColumn(context.paths, context.teamName, canonicalTaskId, String(column));
  return getKanbanState(context);
}

function clearKanban(context, taskId, options) {
  const canonicalTaskId = tasks.resolveTaskId(context, taskId);
  kanbanStore.clearKanban(context.paths, context.teamName, canonicalTaskId, options);
  return getKanbanState(context);
}

function listReviewers(context) {
  return getKanbanState(context).reviewers;
}

function addReviewer(context, reviewer) {
  const state = getKanbanState(context);
  const next = new Set(state.reviewers);
  next.add(String(reviewer));
  kanbanStore.writeKanbanState(context.paths, context.teamName, {
    ...state,
    reviewers: [...next],
  });
  return listReviewers(context);
}

function removeReviewer(context, reviewer) {
  const state = getKanbanState(context);
  const next = state.reviewers.filter((entry) => entry !== reviewer);
  kanbanStore.writeKanbanState(context.paths, context.teamName, {
    ...state,
    reviewers: next,
  });
  return listReviewers(context);
}

function updateColumnOrder(context, columnId, orderedTaskIds) {
  const canonicalIds = orderedTaskIds.map((taskId) => tasks.resolveTaskId(context, taskId));
  return kanbanStore.updateColumnOrder(context.paths, context.teamName, columnId, canonicalIds);
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
