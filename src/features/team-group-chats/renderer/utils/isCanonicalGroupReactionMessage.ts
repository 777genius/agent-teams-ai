import { isGroupUuid } from '../../core/domain/groupChat';

import type { InboxMessage } from '@shared/types';

/** Only persisted canonical group rows expose reactions in any renderer projection. */
export function isCanonicalGroupReactionMessage(message: InboxMessage): boolean {
  return (
    message.groupChatProtocolVersion === 1 &&
    isGroupUuid(message.groupChatId) &&
    isGroupUuid(message.messageId) &&
    message.messageId === message.groupMessageId &&
    message.to === 'user' &&
    (message.source === undefined ||
      message.source === 'inbox' ||
      message.source === 'user_sent' ||
      message.source === 'runtime_delivery')
  );
}
