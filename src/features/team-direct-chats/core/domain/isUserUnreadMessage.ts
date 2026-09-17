import { CROSS_TEAM_SENT_SOURCE } from '@shared/constants/crossTeam';

import { normalizeConversationParticipant } from './conversationScope';

import type { InboxMessage } from '@shared/types';

export type ConversationMessageKeyFn = (message: InboxMessage) => string;

export function isOutboundUserMessage(message: InboxMessage): boolean {
  if (normalizeConversationParticipant(message.from) === 'user') {
    return true;
  }
  return message.source === 'user_sent' || message.source === CROSS_TEAM_SENT_SOURCE;
}

export function isAddressedToUser(message: InboxMessage): boolean {
  if (isOutboundUserMessage(message)) {
    return false;
  }
  return normalizeConversationParticipant(message.to) === 'user';
}

export function isUserUnreadMessage(
  message: InboxMessage,
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn
): boolean {
  if (isOutboundUserMessage(message)) {
    return false;
  }
  if (readSet.has(toKey(message))) {
    return false;
  }
  // Agent-to-user DMs use localStorage as the source of truth: main may persist
  // `read: true` after the agent consumes the copy. Other inbound rows (bootstrap,
  // lead thoughts, relays) keep `message.read` as an upgrade/backfill fallback.
  if (isAddressedToUser(message)) {
    return true;
  }
  return message.read !== true;
}

export function isAttentionUnread(
  message: InboxMessage,
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn
): boolean {
  return isUserUnreadMessage(message, readSet, toKey) && isAddressedToUser(message);
}
