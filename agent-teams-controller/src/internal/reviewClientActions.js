const kanban = require('./kanban.js');
const review = require('./review.js');
const reviewState = require('./reviewState.js');
const tasks = require('./tasks.js');
const { withTeamBoardLock } = require('./boardLock.js');

function currentReviewState(context, task) {
  const entry = kanban.getKanbanState(context).tasks?.[task.id];
  return reviewState.getEffectiveReviewState(task, entry).state;
}

/** The composition supplies this authority; no action payload can grant it. */
function assertHumanContext(context) {
  if (context.allowUserMessageSender !== true) throw new Error('Trusted user action required');
}

/** Shared desktop/Host routing of a human board decision under the canonical board lock. */
function approveReviewFromUser(context, taskId, flags = {}) {
  assertHumanContext(context);
  return withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    const state = currentReviewState(context, task);
    if (kanban.isHumanApprovalFlow(context) || state === 'reviewed') {
      return review.approveAsHuman(context, task.id);
    }
    if (state !== 'review' && state !== 'approved') {
      kanban.setKanbanColumn(context, task.id, 'approved', { transition: 'manual_approve' });
      return tasks.getTask(context, task.id);
    }
    return review.approveReview(context, task.id, { ...flags, from: flags.from || 'user' });
  });
}

function requestChangesFromUser(context, taskId, flags = {}) {
  assertHumanContext(context);
  return withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    const state = currentReviewState(context, task);
    const decision = [...(task.historyEvents || [])].reverse().find((event) =>
      event.type === 'review_requested' || reviewState.REVIEW_LIFECYCLE_EVENTS.has(event.type)
    );
    const retryHumanRejection = (task.status === 'completed' || task.status === 'pending') &&
      state === 'needsFix' && decision?.type === 'review_changes_requested' && decision.actor === 'user';
    if (kanban.isHumanApprovalFlow(context) || state === 'reviewed' || retryHumanRejection) {
      return review.requestChangesAsHuman(context, task.id, flags);
    }
    return review.requestChanges(context, task.id, { ...flags, from: flags.from || 'user' });
  });
}

module.exports = { approveReviewFromUser, requestChangesFromUser };
