import type { InboxMessage } from '@shared/types';

export function toTestKey(message: InboxMessage): string {
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId.length > 0) {
    return message.messageId ?? messageId;
  }
  return `${message.timestamp}-${message.from}-${(message.text ?? '').slice(0, 80)}`;
}

export function msg(
  overrides: Partial<InboxMessage> & Pick<InboxMessage, 'from' | 'text'>
): InboxMessage {
  return {
    timestamp: overrides.timestamp ?? '2026-09-17T12:00:00.000Z',
    read: overrides.read ?? false,
    ...overrides,
  };
}
