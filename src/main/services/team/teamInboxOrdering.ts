import type { InboxMessage } from '@shared/types';

const MAX_MESSAGES_PAGE_LIVE_OVERLAY_PAYLOAD = 200;

export function compareInboxMessagesNewestFirst(left: InboxMessage, right: InboxMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const leftId = typeof left.messageId === 'string' ? left.messageId : '';
  const rightId = typeof right.messageId === 'string' ? right.messageId : '';
  return leftId.localeCompare(rightId);
}

export function capMessagesPageLiveOverlay(
  liveMessages: readonly InboxMessage[] | undefined
): InboxMessage[] {
  if (!liveMessages?.length) return [];
  if (liveMessages.length <= MAX_MESSAGES_PAGE_LIVE_OVERLAY_PAYLOAD) {
    return [...liveMessages];
  }
  return [...liveMessages]
    .sort(compareInboxMessagesNewestFirst)
    .slice(0, MAX_MESSAGES_PAGE_LIVE_OVERLAY_PAYLOAD);
}
