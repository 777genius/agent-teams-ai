import { belongsToConversation } from './belongsToConversation';
import { type ConversationScope, conversationScopeKey, TEAM_FEED_SCOPE } from './conversationScope';
import {
  type ConversationMessageKeyFn,
  isAddressedToUser,
  isUserUnreadMessage,
} from './isUserUnreadMessage';

import type { InboxMessage } from '@shared/types';

export interface ConversationUnreadCounts {
  unreadCount: number;
  attentionCount: number;
}

export function emptyUnreadCounts(): ConversationUnreadCounts {
  return { unreadCount: 0, attentionCount: 0 };
}

export function countUniqueUnread(
  messages: readonly InboxMessage[],
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn
): ConversationUnreadCounts {
  const unreadKeys = new Set<string>();
  const attentionKeys = new Set<string>();
  for (const message of messages) {
    if (!isUserUnreadMessage(message, readSet, toKey)) {
      continue;
    }
    const key = toKey(message);
    unreadKeys.add(key);
    if (isAddressedToUser(message)) {
      attentionKeys.add(key);
    }
  }
  return {
    unreadCount: unreadKeys.size,
    attentionCount: attentionKeys.size,
  };
}

export function countUnreadByConversation(
  messages: readonly InboxMessage[],
  scopes: readonly ConversationScope[],
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn,
  leadNames: Iterable<string>
): Map<string, ConversationUnreadCounts> {
  const scopedList: ConversationScope[] = [...scopes];
  const teamFeedKey = conversationScopeKey(TEAM_FEED_SCOPE);
  if (!scopedList.some((scope) => conversationScopeKey(scope) === teamFeedKey)) {
    scopedList.unshift(TEAM_FEED_SCOPE);
  }
  const counts = new Map<string, ConversationUnreadCounts>();
  for (const scope of scopedList) {
    counts.set(conversationScopeKey(scope), emptyUnreadCounts());
  }

  const leadNameList = [...leadNames];
  const seenKeys = new Map<string, Set<string>>();

  for (const message of messages) {
    if (!isUserUnreadMessage(message, readSet, toKey)) {
      continue;
    }
    const addressed = isAddressedToUser(message);
    const messageKey = toKey(message);
    for (const scope of scopedList) {
      const key = conversationScopeKey(scope);
      const scopeCounts = counts.get(key);
      if (!scopeCounts || !belongsToConversation(message, scope, leadNameList)) {
        continue;
      }
      let seen = seenKeys.get(key);
      if (!seen) {
        seen = new Set();
        seenKeys.set(key, seen);
      }
      if (seen.has(messageKey)) {
        continue;
      }
      seen.add(messageKey);
      scopeCounts.unreadCount += 1;
      if (addressed) {
        scopeCounts.attentionCount += 1;
      }
    }
  }

  return counts;
}
