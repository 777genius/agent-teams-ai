const messageStore = require('./messageStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');

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

function sendMessage(context, flags) {
  const normalized = normalizeMessageSendFlags(context, flags);
  assertUserDirectedMessageHasSender(context, normalized);
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
