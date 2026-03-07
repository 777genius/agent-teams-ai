const kanban = require('./kanban.js');
const messages = require('./messages.js');
const tasks = require('./tasks.js');
const { wrapAgentBlock } = require('./agentBlocks.js');

function getReviewer(context, flags) {
  if (typeof flags.reviewer === 'string' && flags.reviewer.trim()) {
    return flags.reviewer.trim();
  }
  const state = kanban.getKanbanState(context);
  return typeof state.reviewers[0] === 'string' && state.reviewers[0].trim()
    ? state.reviewers[0].trim()
    : null;
}

function requestReview(context, taskId, flags = {}) {
  const task = tasks.getTask(context, taskId);
  if (task.status !== 'completed') {
    throw new Error(`Task #${task.displayId || task.id} must be completed before review`);
  }

  const from =
    typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'team-lead';
  const reviewer = getReviewer(context, flags);

  try {
    kanban.setKanbanColumn(context, task.id, 'review');
    if (!reviewer) {
      return tasks.getTask(context, task.id);
    }

    messages.sendMessage(context, {
      to: reviewer,
      from,
      text:
        `Please review task #${task.displayId || task.id}.\n\n` +
        wrapAgentBlock(
          `When approved, use MCP tool review_approve:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", notifyOwner: true }\n\n` +
            `If changes are needed, use MCP tool review_request_changes:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", comment: "..." }`
        ),
      summary: `Review request for #${task.displayId || task.id}`,
      source: 'system_notification',
    });
    return tasks.getTask(context, task.id);
  } catch (error) {
    try {
      kanban.clearKanban(context, task.id);
    } catch {
      // Best-effort rollback: keep the original error.
    }
    throw error;
  }
}

function approveReview(context, taskId, flags = {}) {
  const task = tasks.getTask(context, taskId);
  const from =
    typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'team-lead';
  const note = typeof flags.note === 'string' && flags.note.trim() ? flags.note.trim() : 'Approved';

  kanban.setKanbanColumn(context, task.id, 'approved');
  tasks.addTaskComment(context, task.id, {
    text: note,
    from,
    type: 'review_approved',
  });

  if ((flags.notify === true || flags['notify-owner'] === true) && task.owner) {
    messages.sendMessage(context, {
      to: task.owner,
      from,
      text:
        note && note !== 'Approved'
          ? `Task ${task.displayId || task.id} approved.\n\n${note}`
          : `Task ${task.displayId || task.id} approved.`,
      summary: `Approved ${task.displayId || task.id}`,
      source: 'system_notification',
    });
  }

  return tasks.getTask(context, task.id);
}

function requestChanges(context, taskId, flags = {}) {
  const task = tasks.getTask(context, taskId);
  if (!task.owner) {
    throw new Error(`No owner found for task ${String(taskId)}`);
  }

  const from =
    typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'team-lead';
  const comment =
    typeof flags.comment === 'string' && flags.comment.trim()
      ? flags.comment.trim()
      : 'Reviewer requested changes.';

  kanban.clearKanban(context, task.id);
  tasks.setTaskStatus(context, task.id, 'in_progress', from);
  tasks.addTaskComment(context, task.id, {
    text: comment,
    from,
    type: 'review_request',
  });
  messages.sendMessage(context, {
    to: task.owner,
    from,
    text:
      `Task ${task.displayId || task.id} needs fixes.\n\n${comment}\n\n` +
      'Please fix and mark it as completed when ready.',
    summary: `Fix request for ${task.displayId || task.id}`,
    source: 'system_notification',
  });

  return tasks.getTask(context, task.id);
}

module.exports = {
  approveReview,
  requestReview,
  requestChanges,
};
