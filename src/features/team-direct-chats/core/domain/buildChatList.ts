import { isLeadMember } from '@shared/utils/leadDetection';

import { belongsToConversation } from './belongsToConversation';
import {
  type ConversationScope,
  conversationScopeKey,
  createDirectScope,
  TEAM_FEED_SCOPE,
} from './conversationScope';
import {
  type ConversationUnreadCounts,
  countUnreadByConversation,
  emptyUnreadCounts,
} from './countUnreadByConversation';
import { type ConversationMessageKeyFn } from './isUserUnreadMessage';
import { pickPreviewMessage } from './pickPreviewMessage';
import { sortChatListItems } from './sortChatList';

import type { InboxMessage } from '@shared/types';

export interface ChatListMember {
  name: string;
  color?: string;
  role?: string;
  agentType?: string;
}

export interface ChatListItem {
  scope: ConversationScope;
  displayName: string;
  member?: ChatListMember;
  previewMessage: InboxMessage | null;
  latestActivityTimestamp: string | null;
  unreadCount: number;
  attentionCount: number;
}

export interface BuildChatListArgs {
  members: readonly ChatListMember[];
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
  toKey: ConversationMessageKeyFn;
  teamFeedLabel: string;
  leadNames: Iterable<string>;
  sortByActivity?: boolean;
}

function orderMembers(members: readonly ChatListMember[]): ChatListMember[] {
  const lead = members.find(isLeadMember);
  if (!lead) {
    return [...members];
  }
  return [lead, ...members.filter((member) => member !== lead)];
}

function scopedMessages(
  messages: readonly InboxMessage[],
  scope: ConversationScope,
  leadNames: Iterable<string>
): InboxMessage[] {
  return messages.filter((message) => belongsToConversation(message, scope, leadNames));
}

function attachCounts(
  item: Omit<ChatListItem, 'unreadCount' | 'attentionCount'>,
  counts: Map<string, ConversationUnreadCounts>
): ChatListItem {
  const unread = counts.get(conversationScopeKey(item.scope)) ?? emptyUnreadCounts();
  return {
    ...item,
    unreadCount: unread.unreadCount,
    attentionCount: unread.attentionCount,
  };
}

export function buildChatList({
  members,
  messages,
  readSet,
  toKey,
  teamFeedLabel,
  leadNames,
  sortByActivity = false,
}: BuildChatListArgs): ChatListItem[] {
  const orderedMembers = orderMembers(members);
  const scopes: ConversationScope[] = [
    TEAM_FEED_SCOPE,
    ...orderedMembers.map((member) => createDirectScope(member.name)),
  ];
  const counts = countUnreadByConversation(messages, scopes, readSet, toKey, leadNames);
  const leadNameList = [...leadNames];
  const teamScoped = scopedMessages(messages, TEAM_FEED_SCOPE, leadNameList);

  const rows: ChatListItem[] = [
    attachCounts(
      {
        scope: TEAM_FEED_SCOPE,
        displayName: teamFeedLabel,
        previewMessage: pickPreviewMessage(teamScoped),
        latestActivityTimestamp: teamScoped[0]?.timestamp ?? null,
      },
      counts
    ),
  ];

  for (const member of orderedMembers) {
    const scope = createDirectScope(member.name);
    const scoped = scopedMessages(messages, scope, leadNameList);
    rows.push(
      attachCounts(
        {
          scope,
          displayName: member.name,
          member,
          previewMessage: pickPreviewMessage(scoped),
          latestActivityTimestamp: scoped[0]?.timestamp ?? null,
        },
        counts
      )
    );
  }

  return sortChatListItems(rows, sortByActivity);
}
