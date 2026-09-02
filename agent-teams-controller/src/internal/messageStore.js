const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonFileSync } = require('./atomicFile.js');
const { withFileLockSync } = require('./fileLock.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const taskStore = require('./taskStore.js');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  writeJsonFileSync(filePath, value);
}

function getInboxPath(paths, memberName) {
  const safeMemberName = runtimeHelpers.assertSafeMemberFileSegment('member name', memberName);
  return path.join(paths.teamDir, 'inboxes', `${safeMemberName}.json`);
}

function getSentMessagesPath(paths) {
  return path.join(paths.teamDir, 'sentMessages.json');
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  const normalized = attachments
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || '').trim(),
      filename: String(item.filename || '').trim(),
      mimeType: String(item.mimeType || '').trim(),
      size: Number(item.size || 0),
      ...(typeof item.filePath === 'string' && item.filePath.trim()
        ? { filePath: item.filePath.trim() }
        : {}),
    }))
    .filter((item) => item.id && item.filename && item.mimeType && Number.isFinite(item.size));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTaskRefs(taskRefs) {
  if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
    return undefined;
  }

  const normalized = taskRefs
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      taskId: String(item.taskId || '').trim(),
      displayId: String(item.displayId || '').trim(),
      teamName: String(item.teamName || '').trim(),
    }))
    .filter((item) => item.taskId && item.displayId && item.teamName);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMessageKind(messageKind) {
  return messageKind === 'default' ||
    messageKind === 'slash_command' ||
    messageKind === 'slash_command_result' ||
    messageKind === 'task_comment_notification' ||
    messageKind === 'member_work_sync_nudge'
    ? messageKind
    : undefined;
}

function normalizeWorkSyncIntent(workSyncIntent) {
  return workSyncIntent === 'agenda_sync' || workSyncIntent === 'review_pickup'
    ? workSyncIntent
    : undefined;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  return items.length > 0 ? items : undefined;
}

function normalizeSlashCommand(slashCommand) {
  if (!slashCommand || typeof slashCommand !== 'object') {
    return undefined;
  }
  const name = String(slashCommand.name || '').trim();
  const command = String(slashCommand.command || '').trim();
  if (!name || !command) {
    return undefined;
  }
  return {
    name,
    command,
    ...(typeof slashCommand.args === 'string' ? { args: slashCommand.args } : {}),
    ...(typeof slashCommand.knownDescription === 'string'
      ? { knownDescription: slashCommand.knownDescription }
      : {}),
  };
}

function normalizeCommandOutput(commandOutput) {
  if (!commandOutput || typeof commandOutput !== 'object') {
    return undefined;
  }
  const stream = commandOutput.stream === 'stdout' || commandOutput.stream === 'stderr'
    ? commandOutput.stream
    : undefined;
  const commandLabel = String(commandOutput.commandLabel || '').trim();
  if (!stream || !commandLabel) {
    return undefined;
  }
  return { stream, commandLabel };
}

