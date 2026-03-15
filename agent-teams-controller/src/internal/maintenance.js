const fs = require('fs');
const path = require('path');

const kanbanStore = require('./kanbanStore.js');
const taskStore = require('./taskStore.js');

function listInboxNames(paths) {
  const inboxDir = path.join(paths.teamDir, 'inboxes');
  let entries = [];
  try {
    entries = fs.readdirSync(inboxDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .map((name) => name.replace(/\.json$/, ''));
}

function readInboxMessages(paths) {
  const messages = [];

  for (const member of listInboxNames(paths)) {
    const inboxPath = path.join(paths.teamDir, 'inboxes', `${member}.json`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) {
      continue;
    }

    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      if (
        typeof item.from !== 'string' ||
        typeof item.text !== 'string' ||
        typeof item.timestamp !== 'string'
      ) {
        continue;
      }

      messages.push({
        from: item.from,
        to: typeof item.to === 'string' ? item.to : member,
        text: item.text,
        timestamp: item.timestamp,
        summary: typeof item.summary === 'string' ? item.summary : undefined,
        messageId: typeof item.messageId === 'string' ? item.messageId : undefined,
        source: typeof item.source === 'string' ? item.source : undefined,
      });
    }
  }

  messages.sort((a, b) => {
    const bt = Date.parse(b.timestamp);
    const at = Date.parse(a.timestamp);
    if (Number.isNaN(bt) || Number.isNaN(at)) {
      return 0;
    }
    return bt - at;
  });

  return messages;
}

function isAutomatedCommentNotification(message) {
  const summary = typeof message.summary === 'string' ? message.summary : '';
  if (!/^Comment on #[A-Za-z0-9-]+/.test(summary)) return false;

  const text = typeof message.text === 'string' ? message.text : '';
  if (!text) return false;

  if (text.includes('Reply to this comment using:')) return true;
  if (text.startsWith('**Comment on task')) return true;
  if (text.startsWith('New comment from user on your task #')) return true;
  return false;
}

function syncLinkedComments(paths, tasks, messages) {
  const taskIdPattern = /#([A-Za-z0-9-]+)/g;
  const tasksById = new Map();
  const processedTexts = new Set();
  let linkedCommentsCreated = 0;

  for (const task of tasks) {
    tasksById.set(task.id, task);
    if (task.displayId) {
      tasksById.set(task.displayId, task);
    }
  }

  for (const message of messages) {
    if (!message.messageId || !message.summary || message.from === 'user') continue;
    if (message.source === 'lead_session' || message.source === 'lead_process') continue;
    if (message.source === 'system_notification') continue;
    if (isAutomatedCommentNotification(message)) continue;

    const textKey = `${message.from}\0${message.text}`;
    if (processedTexts.has(textKey)) continue;
    processedTexts.add(textKey);

    const taskRefs = new Set();
    for (const match of message.summary.matchAll(taskIdPattern)) {
      taskRefs.add(match[1]);
    }

    for (const taskRef of taskRefs) {
      const task = tasksById.get(taskRef);
      if (!task) continue;

      const commentId = `msg-${message.messageId}`;
      const existingComments = Array.isArray(task.comments) ? task.comments : [];
      if (existingComments.some((comment) => comment.id === commentId)) {
        continue;
      }

      try {
        taskStore.addTaskComment(paths, task.id, message.text, {
          id: commentId,
          author: message.from,
          createdAt: message.timestamp,
        });
        linkedCommentsCreated += 1;
      } catch {
        // Best-effort: reconcile should not fail on individual comment sync writes.
      }
    }
  }

  return linkedCommentsCreated;
}

function reconcileArtifacts(context, options = {}) {
  const garbageCollectKanban = options.garbageCollectKanban !== false;
  const shouldSyncLinkedComments = options.syncLinkedComments !== false;
  const tasks = taskStore.listTasks(context.paths);

  const gcResult = garbageCollectKanban
    ? kanbanStore.garbageCollect(
        context.paths,
        context.teamName,
        new Set(tasks.map((task) => task.id))
      )
    : { staleKanbanEntriesRemoved: 0, staleColumnOrderRefsRemoved: 0 };

  const linkedCommentsCreated = shouldSyncLinkedComments
    ? syncLinkedComments(context.paths, tasks, readInboxMessages(context.paths))
    : 0;

  return {
    staleKanbanEntriesRemoved: gcResult.staleKanbanEntriesRemoved,
    staleColumnOrderRefsRemoved: gcResult.staleColumnOrderRefsRemoved,
    linkedCommentsCreated,
  };
}

module.exports = {
  reconcileArtifacts,
};
