// Pure conversation identity for non-renderer callers. Keep UI exports in renderer/index.ts.
export { belongsToConversation, isLeadConversationParticipant } from './core/domain/belongsToConversation';
export {
  conversationScopeKey,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from './core/domain/conversationScope';

export { isUserAttentionMessage, isUserUnreadMessage, isAttentionUnread } from './core/domain/isUserUnreadMessage';

export type { ConversationScope } from './core/domain/conversationScope';
