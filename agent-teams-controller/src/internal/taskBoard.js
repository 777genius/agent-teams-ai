const kanban = require('./kanban.js');
const review = require('./review.js');
const tasks = require('./tasks.js');

// Application boundary for task-board lifecycle writes.
// Keep this thin so existing task, review, and kanban behavior remains stable.

function createTask(context, flags) {
  return tasks.createTask(context, flags);
}

function reconcileTaskCreation(context, flags) {
  return tasks.reconcileTaskCreation(context, flags);
}

function getTask(context, taskId) {
  return tasks.getTask(context, taskId);
}

function getTaskComment(context, taskId, commentId) {
  return tasks.getTaskComment(context, taskId, commentId);
}

function listTasks(context) {
  return tasks.listTasks(context);
}

function listTaskInventory(context, filters) {
  return tasks.listTaskInventory(context, filters);
}

function listDeletedTasks(context) {
  return tasks.listDeletedTasks(context);
}

function resolveTaskId(context, taskRef) {
  return tasks.resolveTaskId(context, taskRef);
}

function setTaskStatus(context, taskId, status, actor) {
  return tasks.setTaskStatus(context, taskId, status, actor);
}

function startTask(context, taskId, actor) {
  return tasks.startTask(context, taskId, actor);
}

function completeTask(context, taskId, actor) {
  return tasks.completeTask(context, taskId, actor);
}

function softDeleteTask(context, taskId, actor) {
  return tasks.softDeleteTask(context, taskId, actor);
}

function restoreTask(context, taskId, actor) {
  return tasks.restoreTask(context, taskId, actor);
}

function setTaskOwner(context, taskId, owner, actor) {
  return tasks.setTaskOwner(context, taskId, owner, actor);
}

function updateTaskFields(context, taskId, fields) {
  return tasks.updateTaskFields(context, taskId, fields);
}

function addTaskComment(context, taskId, flags) {
  return tasks.addTaskComment(context, taskId, flags);
}

function attachTaskFile(context, taskId, flags) {
  return tasks.attachTaskFile(context, taskId, flags);
}

function attachCommentFile(context, taskId, commentId, flags) {
  return tasks.attachCommentFile(context, taskId, commentId, flags);
}

function addTaskAttachmentMeta(context, taskId, meta) {
  return tasks.addTaskAttachmentMeta(context, taskId, meta);
}

function removeTaskAttachment(context, taskId, attachmentId) {
  return tasks.removeTaskAttachment(context, taskId, attachmentId);
}

function setNeedsClarification(context, taskId, value) {
  return tasks.setNeedsClarification(context, taskId, value);
}

function linkTask(context, taskId, targetId, linkType) {
  return tasks.linkTask(context, taskId, targetId, linkType);
}

function unlinkTask(context, taskId, targetId, linkType) {
  return tasks.unlinkTask(context, taskId, targetId, linkType);
}

function memberBriefing(context, memberName, options) {
  return tasks.memberBriefing(context, memberName, options);
}

function leadBriefing(context) {
  return tasks.leadBriefing(context);
}

function taskBriefing(context, memberName) {
  return tasks.taskBriefing(context, memberName);
}

function getKanbanState(context) {
  return kanban.getKanbanState(context);
}

function setKanbanColumn(context, taskId, column, options) {
  return kanban.setKanbanColumn(context, taskId, column, options);
}

function clearKanban(context, taskId, options) {
  return kanban.clearKanban(context, taskId, options);
}

function listReviewers(context) {
  return kanban.listReviewers(context);
}

function addReviewer(context, reviewer) {
  return kanban.addReviewer(context, reviewer);
}

function removeReviewer(context, reviewer) {
  return kanban.removeReviewer(context, reviewer);
}

function updateColumnOrder(context, columnId, orderedTaskIds) {
  return kanban.updateColumnOrder(context, columnId, orderedTaskIds);
}

function requestReview(context, taskId, flags) {
  return review.requestReview(context, taskId, flags);
}

function startReview(context, taskId, flags) {
  return review.startReview(context, taskId, flags);
}

function approveReview(context, taskId, flags) {
  return review.approveReview(context, taskId, flags);
}

function requestChanges(context, taskId, flags) {
  return review.requestChanges(context, taskId, flags);
}

module.exports = {
  addReviewer,
  addTaskAttachmentMeta,
  addTaskComment,
  approveReview,
  attachCommentFile,
  attachTaskFile,
  clearKanban,
  completeTask,
  createTask,
  getKanbanState,
  getTask,
  getTaskComment,
  leadBriefing,
  linkTask,
  listDeletedTasks,
  listReviewers,
  listTaskInventory,
  listTasks,
  memberBriefing,
  removeReviewer,
  removeTaskAttachment,
  reconcileTaskCreation,
  requestChanges,
  requestReview,
  resolveTaskId,
  restoreTask,
  setKanbanColumn,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  softDeleteTask,
  startReview,
  startTask,
  taskBriefing,
  unlinkTask,
  updateColumnOrder,
  updateTaskFields,
};
