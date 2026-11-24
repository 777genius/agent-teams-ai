import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { isConversationLeadAlias } from '@shared/utils/leadDetection';

import type { InboxMessage } from '@shared/types/team';

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeMessageId(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLeadNames(values: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const value of values) {
    const name = normalizeParticipant(value);
    if (name) normalized.add(name);
  }
  return normalized;
}

function isLeadParticipant(value: string | undefined, leadNames: Set<string>): boolean {
  const normalized = normalizeParticipant(value);
  return isConversationLeadAlias(value) || (normalized.length > 0 && leadNames.has(normalized));
}

function isRelayDuplicateOfVisibleMessage(
  message: InboxMessage,
  original: InboxMessage | undefined,
  leadNames: Set<string>
): boolean {
  if (!original) return false;
  if (isInboxNoiseMessage(typeof message.text === 'string' ? message.text : '')) return true;

  const from = normalizeParticipant(message.from);
  const to = normalizeParticipant(message.to);
  const originalFrom = normalizeParticipant(original.from);
  const originalTo = normalizeParticipant(original.to);
  const isInternalLeadRelayDelivery =
    (message.source === 'runtime_delivery' || message.source === 'lead_process') &&
    original.source === 'user_sent' &&
    originalFrom === 'user' &&
    isLeadParticipant(original.to, leadNames) &&
    isLeadParticipant(message.from, leadNames) &&
    to !== 'user';

  if (isInternalLeadRelayDelivery) return true;
  if (from !== originalFrom || to !== originalTo) return false;
  return message.source === 'lead_process' ||
    normalizeMessageText(message.text) === normalizeMessageText(original.text);
}

function getRuntimeDeliveryRelayDuplicateKey(
  message: InboxMessage,
  relayId: string
): string | null {
  if (message.source !== 'runtime_delivery') return null;
  const from = normalizeParticipant(message.from);
  const to = normalizeParticipant(message.to);
  const text = normalizeMessageText(message.text);
  return from && to && text ? [relayId, from, to, text].join('\0') : null;
}

/** Shared relay policy. Call after visibility filtering, preserving feed order and raw text. */
export function deduplicateVisibleRelayMessages(
  messages: readonly InboxMessage[],
  rawLeadNames: Iterable<string> = []
): InboxMessage[] {
  const leadNames = normalizeLeadNames(rawLeadNames);
  const visibleMessagesById = new Map<string, InboxMessage>();
  for (const message of messages) {
    const id = normalizeMessageId(message.messageId);
    if (id) visibleMessagesById.set(id, message);
  }

  const seenRuntimeRelays = new Set<string>();
  return messages.filter((message) => {
    const relayId = normalizeMessageId(message.relayOfMessageId);
    if (!relayId || relayId === normalizeMessageId(message.messageId)) return true;
    const runtimeKey = getRuntimeDeliveryRelayDuplicateKey(message, relayId);
    if (runtimeKey) {
      if (seenRuntimeRelays.has(runtimeKey)) return false;
      seenRuntimeRelays.add(runtimeKey);
    }
    return !isRelayDuplicateOfVisibleMessage(message, visibleMessagesById.get(relayId), leadNames);
  });
}
