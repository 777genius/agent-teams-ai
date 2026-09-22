import { createHash } from 'crypto';

interface InboxIdentityLike {
  messageId?: unknown;
  from?: unknown;
  timestamp?: unknown;
  text?: unknown;
}

export function buildLegacyInboxMessageId(from: string, timestamp: string, text: string): string {
  return `inbox-${createHash('sha256').update(`${from}\n${timestamp}\n${text}`).digest('hex').slice(0, 16)}`;
}

export function getEffectiveInboxMessageId(row: InboxIdentityLike): string | null {
  if (typeof row.messageId === 'string' && row.messageId.trim().length > 0) {
    return row.messageId;
  }
  if (
    typeof row.from !== 'string' ||
    typeof row.timestamp !== 'string' ||
    typeof row.text !== 'string'
  ) {
    return null;
  }
  return buildLegacyInboxMessageId(row.from, row.timestamp, row.text);
}
