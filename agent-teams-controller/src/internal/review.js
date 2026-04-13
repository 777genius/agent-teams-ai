const kanban = require('./kanban.js');
const messages = require('./messages.js');
const runtimeHelpers = require('./runtimeHelpers.js');
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

function resolveLeadSessionId(context, flags) {
  return runtimeHelpers.resolveCanonicalLeadSessionId(context.paths, flags.leadSessionId);
}

function getCurrentReviewState(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'review_requested' || e.type === 'review_changes_requested' || e.type === 'review_approved' || e.type === 'review_started') {
      return e.to;
    }
    if (e.type === 'status_changed' && e.to === 'in_progress') {
      return 'none';
    }
  }
  return 'none';
}

function startReview(context, taskId, flags = {}) {
  const task = tasks.getTask(context, taskId);
  if (task.status === 'deleted') {
    throw new Error(`Task #${task.displayId || task.id} is deleted`);
  }

  const from =
    typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'reviewer';
  const prevReviewState = getCurrentReviewState(task);

  // Idempotent: already in review → return ok without duplicate history event
  if (prevReviewState === 'review') {
    return { ok: true, taskId: task.id, displayId: task.displayId, column: 'review' };
  }

  try {
    kanban.setKanbanColumn(context, task.id, 'review');
    tasks.updateTask(context, task.id, (t) => {
      t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
        type: 'review_started',
        from: prevReviewState,
        to: 'review',
        actor: from,
      });
      t.reviewState = 'review';
      return t;
    });
    return { ok: true, taskId: task.id, displayId: task.displayId, column: 'review' };
  } catch (error) {
    try {
      kanban.clearKanban(context, task.id);
    } catch {
      // Best-effort rollback
    }
    throw error;
  }
}

function requestReview(context, taskId, flags = {}) {
  const task = tasks.getTask(context, taskId);
  if (task.status !== 'completed') {
    throw new Error(`Task #${task.displayId || task.id} must be completed before review`);
  }

  const from =
    typeof flags.from === 'string' && flags.from.trim() ? flags.from.trim() : 'team-lead';
  const reviewer = getReviewer(context, flags);
  const leadSessionId = resolveLeadSessionId(context, flags);
  const prevReviewState = getCurrentReviewState(task);

  try {
    kanban.setKanbanColumn(context, task.id, 'review');

    // Append review_requested event
    tasks.updateTask(context, task.id, (t) => {
      t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
        type: 'review_requested',
        from: prevReviewState,
        to: 'review',
        ...(reviewer ? { reviewer } : {}),
        actor: from,
      });
      t.reviewState = 'review';
      return t;
    });

    if (!reviewer) {
      return tasks.getTask(context, task.id);
    }

    messages.sendMessage(context, {
      to: reviewer,
      from,
      text:
        `**Please review** task #${task.displayId || task.id}\n\n` +
        wrapAgentBlock(
          `FIRST call review_start to signal you are beginning the review:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>" }\n\n` +
            `When approved, use MCP tool review_approve:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", note?: "<optional note>", notifyOwner: true }\n\n` +
            `If changes are needed, use MCP tool review_request_changes:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", comment: "..." }`
        ),
      summary: `Review request for #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
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
  const suppressTaskComment = flags.suppressTaskComment === true;
  const leadSessionId = resolveLeadSessionId(context, flags);
  const prevReviewState = getCurrentReviewState(task);

  // Idempotent: already approved → skip duplicate comment/event, only add note if new
  if (prevReviewState === 'approved') {
    return { ok: true, taskId: task.id, displayId: task.displayId, column: 'approved', alreadyApproved: true };
  }

  kanban.setKanbanColumn(context, task.id, 'approved');

  // Append review_approved event
  tasks.updateTask(context, task.id, (t) => {
    t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
      type: 'review_approved',
      from: prevReviewState,
      to: 'approved',
      ...(note ? { note } : {}),
      actor: from,
    });
    t.reviewState = 'approved';
    return t;
  });

  if (!suppressTaskComment) {
    tasks.addTaskComment(context, task.id, {
      text: note,
      from,
      type: 'review_approved',
      notifyOwner: false,
    });
  }

  if ((flags.notify === true || flags['notify-owner'] === true) && task.owner) {
    messages.sendMessage(context, {
      to: task.owner,
      from,
      text:
        note && note !== 'Approved'
          ? `@${from} **approved** task #${task.displayId || task.id}\n\n${note}`
          : `@${from} **approved** task #${task.displayId || task.id}`,
      summary: `Approved #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
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
  const leadSessionId = resolveLeadSessionId(context, flags);
  const prevReviewState = getCurrentReviewState(task);

  // Append review_changes_requested event before status change
  tasks.updateTask(context, task.id, (t) => {
    t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
      type: 'review_changes_requested',
      from: prevReviewState,
      to: 'needsFix',
      ...(comment ? { note: comment } : {}),
      actor: from,
    });
    t.reviewState = 'needsFix';
    return t;
  });

  kanban.clearKanban(context, task.id, { nextReviewState: 'needsFix' });
  tasks.setTaskStatus(context, task.id, 'pending', from);
  tasks.addTaskComment(context, task.id, {
    text: comment,
    from,
    type: 'review_request',
    ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
    notifyOwner: false,
  });
  messages.sendMessage(context, {
    to: task.owner,
    from,
    text:
      `@${from} **requested changes** for task #${task.displayId || task.id}\n\n${comment}\n\n` +
      'The task has been moved back to pending. When you are ready to resume, review the task context, start it explicitly, implement the fixes, mark it completed, and request review again.',
    ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
    summary: `Fix request for #${task.displayId || task.id}`,
    source: 'system_notification',
    ...(leadSessionId ? { leadSessionId } : {}),
  });

  return tasks.getTask(context, task.id);
}

module.exports = {
  approveReview,
  requestReview,
  requestChanges,
  startReview,
};
