const desktopBinding = require('./desktopControlBinding.js');

// Group persistence and delivery belong to the bound desktop main process.
async function request(context, action, flags = {}, timeoutMs = 30000) {
  const urls = desktopBinding.boundControlBaseUrls(context, flags);
  if (!urls) throw new Error('Group chats require the app-bound team control API.');
  const from = typeof flags.from === 'string' ? flags.from.trim() : '';
  if (!from || from.toLowerCase() === 'user') {
    throw new Error('from must be your configured teammate name; user is reserved for the app.');
  }
  const baseUrl = urls[0];
  const bound = desktopBinding.boundRequestOptions(baseUrl);
  const response = await fetch(
    `${baseUrl}/api/teams/${encodeURIComponent(context.teamName)}/group-chats/${action}`,
    {
      ...bound,
      method: 'POST',
      headers: { ...bound.headers, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ ...flags, from }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    const detail = payload?.error;
    const error = new Error(
      typeof detail === 'string'
        ? detail
        : detail?.message || `Group chat request failed (${response.status})`
    );
    if (detail && typeof detail.code === 'string') error.code = detail.code;
    throw error;
  }
  return payload;
}

async function listGroupChats(context, flags = {}) {
  return request(context, 'list', { from: flags.from });
}

async function sendGroupMessage(context, flags = {}) {
  const { from, groupChatId, messageId, text, summary, taskRefs, relayOfMessageId } = flags;
  return request(context, 'send', {
    from,
    groupChatId,
    messageId,
    text,
    summary,
    taskRefs,
    relayOfMessageId,
  });
}

async function buildGroupChatBriefing(context, memberName) {
  const instruction =
    'Group chats: call group_chat_list(teamName, from) for a fresh catalog before proactive messages. Reply to a group with group_chat_send and the exact groupChatId, a new UUID messageId, and relayOfMessageId set to the physical inbound messageId. Never send a group reply through message_send or private user DM. Archived groups are readable but reject new posts. A blocked group send must not fall back to a private message.';
  if (!desktopBinding.isDesktopBound()) return instruction;
  try {
    const catalog = await request(context, 'list', { from: memberName }, 3000);
    return `${instruction}\nCurrent group chat catalog:\n${JSON.stringify(catalog)}`;
  } catch (error) {
    return `${instruction}\nCurrent catalog unavailable: ${error.message}. Refresh with group_chat_list before sending.`;
  }
}

module.exports = { listGroupChats, sendGroupMessage, buildGroupChatBriefing };
