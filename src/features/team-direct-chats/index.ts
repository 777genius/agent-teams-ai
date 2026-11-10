// Pure conversation identity for non-renderer callers. Keep UI exports in renderer/index.ts.
export {
  conversationScopeKey,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from './core/domain/conversationScope';
