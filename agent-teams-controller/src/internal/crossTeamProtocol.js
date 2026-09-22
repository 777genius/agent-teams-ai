// Cross-team message protocol constants.
// Mirror of src/shared/constants/crossTeam.ts — keep in sync.

const CROSS_TEAM_TAG_NAME = 'cross-team';
const CROSS_TEAM_ATTR_FROM = 'from';
const CROSS_TEAM_ATTR_DEPTH = 'depth';
const CROSS_TEAM_ATTR_CONVERSATION_ID = 'conversationId';
const CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID = 'replyToConversationId';
const CROSS_TEAM_SOURCE = 'cross_team';
const CROSS_TEAM_SENT_SOURCE = 'cross_team_sent';

function escapeCrossTeamAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCrossTeamPrefix(from, chainDepth, meta) {
  const attrs = [
    `${CROSS_TEAM_ATTR_FROM}="${escapeCrossTeamAttribute(from)}"`,
    `${CROSS_TEAM_ATTR_DEPTH}="${String(chainDepth)}"`,
  ];
  if (meta && meta.conversationId) {
    attrs.push(
      `${CROSS_TEAM_ATTR_CONVERSATION_ID}="${escapeCrossTeamAttribute(meta.conversationId)}"`
    );
  }
  if (meta && meta.replyToConversationId) {
    attrs.push(
      `${CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID}="${escapeCrossTeamAttribute(meta.replyToConversationId)}"`
    );
  }
  return `<${CROSS_TEAM_TAG_NAME} ${attrs.join(' ')} />`;
}

function formatCrossTeamText(from, chainDepth, text, meta) {
  return `${formatCrossTeamPrefix(from, chainDepth, meta)}\n${text}`;
}

module.exports = {
  CROSS_TEAM_TAG_NAME,
  CROSS_TEAM_SOURCE,
  CROSS_TEAM_SENT_SOURCE,
  formatCrossTeamPrefix,
  formatCrossTeamText,
};
