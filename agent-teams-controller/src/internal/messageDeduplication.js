const { looksLikeIdleAckOnlyText } = require('./idleAckText.js');

const RUNTIME_DELIVERY_DUPLICATE_NOTICE =
  'Duplicate runtime_delivery ignored. The visible reply is already recorded for this relayOfMessageId; do not call agent-teams_message_send again with the same text unless you have new information.';
const REPEATED_MESSAGE_WINDOW_MS = 30 * 60 * 1000;
const REPEATED_MESSAGE_NOTICE =
  'Duplicate message ignored. You already sent this exact text to this recipient within the last 30 minutes; it was delivered then. Do not resend it and do not rephrase it - send a new message only when you have new information.';
const RELAY_SCOPED_RESTATEMENT_NOTICE =
  'Duplicate message ignored. You already sent the user a visible reply for this app-delivered message (relayOfMessageId). Do not resend or rephrase it; send a new message only after new work or a new inbound message.';
const RESTATED_MESSAGE_MIN_LENGTH = 40;

function normalizeComparableText(value) {
  return String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeComparableParticipant(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRestatedText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRowTimeMs(row) {
  const parsed = Date.parse(row && row.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUserParticipant(value) {
  return normalizeComparableParticipant(value) === 'user';
}

function getMessageSemanticKey(row) {
  const taskRefs = Array.isArray(row && row.taskRefs)
    ? row.taskRefs
        .filter((ref) => ref && typeof ref === 'object')
        .map((ref) => ({
          taskId: String(ref.taskId || '').trim(),
          displayId: String(ref.displayId || '').trim(),
          teamName: normalizeComparableParticipant(ref.teamName),
        }))
        .filter((ref) => ref.taskId || ref.displayId || ref.teamName)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const attachments = Array.isArray(row && row.attachments)
    ? row.attachments
        .filter((attachment) => attachment && typeof attachment === 'object')
        .map((attachment) => ({
          id: String(attachment.id || '').trim(),
          filename: String(attachment.filename || '').trim(),
          mimeType: String(attachment.mimeType || '').trim(),
          size: Number(attachment.size || 0),
        }))
        .filter((attachment) => attachment.id || attachment.filename)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : [];
  const context = {
    relayOfMessageId: String((row && row.relayOfMessageId) || '').trim(),
    leadSessionId: String((row && row.leadSessionId) || '').trim(),
    conversationId: String((row && row.conversationId) || '').trim(),
    replyToConversationId: String((row && row.replyToConversationId) || '').trim(),
    taskRefs,
    attachments,
    messageKind: String((row && row.messageKind) || '').trim(),
    actionMode: String((row && row.actionMode) || '').trim(),
    workSyncIntent: String((row && row.workSyncIntent) || '').trim(),
    workSyncIntentKey: String((row && row.workSyncIntentKey) || '').trim(),
  };
  const hasExplicitContext =
    context.relayOfMessageId ||
    context.leadSessionId ||
    context.conversationId ||
    context.replyToConversationId ||
    context.taskRefs.length > 0 ||
    context.attachments.length > 0 ||
    context.messageKind ||
    context.actionMode ||
    context.workSyncIntent ||
    context.workSyncIntentKey;
  return hasExplicitContext ? JSON.stringify(context) : null;
}

function getRuntimeDeliveryDuplicate(list, row, options = {}) {
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
  const semanticKey = getMessageSemanticKey(row);
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
        normalizeComparableText(candidate.text) === text &&
        getMessageSemanticKey(candidate) === semanticKey &&
        (typeof options.hasUserMessageSince !== 'function' ||
          parseRowTimeMs(candidate) === null ||
          !options.hasUserMessageSince(parseRowTimeMs(candidate)))
    ) || null
  );
}

function getRepeatedMessageDuplicate(list, row, options = {}) {
  if (isUserParticipant(row.from)) {
    return null;
  }
  const from = normalizeComparableParticipant(row.from);
  const to = normalizeComparableParticipant(row.to);
  const text = normalizeComparableText(row.text);
  const rowTime = parseRowTimeMs(row);
  const semanticKey = getMessageSemanticKey(row);
  if (!from || !to || !text || rowTime === null || !semanticKey) {
    return null;
  }
  const restated = to === 'user' && from !== 'user' ? normalizeRestatedText(row.text) : '';
  const restatedMatches = restated.length >= RESTATED_MESSAGE_MIN_LENGTH;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (!candidate) continue;
    const candidateTime = parseRowTimeMs(candidate);
    if (candidateTime === null) continue;
    if (rowTime - candidateTime > REPEATED_MESSAGE_WINDOW_MS) break;
    if (
      normalizeComparableParticipant(candidate.from) !== from ||
      normalizeComparableParticipant(candidate.to) !== to
    ) {
      continue;
    }
    if (getMessageSemanticKey(candidate) !== semanticKey) continue;
    if (
      typeof options.hasUserMessageSince === 'function' &&
      options.hasUserMessageSince(candidateTime)
    ) {
      continue;
    }
    if (normalizeComparableText(candidate.text) === text) {
      return candidate;
    }
    if (restatedMatches && normalizeRestatedText(candidate.text) === restated) {
      return candidate;
    }
  }
  return null;
}

function getTaskRefIds(row) {
  const taskRefs = Array.isArray(row && row.taskRefs) ? row.taskRefs : [];
  return new Set(taskRefs.map((ref) => String((ref && ref.taskId) || '').trim()).filter(Boolean));
}

function getAttachmentIds(row) {
  const attachments = Array.isArray(row && row.attachments) ? row.attachments : [];
  return new Set(
    attachments
      .map((attachment) => String((attachment && attachment.id) || '').trim())
      .filter(Boolean)
  );
}

function getRelayScopedUserRestatement(list, row, options = {}) {
  if (!isUserParticipant(row.to) || isUserParticipant(row.from)) return null;
  const relayOfMessageId = String((row && row.relayOfMessageId) || '').trim();
  const from = normalizeComparableParticipant(row.from);
  const to = normalizeComparableParticipant(row.to);
  const rowTime = parseRowTimeMs(row);
  if (!relayOfMessageId || !from || !to || rowTime === null) return null;
  const requiredTaskIds = getTaskRefIds(row);
  const requiredAttachmentIds = getAttachmentIds(row);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (!candidate) continue;
    const candidateTime = parseRowTimeMs(candidate);
    if (candidateTime === null) continue;
    if (rowTime - candidateTime > REPEATED_MESSAGE_WINDOW_MS) break;
    if (String(candidate.relayOfMessageId || '').trim() !== relayOfMessageId) continue;
    if (
      normalizeComparableParticipant(candidate.from) !== from ||
      normalizeComparableParticipant(candidate.to) !== to
    ) {
      continue;
    }
    if (looksLikeIdleAckOnlyText(candidate.text) || looksLikeIdleAckOnlyText(candidate.summary)) {
      continue;
    }
    if (
      typeof options.hasUserMessageSince === 'function' &&
      options.hasUserMessageSince(candidateTime)
    ) {
      continue;
    }
    if (requiredTaskIds.size > 0) {
      const candidateTaskIds = getTaskRefIds(candidate);
      if (![...requiredTaskIds].every((taskId) => candidateTaskIds.has(taskId))) continue;
    }
    if (requiredAttachmentIds.size > 0) {
      const candidateAttachmentIds = getAttachmentIds(candidate);
      if (![...requiredAttachmentIds].every((id) => candidateAttachmentIds.has(id))) continue;
    }
    return candidate;
  }
  return null;
}

module.exports = {
  RUNTIME_DELIVERY_DUPLICATE_NOTICE,
  REPEATED_MESSAGE_WINDOW_MS,
  REPEATED_MESSAGE_NOTICE,
  RELAY_SCOPED_RESTATEMENT_NOTICE,
  normalizeComparableText,
  normalizeComparableParticipant,
  parseRowTimeMs,
  isUserParticipant,
  getMessageSemanticKey,
  getRuntimeDeliveryDuplicate,
  getRepeatedMessageDuplicate,
  getTaskRefIds,
  getAttachmentIds,
  getRelayScopedUserRestatement,
};
