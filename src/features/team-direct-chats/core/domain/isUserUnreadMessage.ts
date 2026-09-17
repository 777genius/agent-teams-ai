import { normalizeConversationParticipant } from './conversationScope';

import type { InboxMessage } from '@shared/types';

export type ConversationMessageKeyFn = (message: InboxMessage) => string;

export function isOutboundUserMessage(message: InboxMessage): boolean {
  if (normalizeConversationParticipant(message.from) === 'user') {
    return true;
  }
  return message.source === 'user_sent' || message.source === 'cross_team_sent';
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
  return !readSet.has(toKey(message));
}

export function isAttentionUnread(
  message: InboxMessage,
  readSet: ReadonlySet<string>,
  toKey: ConversationMessageKeyFn
): boolean {
  return isUserUnreadMessage(message, readSet, toKey) && isAddressedToUser(message);
}
