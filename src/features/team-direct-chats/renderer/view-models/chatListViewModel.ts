import {
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';

import {
  buildChatList,
  type ChatListItem,
  type ChatListMember,
} from '../../core/domain/buildChatList';
import { type ConversationMessageKeyFn } from '../../core/domain/isUserUnreadMessage';

import type { InboxMessage } from '@shared/types';

const PREVIEW_MAX_LENGTH = 88;

export interface ChatListViewItem extends Omit<
  ChatListItem,
  'previewMessage' | 'latestActivityTimestamp'
> {
  previewText: string;
  previewFrom: string | null;
  previewTimestamp: string | null;
}

function previewFromMessage(
  message: InboxMessage | null,
  emptyPreview: string
): Pick<ChatListViewItem, 'previewText' | 'previewFrom' | 'previewTimestamp'> {
  if (!message) {
    return { previewText: emptyPreview, previewFrom: null, previewTimestamp: null };
  }
  const summary = getSanitizedInboxMessageSummary(message).replace(/\s+/g, ' ').trim();
  const text = (summary || getSanitizedInboxMessageText(message)).replace(/\s+/g, ' ').trim();
  if (!text) {
    return { previewText: emptyPreview, previewFrom: null, previewTimestamp: null };
  }
  return {
    previewText:
      text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : text,
    previewFrom: message.from,
    previewTimestamp: message.timestamp,
  };
}

export function toChatListViewItems(
  items: readonly ChatListItem[],
  emptyPreview: string
): ChatListViewItem[] {
  return items.map((item) => ({
    scope: item.scope,
    displayName: item.displayName,
    member: item.member,
    unreadCount: item.unreadCount,
    attentionCount: item.attentionCount,
    ...previewFromMessage(item.previewMessage, emptyPreview),
  }));
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
}): ChatListViewItem[] {
  return toChatListViewItems(buildChatList(args), args.emptyPreview);
}
