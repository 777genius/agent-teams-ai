import type { InboxMessage } from '@shared/types';

const FALLBACK_SLICE = 80;

interface CachedMessageKey {
  readonly messageId: InboxMessage['messageId'];
  readonly timestamp: InboxMessage['timestamp'];
  readonly from: InboxMessage['from'];
  readonly text: InboxMessage['text'];
  readonly key: string;
}

const messageKeyCache = new WeakMap<InboxMessage, CachedMessageKey>();

/**
 * Stable key for a team message. Prefer messageId; otherwise build from timestamp, from, and text.
 */
export function toMessageKey(message: InboxMessage): string {
  const cached = messageKeyCache.get(message);
  if (
    cached &&
    cached.messageId === message.messageId &&
    cached.timestamp === message.timestamp &&
    cached.from === message.from &&
    cached.text === message.text
  ) {
    return cached.key;
  }

  const rawMessageId = typeof message.messageId === 'string' ? message.messageId : '';
  const trimmedMessageId = rawMessageId.trim();
  const key =
    trimmedMessageId.length > 0
      ? rawMessageId
      : `${message.timestamp}-${message.from}-${(message.text ?? '').slice(0, FALLBACK_SLICE)}`;

  messageKeyCache.set(message, {
    messageId: message.messageId,
    timestamp: message.timestamp,
    from: message.from,
    text: message.text,
    key,
  });

  return key;
}
