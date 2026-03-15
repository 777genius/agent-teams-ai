const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function getInboxPath(paths, memberName) {
  return path.join(paths.teamDir, 'inboxes', `${String(memberName).trim()}.json`);
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

function buildMessage(flags, defaults) {
  const timestamp =
    typeof flags.timestamp === 'string' && flags.timestamp.trim() ? flags.timestamp.trim() : nowIso();
  const messageId =
    typeof flags.messageId === 'string' && flags.messageId.trim()
      ? flags.messageId.trim()
      : crypto.randomUUID();
  const attachments = normalizeAttachments(flags.attachments);
  const taskRefs = normalizeTaskRefs(flags.taskRefs);

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
    ...(typeof flags.summary === 'string' && flags.summary.trim()
      ? { summary: flags.summary.trim() }
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
    ...(attachments ? { attachments } : {}),
    messageId,
  };
}

function appendRow(filePath, row) {
  const current = readJson(filePath, []);
  const list = Array.isArray(current) ? current : [];
  list.push(row);
  writeJson(filePath, list);
  return row;
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
  appendRow(getInboxPath(paths, memberName), payload);
  return {
    deliveredToInbox: true,
    messageId: payload.messageId,
    message: payload,
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

module.exports = {
  appendSentMessage,
  sendInboxMessage,
};

