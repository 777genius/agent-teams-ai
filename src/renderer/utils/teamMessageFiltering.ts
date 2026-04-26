import {
  getSanitizedInboxMessageSummary,
  getSanitizedInboxMessageText,
} from '@renderer/utils/bootstrapPromptSanitizer';
import { shouldKeepIdleMessageInActivityWhenNoiseHidden } from '@renderer/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';

import type { InboxMessage } from '@shared/types';

export interface TeamMessagesFilter {
  from: Set<string>;
  to: Set<string>;
  showNoise: boolean;
}

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

function normalizeParticipant(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeLeadNames(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const name = normalizeParticipant(value);
    if (name) {
      normalized.add(name);
    }
  }
  return normalized;
}

function isLeadAlias(value: string | undefined): boolean {
  const normalized = normalizeParticipant(value).replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

function isLeadParticipant(value: string | undefined, leadNames: Set<string>): boolean {
  const normalized = normalizeParticipant(value);
  return isLeadAlias(value) || (normalized.length > 0 && leadNames.has(normalized));
}

function isRelayDuplicateOfVisibleMessage(
  message: InboxMessage,
  original: InboxMessage | undefined,
  leadNames: Set<string>
): boolean {
  if (!original) {
    return false;
  }

  if (isInboxNoiseMessage(message.text)) {
    return true;
  }

  const isInternalLeadRelayDelivery =
    (message.source === 'runtime_delivery' || message.source === 'lead_process') &&
    original.source === 'user_sent' &&
    normalizeParticipant(original.from) === 'user' &&
    isLeadParticipant(original.to, leadNames) &&
    isLeadParticipant(message.from, leadNames) &&
    normalizeParticipant(message.to) !== 'user';

  if (isInternalLeadRelayDelivery) {
    return true;
  }

  const sameDirection =
    normalizeParticipant(message.from) === normalizeParticipant(original.from) &&
    normalizeParticipant(message.to) === normalizeParticipant(original.to);

  if (!sameDirection) {
    return false;
  }

  if (message.source === 'lead_process') {
    return true;
  }

  return normalizeMessageText(message.text) === normalizeMessageText(original.text);
}

function getRuntimeDeliveryRelayDuplicateKey(
  message: InboxMessage,
  relayOfMessageId: string
): string | null {
  if (message.source !== 'runtime_delivery') {
    return null;
  }
  const from = normalizeParticipant(message.from);
  const to = normalizeParticipant(message.to);
  const text = normalizeMessageText(message.text);
  if (!from || !to || !text) {
    return null;
  }
  return [relayOfMessageId, from, to, text].join('\0');
}

export function filterTeamMessages(
  messages: InboxMessage[],
  options: {
    includePassiveIdlePeerSummariesWhenNoiseHidden?: boolean;
    leadNames?: Iterable<string>;
    timeWindow?: { start: number; end: number } | null;
    filter: TeamMessagesFilter;
    searchQuery: string;
  }
): InboxMessage[] {
  const {
    includePassiveIdlePeerSummariesWhenNoiseHidden = false,
    leadNames: rawLeadNames,
    timeWindow,
    filter,
    searchQuery,
  } = options;
  const leadNames = normalizeLeadNames(rawLeadNames);

  let list = messages.filter((m) => m.messageKind !== 'task_comment_notification');
  if (timeWindow) {
    list = list.filter((m) => {
      const ts = new Date(m.timestamp).getTime();
      return ts >= timeWindow.start && ts < timeWindow.end;
    });
  }
  if (!filter.showNoise) {
    list = list.filter((m) => {
      const text = typeof m.text === 'string' ? m.text : '';
      if (!isInboxNoiseMessage(text)) return true;
      return (
        includePassiveIdlePeerSummariesWhenNoiseHidden &&
        shouldKeepIdleMessageInActivityWhenNoiseHidden(text)
      );
    });
  }

  const hasFrom = filter.from.size > 0;
  const hasTo = filter.to.size > 0;
  if (hasFrom && hasTo) {
    list = list.filter((m) => {
      const fromMatch = Boolean(m.from?.trim() && filter.from.has(m.from.trim()));
      const toMatch = Boolean(m.to?.trim() && filter.to.has(m.to.trim()));
      return fromMatch && toMatch;
    });
  } else if (hasFrom || hasTo) {
    list = list.filter((m) => {
      if (hasFrom) return Boolean(m.from?.trim() && filter.from.has(m.from.trim()));
      if (hasTo) return Boolean(m.to?.trim() && filter.to.has(m.to.trim()));
      return true;
    });
  }

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((m) => {
      const text = getSanitizedInboxMessageText(m).toLowerCase();
      const summary = getSanitizedInboxMessageSummary(m).toLowerCase();
      const from = (m.from ?? '').toLowerCase();
      const to = (m.to ?? '').toLowerCase();
      return text.includes(q) || summary.includes(q) || from.includes(q) || to.includes(q);
    });
  }

  const visibleMessagesById = new Map(
    list
      .map((m) => {
        const id = typeof m.messageId === 'string' ? m.messageId.trim() : '';
        return id ? ([id, m] as const) : null;
      })
      .filter((entry): entry is readonly [string, InboxMessage] => entry !== null)
  );

  const seenRuntimeDeliveryRelayDuplicates = new Set<string>();

  return list.filter((m) => {
    const relayOfMessageId =
      typeof m.relayOfMessageId === 'string' ? m.relayOfMessageId.trim() : '';
    if (!relayOfMessageId) {
      return true;
    }
    const ownMessageId = typeof m.messageId === 'string' ? m.messageId.trim() : '';
    if (relayOfMessageId === ownMessageId) {
      return true;
    }
    const runtimeDuplicateKey = getRuntimeDeliveryRelayDuplicateKey(m, relayOfMessageId);
    if (runtimeDuplicateKey) {
      if (seenRuntimeDeliveryRelayDuplicates.has(runtimeDuplicateKey)) {
        return false;
      }
      seenRuntimeDeliveryRelayDuplicates.add(runtimeDuplicateKey);
    }
    return !isRelayDuplicateOfVisibleMessage(
      m,
      visibleMessagesById.get(relayOfMessageId),
      leadNames
    );
  });
}
