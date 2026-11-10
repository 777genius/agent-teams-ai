import type { InboxMessage } from '@shared/types';

/**
 * Ordering cursor for the lead-inbox messages that drive member-spawn tracking.
 * Ordered primarily by timestamp, then by messageId as a stable tiebreaker so
 * two messages sharing a timestamp still order deterministically.
 */
export interface MemberSpawnInboxCursor {
  timestamp: string;
  messageId: string;
}

export function compareMemberSpawnInboxCursor(
  left: MemberSpawnInboxCursor,
  right: MemberSpawnInboxCursor
): number {
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);

  if (leftValid && rightValid && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return left.messageId.localeCompare(right.messageId);
}

export function toMemberSpawnInboxCursor(
  message: Pick<InboxMessage, 'timestamp' | 'messageId'>
): MemberSpawnInboxCursor | null {
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (!messageId) {
    return null;
  }
  return {
    timestamp: message.timestamp,
    messageId,
  };
}

export function maxMemberSpawnInboxCursor(
  left: MemberSpawnInboxCursor | undefined,
  right: MemberSpawnInboxCursor
): MemberSpawnInboxCursor {
  if (!left) {
    return right;
  }
  return compareMemberSpawnInboxCursor(left, right) >= 0 ? left : right;
}

export function isMemberSpawnHeartbeatTimestampNewer(
  previous: string | undefined,
  incoming: string | undefined
): boolean {
  const normalizedIncoming = incoming?.trim();
  if (!normalizedIncoming) {
    return false;
  }
  const normalizedPrevious = previous?.trim();
  if (!normalizedPrevious) {
    return true;
  }

  const previousMs = Date.parse(normalizedPrevious);
  const incomingMs = Date.parse(normalizedIncoming);
  if (Number.isFinite(previousMs) && Number.isFinite(incomingMs)) {
    return incomingMs > previousMs;
  }
  return normalizedIncoming > normalizedPrevious;
}