function buildMessage(flags, defaults) {
  const timestamp =
    typeof flags.timestamp === 'string' && flags.timestamp.trim() ? flags.timestamp.trim() : nowIso();
  const messageId =
    typeof flags.messageId === 'string' && flags.messageId.trim()
      ? flags.messageId.trim()
      : crypto.randomUUID();
  const attachments = normalizeAttachments(flags.attachments);
  const taskRefs = normalizeTaskRefs(flags.taskRefs);
  const messageKind = normalizeMessageKind(flags.messageKind);
  const workSyncIntent = normalizeWorkSyncIntent(flags.workSyncIntent);
  const workSyncReviewRequestEventIds = normalizeStringList(flags.workSyncReviewRequestEventIds);
  const slashCommand = normalizeSlashCommand(flags.slashCommand);
  const commandOutput = normalizeCommandOutput(flags.commandOutput);

  return {
    from:
      typeof flags.from === 'string' && flags.from.trim()
        ? flags.from.trim()
        : defaults.from || 'user',
    ...(defaults.to ? { to: defaults.to } : {}),
    text: String(flags.text || ''),
    timestamp,
    read: defaults.read,
    ...(taskRefs ? { taskRefs } : {}),
    ...(flags.actionMode === 'do' || flags.actionMode === 'ask' || flags.actionMode === 'delegate'
      ? { actionMode: flags.actionMode }
      : {}),
    ...(typeof flags.summary === 'string' && flags.summary.trim()
      ? { summary: flags.summary.trim() }
      : {}),
    ...(typeof flags.commentId === 'string' && flags.commentId.trim()
      ? { commentId: flags.commentId.trim() }
      : {}),
    ...(typeof flags.relayOfMessageId === 'string' && flags.relayOfMessageId.trim()
      ? { relayOfMessageId: flags.relayOfMessageId.trim() }
      : {}),
    ...(typeof flags.source === 'string' && flags.source.trim() ? { source: flags.source.trim() } : {}),
    ...(typeof flags.leadSessionId === 'string' && flags.leadSessionId.trim()
      ? { leadSessionId: flags.leadSessionId.trim() }
      : {}),
    ...(typeof flags.conversationId === 'string' && flags.conversationId.trim()
      ? { conversationId: flags.conversationId.trim() }
      : {}),
    ...(typeof flags.replyToConversationId === 'string' && flags.replyToConversationId.trim()
      ? { replyToConversationId: flags.replyToConversationId.trim() }
      : {}),
    ...(typeof flags.color === 'string' && flags.color.trim() ? { color: flags.color.trim() } : {}),
    ...(typeof flags.toolSummary === 'string' && flags.toolSummary.trim()
      ? { toolSummary: flags.toolSummary.trim() }
      : {}),
    ...(Array.isArray(flags.toolCalls) && flags.toolCalls.length > 0
      ? {
          toolCalls: flags.toolCalls
            .filter((item) => item && typeof item === 'object' && typeof item.name === 'string')
            .map((item) => ({
              name: item.name,
              ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
            })),
        }
      : {}),
    ...(messageKind ? { messageKind } : {}),
    ...(workSyncIntent ? { workSyncIntent } : {}),
    ...(typeof flags.workSyncIntentKey === 'string' && flags.workSyncIntentKey.trim()
      ? { workSyncIntentKey: flags.workSyncIntentKey.trim() }
      : {}),
    ...(workSyncReviewRequestEventIds ? { workSyncReviewRequestEventIds } : {}),
    ...(slashCommand ? { slashCommand } : {}),
    ...(commandOutput ? { commandOutput } : {}),
    ...(attachments ? { attachments } : {}),
    messageId,
  };
}

function appendRow(filePath, row) {
  return withFileLockSync(filePath, () => {
    const current = readJson(filePath, []);
    const list = Array.isArray(current) ? current : [];
    list.push(row);
    writeJson(filePath, list);
    return row;
  });
}

const RUNTIME_DELIVERY_DUPLICATE_NOTICE =
  'Duplicate runtime_delivery ignored. The visible reply is already recorded for this relayOfMessageId; do not call agent-teams_message_send again with the same text unless you have new information.';

