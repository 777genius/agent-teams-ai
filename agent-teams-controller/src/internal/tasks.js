const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const messages = require('./messages.js');
const { wrapAgentBlock } = require('./agentBlocks.js');

function normalizeActorName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isSameMember(left, right) {
  return normalizeActorName(left).toLowerCase() === normalizeActorName(right).toLowerCase();
}

function isSameTaskMember(left, right, leadName) {
  const normalizedLeft = normalizeActorName(left).toLowerCase();
  const normalizedRight = normalizeActorName(right).toLowerCase();
  const normalizedLead = normalizeActorName(leadName).toLowerCase();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return (
    (normalizedLeft === 'team-lead' && normalizedRight === normalizedLead) ||
    (normalizedRight === 'team-lead' && normalizedLeft === normalizedLead)
  );
}

function buildAssignmentMessage(context, task, options = {}) {
  const description =
    typeof options.description === 'string' && options.description.trim()
      ? options.description.trim()
      : typeof task.description === 'string' && task.description.trim()
        ? task.description.trim()
        : '';
  const prompt =
    typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : '';
  const taskLabel = `#${task.displayId || task.id}`;
  const lines = [`New task assigned to you: ${taskLabel} "${task.subject}".`];

  if (description) {
    lines.push(``, `Description:`, description);
  }

  if (prompt) {
    lines.push(``, `Instructions:`, prompt);
  }

  lines.push(
    ``,
    wrapAgentBlock(`Use the board MCP tools to work this task correctly:
1. Check the latest full context before starting:
   task_get { teamName: "${context.teamName}", taskId: "${task.id}" }
2. When you actually begin work, mark it started:
   task_start { teamName: "${context.teamName}", taskId: "${task.id}" }
3. When the work is done, mark it completed:
   task_complete { teamName: "${context.teamName}", taskId: "${task.id}" }`)
  );

  return lines.join('\n');
}

function buildCommentNotificationMessage(context, task, comment) {
  const taskLabel = `#${task.displayId || task.id}`;
  return [
    `Comment on task ${taskLabel} "${task.subject}":`,
    ``,
    comment.text,
    ``,
    wrapAgentBlock(`Reply to this comment using MCP tool task_add_comment:
{ teamName: "${context.teamName}", taskId: "${task.id}", text: "<your reply>", from: "<your-name>" }`),
  ].join('\n');
}

function maybeNotifyAssignedOwner(context, task, options = {}) {
  const owner = normalizeActorName(task.owner);
  if (!owner || task.status === 'deleted') {
    return;
  }

  const leadName = runtimeHelpers.inferLeadName(context.paths);
  const sender = normalizeActorName(options.from) || leadName;
  const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
  if (isSameMember(owner, leadName) || isSameMember(owner, sender)) {
    return;
  }

  const summary = options.summary || `New task #${task.displayId || task.id} assigned`;
  messages.sendMessage(context, {
    member: owner,
    from: sender,
    text: buildAssignmentMessage(context, task, options),
    taskRefs: Array.isArray(options.taskRefs) && options.taskRefs.length > 0 ? options.taskRefs : undefined,
    summary,
    source: 'system_notification',
    ...(leadSessionId ? { leadSessionId } : {}),
  });
}

function maybeNotifyTaskOwnerOnComment(context, task, comment, options = {}) {
  if (!options.inserted || options.notifyOwner === false) {
    return;
  }
  if (!task || task.status === 'deleted') {
    return;
  }
  if (comment.type && comment.type !== 'regular') {
    return;
  }

  const owner = normalizeActorName(task.owner);
  if (!owner) {
    return;
  }

  const leadName = runtimeHelpers.inferLeadName(context.paths);
  if (isSameTaskMember(owner, comment.author, leadName)) {
    return;
  }

  const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);
  messages.sendMessage(context, {
    member: owner,
    from: normalizeActorName(comment.author) || leadName,
    text: buildCommentNotificationMessage(context, task, comment),
    taskRefs: Array.isArray(comment.taskRefs) ? comment.taskRefs : undefined,
    summary: `Comment on #${task.displayId || task.id}`,
    source: 'system_notification',
    ...(leadSessionId ? { leadSessionId } : {}),
  });
}

function createTask(context, input) {
  const task = taskStore.createTask(context.paths, input);
  if (input && input.notifyOwner !== false) {
    maybeNotifyAssignedOwner(context, task, {
      description: input.description,
      prompt: input.prompt,
      taskRefs: [
        ...(Array.isArray(input.descriptionTaskRefs) ? input.descriptionTaskRefs : []),
        ...(Array.isArray(input.promptTaskRefs) ? input.promptTaskRefs : []),
      ],
      from: input.from,
    });
  }
  return task;
}

function getTask(context, taskId) {
  return taskStore.readTask(context.paths, taskId, { includeDeleted: true });
}

function listTasks(context) {
  return taskStore.listTasks(context.paths);
}

function listDeletedTasks(context) {
  return taskStore.listTasks(context.paths, { includeDeleted: true }).filter(
    (task) => task.status === 'deleted'
  );
}

function resolveTaskId(context, taskRef) {
  return taskStore.resolveTaskRef(context.paths, taskRef, { includeDeleted: true });
}

