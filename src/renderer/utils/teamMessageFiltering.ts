import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';

import type { InboxMessage } from '@shared/types';

export interface TeamMessagesFilter {
  from: Set<string>;
  to: Set<string>;
  showNoise: boolean;
}

export function filterTeamMessages(
  messages: InboxMessage[],
  options: {
    timeWindow?: { start: number; end: number } | null;
    filter: TeamMessagesFilter;
    searchQuery: string;
  }
): InboxMessage[] {
  const { timeWindow, filter, searchQuery } = options;

  let list = messages;
  if (timeWindow) {
    list = list.filter((m) => {
      const ts = new Date(m.timestamp).getTime();
      return ts >= timeWindow.start && ts < timeWindow.end;
    });
  }
  if (!filter.showNoise) {
    list = list.filter((m) => !isInboxNoiseMessage(typeof m.text === 'string' ? m.text : ''));
  }

  const hasFrom = filter.from.size > 0;
  const hasTo = filter.to.size > 0;
  if (hasFrom && hasTo) {
    list = list.filter((m) => {
      const fromMatch = m.from?.trim() && filter.from.has(m.from.trim());
      const toMatch = m.to?.trim() && filter.to.has(m.to.trim());
      return fromMatch && toMatch;
    });
  } else if (hasFrom || hasTo) {
    list = list.filter((m) => {
      if (hasFrom) return m.from?.trim() && filter.from.has(m.from.trim());
      if (hasTo) return m.to?.trim() && filter.to.has(m.to.trim());
      return true;
    });
  }

  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((m) => {
      const text = (m.text ?? '').toLowerCase();
      const summary = (m.summary ?? '').toLowerCase();
      const from = (m.from ?? '').toLowerCase();
      const to = (m.to ?? '').toLowerCase();
      return text.includes(q) || summary.includes(q) || from.includes(q) || to.includes(q);
    });
  }

  const visibleMessageIds = new Set(
    list
      .map((m) => (typeof m.messageId === 'string' ? m.messageId.trim() : ''))
      .filter((id) => id.length > 0)
  );

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
    return !visibleMessageIds.has(relayOfMessageId);
  });
}
