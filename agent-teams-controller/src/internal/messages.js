const messageStore = require('./messageStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const { isOpenCodeMember } = require('./memberMessagingProtocol.js');

const PLACEHOLDER_TASK_REF_PREFIX = /^\s*#0{8}\b\s*(?:[:.-]\s*)?/i;
const IDLE_ACK_MAX_CHARS = 180;
const IDLE_ACK_EXACT_TEXT = new Set([
  'ok',
  'okay',
  'understood',
  'got it',
  'ready',
  'waiting',
  'waiting for tasks',
  'awaiting tasks',
  'no tasks',
  'no assigned tasks',
  'no actionable tasks',
  'понял',
  'поняла',
  'понял жду',
  'понял жду задачи',
  'принял',
  'приняла',
  'ок',
  'окей',
  'готов',
  'готов к работе',
  'жду',
  'жду задачи',
  'нет задач',
  'нет назначенных задач',
]);

function stripPlaceholderTaskRefPrefix(value) {
  if (typeof value !== 'string' || !PLACEHOLDER_TASK_REF_PREFIX.test(value)) {
    return value;
  }
  return value.replace(PLACEHOLDER_TASK_REF_PREFIX, '').trimStart();
}

function normalizePlaceholderTaskRefPrefixes(flags) {
  const next = { ...(flags || {}) };
  if (typeof next.text === 'string') {
    const strippedText = stripPlaceholderTaskRefPrefix(next.text);
    next.text = strippedText.trim() ? strippedText : next.text;
  }
  if (typeof next.summary === 'string') {
    next.summary = stripPlaceholderTaskRefPrefix(next.summary);
  }
  return next;
}

function normalizeIdleAckText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[#*_`"'“”‘’«»()[\]{}.,!?;:<>/\\|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeIdleAckOnlyText(value) {
  const normalized = normalizeIdleAckText(value);
  if (!normalized || normalized.length > IDLE_ACK_MAX_CHARS) {
    return false;
  }
  if (IDLE_ACK_EXACT_TEXT.has(normalized)) {
    return true;
  }

  const hasNoTaskPhrase =
    normalized.includes('нет назначенных задач') ||
    normalized.includes('нет задач') ||
    normalized.includes('no assigned tasks') ||
    normalized.includes('no actionable tasks') ||
    normalized.includes('no tasks');
  const hasWaitingPhrase =
    normalized.includes('жду задачи') ||
    normalized.includes('ожидаю задачи') ||
    normalized.includes('waiting for tasks') ||
    normalized.includes('awaiting tasks');
  const hasReadyPhrase =
    normalized.includes('готов к работе') ||
    normalized.includes('готов работать') ||
    normalized.includes('ready to work');
  const hasNoMoreMessagingPhrase =
    normalized.includes('больше не буду') &&
    (normalized.includes('писать') ||
      normalized.includes('отправлять') ||
      normalized.includes('message') ||
      normalized.includes('send'));
  const hasIdlePhrase =
    normalized.includes('idle') &&
    (normalized.includes('task') || normalized.includes('wait') || normalized.includes('ready'));

  return (
    hasNoTaskPhrase ||
    hasWaitingPhrase ||
    hasReadyPhrase ||
    hasNoMoreMessagingPhrase ||
    hasIdlePhrase
  );
}

function hasExplicitDeliveryContext(flags) {
  if (typeof flags.relayOfMessageId === 'string' && flags.relayOfMessageId.trim()) return true;
  if (Array.isArray(flags.taskRefs) && flags.taskRefs.length > 0) return true;
  if (Array.isArray(flags.attachments) && flags.attachments.length > 0) return true;
  if (typeof flags.leadSessionId === 'string' && flags.leadSessionId.trim()) return true;
  return false;
}

function findResolvedMember(paths, memberName) {
  const resolvedName = runtimeHelpers.resolveExplicitTeamMemberName(paths, memberName, {
    allowLeadAliases: true,
  });
  if (!resolvedName) return null;
  const key = resolvedName.toLowerCase();
  const members = runtimeHelpers.resolveTeamMembers(paths).members || [];
  return members.find((member) => String(member?.name || '').trim().toLowerCase() === key) || null;
}

function isLeadRecipient(paths, to) {
  const target = String(to || '').trim().toLowerCase();
  if (!target) return false;
  const lead = runtimeHelpers.inferLeadName(paths).trim().toLowerCase();
  return target === 'lead' || target === 'team-lead' || (lead && target === lead);
}

function normalizeMessageSendFlags(context, flags) {
  const next = { ...(flags || {}) };
  const rawTo =
    (typeof next.member === 'string' && next.member.trim()) ||
    (typeof next.to === 'string' && next.to.trim()) ||
    '';

  if (!rawTo) {
    throw new Error('message_send requires to');
  }

  if (rawTo.toLowerCase() === 'user') {
    next.to = 'user';
    delete next.member;
  } else {
    const resolvedTo = runtimeHelpers.resolveExplicitTeamMemberName(context.paths, rawTo, {
      allowLeadAliases: true,
    });
    if (!resolvedTo && runtimeHelpers.looksLikeCrossTeamToolRecipient(rawTo)) {
      throw new Error('message_send cannot target cross_team_send. Use cross_team_send with toTeam.');
    }
    if (!resolvedTo && runtimeHelpers.looksLikeCrossTeamRecipient(rawTo)) {
      throw new Error('message_send cannot target another team. Use cross_team_send with toTeam.');
    }
    if (!resolvedTo) {
      throw new Error(`Unknown to: ${rawTo}. Use a configured team member name.`);
    }
    next.to = resolvedTo;
    next.member = resolvedTo;
  }

  if (typeof next.from === 'string' && next.from.trim()) {
    const rawFrom = next.from.trim();
    if (rawFrom.toLowerCase() !== 'user') {
      next.from = runtimeHelpers.assertExplicitTeamMemberName(context.paths, rawFrom, 'from', {
        allowLeadAliases: true,
      });
    } else {
      next.from = 'user';
    }
  }

  return next;
}

function assertUserDirectedMessageHasSender(context, flags) {
  const to = typeof flags.to === 'string' ? flags.to.trim().toLowerCase() : '';
  if (to !== 'user') return;

  const from = typeof flags.from === 'string' ? flags.from.trim() : '';
  if (!from || from.toLowerCase() === 'user') {
    throw new Error('message_send to user requires from to be the responding team member name');
  }

  runtimeHelpers.assertExplicitTeamMemberName(context.paths, from, 'from', {
    allowLeadAliases: true,
  });
}

function assertOpenCodeMessageIsNotBootstrapNoise(context, flags) {
  const to = typeof flags.to === 'string' ? flags.to.trim().toLowerCase() : '';
  if (to !== 'user' && !isLeadRecipient(context.paths, to)) {
    return;
  }
  if (hasExplicitDeliveryContext(flags)) {
    return;
  }
  const from = typeof flags.from === 'string' ? flags.from.trim() : '';
  const sender = findResolvedMember(context.paths, from);
  if (!isOpenCodeMember(sender)) {
    return;
  }
  if (!looksLikeIdleAckOnlyText(flags.text) && !looksLikeIdleAckOnlyText(flags.summary)) {
    return;
  }
  throw new Error(
    'OpenCode idle/ack-only message_send was not delivered. Wait silently unless replying to an app-delivered message or actionable task.'
  );
}

function sendMessage(context, flags) {
  const normalized = normalizeMessageSendFlags(context, normalizePlaceholderTaskRefPrefixes(flags));
  assertUserDirectedMessageHasSender(context, normalized);
  assertOpenCodeMessageIsNotBootstrapNoise(context, normalized);
  return messageStore.sendInboxMessage(context.paths, normalized);
}

function appendSentMessage(context, flags) {
  return messageStore.appendSentMessage(context.paths, flags);
}

function lookupMessage(context, messageId) {
  return messageStore.lookupMessage(context.paths, messageId);
}

module.exports = {
  appendSentMessage,
  lookupMessage,
  sendMessage,
};