function normalizeComparableText(value) {
  return String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeComparableParticipant(value) {
  return String(value || '').trim().toLowerCase();
}

function getRuntimeDeliveryDuplicate(list, row) {
  if (
    row.source !== 'runtime_delivery' ||
    typeof row.relayOfMessageId !== 'string' ||
    row.relayOfMessageId.trim().length === 0
  ) {
    return null;
  }

  const relayOfMessageId = row.relayOfMessageId.trim();
  const from = normalizeComparableParticipant(row.from);
  const to = normalizeComparableParticipant(row.to);
  const text = normalizeComparableText(row.text);
  if (!from || !to || !text) {
    return null;
  }

  return (
    list.find(
      (candidate) =>
        candidate &&
        candidate.source === 'runtime_delivery' &&
        String(candidate.relayOfMessageId || '').trim() === relayOfMessageId &&
        normalizeComparableParticipant(candidate.from) === from &&
        normalizeComparableParticipant(candidate.to) === to &&
        normalizeComparableText(candidate.text) === text
    ) || null
  );
}

const REPEATED_MESSAGE_WINDOW_MS = 30 * 60 * 1000;
const REPEATED_MESSAGE_NOTICE =
  'Duplicate message ignored. You already sent this exact text to this recipient within the last 30 minutes; it was delivered then. Do not resend it and do not rephrase it - send a new message only when you have new information.';

function parseRowTimeMs(row) {
  const parsed = Date.parse(row && row.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Memoryless lead sessions (orchestrator rebuilds, replayed deliveries)
 * re-send their final "ALL DONE"-style messages on every later wake-up. An
 * identical from/to/text row inside the window is treated as already sent.
 */
function getRepeatedMessageDuplicate(list, row) {
  const from = normalizeComparableParticipant(row.from);
  const to = normalizeComparableParticipant(row.to);
  const text = normalizeComparableText(row.text);
  const rowTime = parseRowTimeMs(row);
  if (!from || !to || !text || rowTime === null) {
    return null;
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (!candidate) continue;
    const candidateTime = parseRowTimeMs(candidate);
    if (candidateTime === null) continue;
    if (rowTime - candidateTime > REPEATED_MESSAGE_WINDOW_MS) break;
    if (
      normalizeComparableParticipant(candidate.from) === from &&
      normalizeComparableParticipant(candidate.to) === to &&
      normalizeComparableText(candidate.text) === text
    ) {
      return candidate;
    }
  }
  return null;
}

const BOARD_EPOCH_EVENT_TYPES = new Set(['task_created', 'status_changed', 'owner_changed']);
const POST_COMPLETION_MESSAGE_NOTICE_PREFIX =
  'Duplicate message ignored. Final message already delivered: the board was already complete when you messaged the user at ';
const POST_COMPLETION_MESSAGE_NOTICE_SUFFIX =
  ', and no task has been created, started, completed, reopened, or reassigned since. This restatement was not delivered. Send the user another message only after a task changes state or after the user writes to you again.';

function isUserParticipant(value) {
  return normalizeComparableParticipant(value) === 'user';
}

/**
 * Structural board-completion epoch: the newest task_created / status_changed /
 * owner_changed event across a board whose every live task is completed.
 * Comments and attachments bump `updatedAt` but are not board events, so they
 * must not move the epoch (a memoryless lead would otherwise talk its way
 * around the guard by commenting first). Returns null unless the board is
 * complete and non-empty.
 */
function readBoardCompletionEpoch(paths) {
  let tasks;
  try {
    tasks = taskStore.listTasks(paths);
  } catch {
    return null;
  }
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  if (!tasks.every((task) => task && task.status === 'completed')) return null;
  let lastBoardEventMs = 0;
  for (const task of tasks) {
    const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
    let sawEvent = false;
    for (const event of events) {
      if (!event || !BOARD_EPOCH_EVENT_TYPES.has(event.type)) continue;
      const ms = Date.parse(event.timestamp);
      if (Number.isFinite(ms)) {
        sawEvent = true;
        if (ms > lastBoardEventMs) lastBoardEventMs = ms;
      }
    }
    for (const raw of [task.createdAt, sawEvent ? undefined : task.updatedAt]) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms) && ms > lastBoardEventMs) lastBoardEventMs = ms;
    }
  }
  return lastBoardEventMs > 0 ? { lastBoardEventMs } : null;
}

/** True when any inbox holds a message from the human user newer than sinceMs. */
function hasUserMessageSince(paths, sinceMs) {
  const inboxDir = path.join(paths.teamDir, 'inboxes');
  let entries;
  try {
    entries = fs.readdirSync(inboxDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let rows;
    try {
      rows = readJson(path.join(inboxDir, entry), []);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index];
      if (!candidate || !isUserParticipant(candidate.from)) continue;
      const ms = parseRowTimeMs(candidate);
      if (ms !== null && ms > sinceMs) return true;
    }
  }
  return false;
}

/**
 * Once the board is complete and the team already messaged the user after the
 * last board event, further agent->user messages inside the repeat window are
 * rephrased "ALL DONE" recaps from memoryless turns. Returns the final row they
 * duplicate, or null when the message must be delivered: board not complete,
 * this IS the final message, the board moved again, the user wrote again, or
 * the window expired.
 */
function getPostCompletionFinalMessage(list, row, resolveBoardCompletion) {
  if (typeof resolveBoardCompletion !== 'function') return null;
  if (!isUserParticipant(row.to) || isUserParticipant(row.from)) return null;
  if (!normalizeComparableParticipant(row.from)) return null;
  const rowTime = parseRowTimeMs(row);
  if (rowTime === null) return null;
  const board = resolveBoardCompletion();
  if (!board || !Number.isFinite(board.lastBoardEventMs)) return null;
  // The most recent agent->user message sent after the last board event.
  let finalRow = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (!candidate || !isUserParticipant(candidate.to) || isUserParticipant(candidate.from)) continue;
    if (!normalizeComparableParticipant(candidate.from)) continue;
    const candidateTime = parseRowTimeMs(candidate);
    if (candidateTime === null || candidateTime < board.lastBoardEventMs) continue;
    finalRow = candidate;
    break;
  }
  if (!finalRow) return null;
  const finalMs = parseRowTimeMs(finalRow);
  if (rowTime - finalMs > REPEATED_MESSAGE_WINDOW_MS) return null;
  if (typeof board.hasUserMessageSince === 'function' && board.hasUserMessageSince(finalMs)) {
    return null;
  }
  return finalRow;
}

