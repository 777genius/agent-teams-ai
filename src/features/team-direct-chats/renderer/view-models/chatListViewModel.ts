import {
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { truncateChatPreview } from '@renderer/utils/chatPreview';
import { isLeadThoughtSourceMessage, LEAD_THOUGHT_SPEAKER_NAME } from '@shared/utils/leadDetection';

import {
  buildChatList,
  type ChatListItem,
  type ChatListMember,
} from '../../core/domain/buildChatList';
import { conversationScopeKey } from '../../core/domain/conversationScope';
import { type ConversationMessageKeyFn } from '../../core/domain/isUserUnreadMessage';

import type { InboxMessage } from '@shared/types';

export interface ChatListViewItem extends Omit<
  ChatListItem,
  'previewMessage' | 'latestActivityTimestamp'
> {
  previewText: string;
  previewFrom: string | null;
  previewTimestamp: string | null;
  draft?: ChatListDraftPreview;
}

export interface ChatListDraftPreview {
  preview: string;
  updatedAt: number;
  attachmentCount: number;
  chipCount: number;
  editorKind: 'plain' | 'revision';
}

function previewCopy(
  message: InboxMessage | null,
  emptyPreview: string
): Pick<ChatListViewItem, 'previewText' | 'previewFrom'> {
  if (!message) {
    return { previewText: emptyPreview, previewFrom: null };
  }
  const summary = getSanitizedInboxMessageSummary(message).replace(/\s+/g, ' ').trim();
  const text = (summary || getSanitizedInboxMessageText(message)).replace(/\s+/g, ' ').trim();
  if (!text) {
    return { previewText: emptyPreview, previewFrom: null };
  }
  return {
    previewText: truncateChatPreview(text),
    previewFrom:
      isLeadThoughtSourceMessage(message) && message.from !== 'system' && message.from !== 'user'
        ? LEAD_THOUGHT_SPEAKER_NAME
        : message.from,
  };
}

export function toChatListViewItems(
  items: readonly ChatListItem[],
  emptyPreview: string,
  draftsByScope: ReadonlyMap<string, ChatListDraftPreview> = new Map()
): ChatListViewItem[] {
  return items.map((item) => {
    const draft = draftsByScope.get(conversationScopeKey(item.scope));
    return {
      scope: item.scope,
      displayName: item.displayName,
      member: item.member,
      unreadCount: item.unreadCount,
      attentionCount: item.attentionCount,
      previewTimestamp: item.latestActivityTimestamp,
      ...previewCopy(item.previewMessage, emptyPreview),
      ...(draft ? { draft } : {}),
    };
  });
}

export function buildChatListView(args: {
  members: readonly ChatListMember[];
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
  toKey: ConversationMessageKeyFn;
  teamFeedLabel: string;
  emptyPreview: string;
  leadNames: Iterable<string>;
  sortByActivity?: boolean;
  draftsByScope?: ReadonlyMap<string, ChatListDraftPreview>;
}): ChatListViewItem[] {
  return toChatListViewItems(buildChatList(args), args.emptyPreview, args.draftsByScope);
}
