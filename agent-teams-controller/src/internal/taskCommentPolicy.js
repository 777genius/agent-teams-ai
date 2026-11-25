const crypto = require('crypto');
const { normalizeTaskRefs } = require('./taskReferences.js');

function prepareTaskComment(text, options, { nowIso, uuidPattern }) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Missing comment text');
  }

  const answerRequestId = options.answerClarificationRequestId;
  if (answerRequestId !== undefined &&
      (!uuidPattern.test(String(answerRequestId)) || options.author !== 'user')) {
    throw new Error('Invalid task clarification answer identity');
  }
  const comment = {
    // One response identity per clarification cycle makes an uncertain retry
    // idempotent without a second journal or arbitrary client-chosen comment ID.
    id: answerRequestId ? 'clarification-answer-' + answerRequestId : options.id || crypto.randomUUID(),
    author:
      typeof options.author === 'string' && options.author.trim() ? options.author.trim() : 'user',
    text,
    createdAt:
      typeof options.createdAt === 'string' && options.createdAt.trim()
        ? options.createdAt.trim()
        : nowIso(),
    type: options.type || 'regular',
    ...(normalizeTaskRefs(options.taskRefs)
      ? { taskRefs: normalizeTaskRefs(options.taskRefs) }
      : {}),
    ...(Array.isArray(options.attachments) && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };
  return { comment, answerRequestId };
}

function findExistingClarificationAnswer(current, comment, answerRequestId) {
  if (current.needsClarification === 'user' &&
      current.clarificationRequestId !== answerRequestId) {
    throw new Error('Clarification request changed; reload the task before replying');
  }
  const existing = (Array.isArray(current.comments) ? current.comments : [])
    .find((row) => row.id === comment.id);
  if (existing) {
    const refs = (rows) => JSON.stringify(rows || []);
    const attachments = (rows) => JSON.stringify((rows || []).map((row) => ({
      id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size,
    })));
    if (existing.author !== comment.author || existing.text !== comment.text ||
        refs(existing.taskRefs) !== refs(comment.taskRefs) ||
        attachments(existing.attachments) !== attachments(comment.attachments)) {
      throw new Error('Clarification already answered with different content');
    }
    return existing;
  }
  if (current.needsClarification !== 'user' ||
      current.clarificationRequestId !== answerRequestId ||
      current.status === 'deleted' || current.deletedAt) {
    throw new Error('Clarification request is no longer awaiting your answer');
  }
  return undefined;
}

module.exports = {
  prepareTaskComment,
  findExistingClarificationAnswer,
};
