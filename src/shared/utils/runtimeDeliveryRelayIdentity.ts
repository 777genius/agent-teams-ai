import type { InboxMessage } from '@shared/types/team';

export function normalizeRelayMessageText(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

export function normalizeRelayParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Exact runtime relay copies share a key even when their persisted message IDs differ. */
export function getRuntimeDeliveryRelayDuplicateKey(message: InboxMessage): string | null {
  const relayId = typeof message.relayOfMessageId === 'string' ? message.relayOfMessageId.trim() : '';
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (message.source !== 'runtime_delivery' || !relayId || relayId === messageId) {
    return null;
  }
  const from = normalizeRelayParticipant(message.from);
  const to = normalizeRelayParticipant(message.to);
  const text = normalizeRelayMessageText(message.text);
  return from && to && text ? [relayId, from, to, text].join('\0') : null;
}