function setTaskStatus(context, taskId, status, actor) {
  return taskStore.setTaskStatus(context.paths, taskId, status, actor);
}

function startTask(context, taskId, actor) {
  const task = setTaskStatus(context, taskId, 'in_progress', actor);
  // Clear stale kanban entry (e.g. 'approved' or 'review') when task is reopened
  try {
    const kanbanStore = require('./kanbanStore.js');
    const state = kanbanStore.readKanbanState(context.paths, context.teamName);
    if (state.tasks[task.id]) {
      delete state.tasks[task.id];
      kanbanStore.writeKanbanState(context.paths, context.teamName, state);
    }
  } catch {
    // Best-effort: task status already updated, kanban cleanup failure is non-fatal
  }
  return task;
}

function completeTask(context, taskId, actor) {
  return setTaskStatus(context, taskId, 'completed', actor);
}

function softDeleteTask(context, taskId, actor) {
  return setTaskStatus(context, taskId, 'deleted', actor);
}

function restoreTask(context, taskId, actor) {
  return setTaskStatus(context, taskId, 'pending', actor || 'user');
}

function setTaskOwner(context, taskId, owner) {
  const previousTask = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
  const updatedTask = taskStore.setTaskOwner(context.paths, taskId, owner);

  if (
    owner != null &&
    normalizeActorName(updatedTask.owner) &&
    !isSameMember(previousTask.owner, updatedTask.owner)
  ) {
    maybeNotifyAssignedOwner(context, updatedTask, {
      summary: `Task #${updatedTask.displayId || updatedTask.id} assigned`,
    });
  }

  return updatedTask;
}

function updateTaskFields(context, taskId, fields) {
  return taskStore.updateTaskFields(context.paths, taskId, fields);
}

function addTaskComment(context, taskId, flags) {
  const result = taskStore.addTaskComment(context.paths, taskId, flags.text, {
    author:
      typeof flags.from === 'string' && flags.from.trim()
        ? flags.from.trim()
        : runtimeHelpers.inferLeadName(context.paths),
    ...(flags.id ? { id: flags.id } : {}),
    ...(flags.createdAt ? { createdAt: flags.createdAt } : {}),
    ...(flags.type ? { type: flags.type } : {}),
    ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
    ...(Array.isArray(flags.attachments) ? { attachments: flags.attachments } : {}),
  });

  try {
    maybeNotifyTaskOwnerOnComment(context, result.task, result.comment, {
      inserted: result.inserted,
      notifyOwner: flags.notifyOwner,
    });
  } catch (notifyError) {
    // Best-effort: comment is already persisted, notification failure must not fail the call
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[tasks] owner notification failed for task ${taskId}: ${String(notifyError)}`
      );
    }
  }

  return {
    commentId: result.comment.id,
    taskId: result.task.id,
    subject: result.task.subject,
    owner: result.task.owner,
    task: result.task,
    comment: result.comment,
  };
}

function attachTaskFile(context, taskId, flags) {
  const canonicalTaskId = resolveTaskId(context, taskId);
  const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
  const task = taskStore.addTaskAttachmentMeta(context.paths, canonicalTaskId, saved.meta);
  return {
    ...saved.meta,
    task,
  };
}

function attachCommentFile(context, taskId, commentId, flags) {
  const canonicalTaskId = resolveTaskId(context, taskId);
  const saved = runtimeHelpers.saveTaskAttachmentFile(context.paths, canonicalTaskId, flags);
  const task = taskStore.addCommentAttachmentMeta(context.paths, canonicalTaskId, commentId, saved.meta);
  return {
    ...saved.meta,
    task,
  };
}

function addTaskAttachmentMeta(context, taskId, meta) {
  return taskStore.addTaskAttachmentMeta(context.paths, taskId, meta);
}

function removeTaskAttachment(context, taskId, attachmentId) {
  return taskStore.removeTaskAttachment(context.paths, taskId, attachmentId);
}

function setNeedsClarification(context, taskId, value) {
  return taskStore.setNeedsClarification(context.paths, taskId, value == null ? 'clear' : String(value));
}

function linkTask(context, taskId, targetId, linkType) {
  return taskStore.linkTask(context.paths, taskId, targetId, String(linkType));
}

function unlinkTask(context, taskId, targetId, linkType) {
  return taskStore.unlinkTask(context.paths, taskId, targetId, String(linkType));
}

async function taskBriefing(context, memberName) {
  return taskStore.formatTaskBriefing(context.paths, context.teamName, String(memberName));
}

module.exports = {
  addTaskAttachmentMeta,
  addTaskComment,
  appendHistoryEvent: taskStore.appendHistoryEvent,
  attachTaskFile,
  attachCommentFile,
  completeTask,
  createTask,
  getTask,
  linkTask,
  listDeletedTasks,
  listTasks,
  removeTaskAttachment,
  resolveTaskId,
  restoreTask,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  softDeleteTask,
  startTask,
  taskBriefing,
  unlinkTask,
  updateTask: (context, taskRef, updater) =>
    taskStore.updateTask(context.paths, taskRef, updater),
  updateTaskFields,
};
