import { ChatList } from './ui/ChatList';
import { ChatUnreadBadges } from './ui/ChatUnreadBadges';
import { ConversationHeader } from './ui/ConversationHeader';

export {
  belongsToConversation,
  isLeadConversationParticipant,
} from '../core/domain/belongsToConversation';
export type { ChatListItem, ChatListMember } from '../core/domain/buildChatList';
export { buildChatList } from '../core/domain/buildChatList';
export type { ConversationScope, ConversationSurface } from '../core/domain/conversationScope';
export {
  conversationScopeKey,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from '../core/domain/conversationScope';
export type { ConversationUnreadCounts } from '../core/domain/countUnreadByConversation';
export {
  countUniqueUnread,
  countUnreadByConversation,
  emptyUnreadCounts,
} from '../core/domain/countUnreadByConversation';
export type { ConversationMessageKeyFn } from '../core/domain/isUserUnreadMessage';
export {
  isAddressedToUser,
  isAttentionUnread,
  isOutboundUserMessage,
  isUserUnreadMessage,
} from '../core/domain/isUserUnreadMessage';
export { pickPreviewMessage } from '../core/domain/pickPreviewMessage';
export {
  TEAM_DIRECT_CHAT_AUTO_OLDER_PAGE_CAP,
  useTeamConversationSurface,
} from './hooks/useTeamConversationSurface';
export { ChatList } from './ui/ChatList';
export { ChatListRow } from './ui/ChatListRow';
export { ChatUnreadBadges } from './ui/ChatUnreadBadges';
export { ConversationHeader } from './ui/ConversationHeader';
export type { ChatListViewItem } from './view-models/chatListViewModel';
export { buildChatListView } from './view-models/chatListViewModel';

export const teamDirectChatsRenderer = {
  ChatList,
  ConversationHeader,
  ChatUnreadBadges,
};