function buildPostCompletionNotice(finalRow) {
  return `${POST_COMPLETION_MESSAGE_NOTICE_PREFIX}${finalRow.timestamp}${POST_COMPLETION_MESSAGE_NOTICE_SUFFIX}`;
}

function appendInboxRow(filePath, row, options = {}) {
  return withFileLockSync(filePath, () => {
    const current = readJson(filePath, []);
    const list = Array.isArray(current) ? current : [];
    const duplicate = getRuntimeDeliveryDuplicate(list, row);
    if (duplicate) {
      return { row: duplicate, deduplicated: true };
    }
    const repeated = getRepeatedMessageDuplicate(list, row);
    if (repeated) {
      return { row: repeated, deduplicated: true, repeated: true };
    }
    const postCompletion = getPostCompletionFinalMessage(
      list,
      row,
      options.resolveBoardCompletion
    );
    if (postCompletion) {
      return { row: postCompletion, deduplicated: true, postCompletion: true };
    }

    list.push(row);
    writeJson(filePath, list);
    return { row, deduplicated: false };
  });
}

function sendInboxMessage(paths, flags) {
  const memberName =
    typeof flags.member === 'string' && flags.member.trim()
      ? flags.member.trim()
      : typeof flags.to === 'string' && flags.to.trim()
        ? flags.to.trim()
        : '';
  if (!memberName) {
    throw new Error('Missing recipient');
  }

  const payload = buildMessage(flags, {
    from: 'user',
    to: memberName,
    read: false,
  });
  const appended = appendInboxRow(getInboxPath(paths, memberName), payload, {
    resolveBoardCompletion: () => {
      const epoch = readBoardCompletionEpoch(paths);
      return epoch
        ? { ...epoch, hasUserMessageSince: (sinceMs) => hasUserMessageSince(paths, sinceMs) }
        : null;
    },
  });
  return {
    deliveredToInbox: true,
    messageId: appended.row.messageId,
    message: appended.row,
    ...(appended.deduplicated
      ? {
          deduplicated: true,
          duplicateOfMessageId: appended.row.messageId,
          deduplicationNotice: appended.postCompletion
            ? buildPostCompletionNotice(appended.row)
            : appended.repeated
              ? REPEATED_MESSAGE_NOTICE
              : RUNTIME_DELIVERY_DUPLICATE_NOTICE,
        }
      : {}),
  };
}

function appendSentMessage(paths, flags) {
  const payload = buildMessage(flags, {
    from: 'team-lead',
    to: typeof flags.to === 'string' && flags.to.trim() ? flags.to.trim() : undefined,
    read: true,
  });
  appendRow(getSentMessagesPath(paths), payload);
  return payload;
}

/**
 * Exact readonly lookup by messageId across sent messages and all inbox files.
 *
 * Used by task_create_from_message to resolve provenance. Lookup is exact-messageId
 * only and must never resolve by relayOfMessageId, text matching, or active context.
 * Must reject ambiguous matches (same messageId in multiple stores) instead of guessing.
 *
 * Returns { message, store } or throws.
 */
function lookupMessage(paths, messageId) {
  const id = typeof messageId === 'string' ? messageId.trim() : '';
  if (!id) {
    throw new Error('Missing messageId');
  }

  let match = null;
  let matchCount = 0;

  // 1. Search sentMessages.json
  const sentRows = readJson(getSentMessagesPath(paths), []);
  if (Array.isArray(sentRows)) {
    for (const row of sentRows) {
      if (row && row.messageId === id) {
        match = { message: row, store: 'sent' };
        matchCount++;
        if (matchCount > 1) {
          throw new Error(`Ambiguous messageId: ${id} found in multiple stores`);
        }
      }
    }
  }

  // 2. Search all inbox files (early-exit on ambiguity)
  const inboxDir = path.join(paths.teamDir, 'inboxes');
  let inboxFiles = [];
  try {
    inboxFiles = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
  } catch {
    // No inboxes directory — that's fine.
  }

  for (const file of inboxFiles) {
    let rows;
    try {
      rows = readJson(path.join(inboxDir, file), []);
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && row.messageId === id) {
        matchCount++;
        if (matchCount > 1) {
          throw new Error(`Ambiguous messageId: ${id} found in multiple stores`);
        }
        match = { message: row, store: `inbox:${file.replace('.json', '')}` };
      }
    }
  }

  if (matchCount === 0) {
    throw new Error(`Message not found: ${id}`);
  }

  return match;
}

module.exports = {
  appendSentMessage,
  readBoardCompletionEpoch,
  lookupMessage,
  sendInboxMessage,
};
