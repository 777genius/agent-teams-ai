import { isAddressedToUser } from './isUserUnreadMessage';

import type { InboxMessage } from '@shared/types';

/**
 * `messages` must already be newest-first (canonical feed order).
 * Prefers the newest addressed-to-user message; otherwise the newest visible.
 */
export function pickPreviewMessage(messages: readonly InboxMessage[]): InboxMessage | null {
  const addressed = messages.find(isAddressedToUser);
  if (addressed) {
    return addressed;
  }
  return messages[0] ?? null;
}
