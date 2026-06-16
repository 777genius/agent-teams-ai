import type { InboxMessage, MessagesPage } from '@shared/types';

export function getLiveLeadProcessMessageKey(message: {
  messageId?: string;
  timestamp: string;
  from: string;
  text: string;
}): string {
  if (typeof message.messageId === 'string' && message.messageId.trim().length > 0) {
    return message.messageId;
  }
  return `${message.timestamp}\0${message.from}\0${(message.text ?? '').slice(0, 80)}`;
}

export function mergeLiveLeadProcessMessages(
  durableMessages: InboxMessage[],
  liveMessages: InboxMessage[]
): InboxMessage[] {
  if (liveMessages.length === 0) {
    return durableMessages;
  }

  const normalizeText = (text: string): string => text.trim().replace(/\r\n/g, '\n');
  const isLeadThoughtLike = (msg: { source?: unknown; to?: string }): boolean =>
    !msg.to && (msg.source === 'lead_process' || msg.source === 'lead_session');
  const getLeadThoughtFingerprint = (msg: {
    from: string;
    text: string;
    leadSessionId?: string;
  }): string => `${msg.leadSessionId ?? ''}\0${msg.from}\0${normalizeText(msg.text)}`;

  const existingTextFingerprints = new Set<string>();
  for (const msg of durableMessages) {
    if (typeof msg.from !== 'string' || typeof msg.text !== 'string') continue;
    if (!isLeadThoughtLike(msg)) continue;
    existingTextFingerprints.add(getLeadThoughtFingerprint(msg));
  }

  const leadProcessTextFingerprints = new Set<string>();
  const contentSeen = new Map<string, number>();
  const merged: InboxMessage[] = [];
  const seen = new Set<string>();

  for (const msg of [...durableMessages, ...liveMessages]) {
    if (msg.source === 'lead_process' && !msg.to) {
      const fp = getLeadThoughtFingerprint(msg);
      if (existingTextFingerprints.has(fp) || leadProcessTextFingerprints.has(fp)) {
        continue;
      }
      leadProcessTextFingerprints.add(fp);
    }

    if (typeof msg.to === 'string' && msg.to.trim().length > 0) {
      const contentFp = `${msg.from}\0${msg.to}\0${(msg.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`;
      const msgMs = Date.parse(msg.timestamp);
      const existingMs = contentSeen.get(contentFp);
      if (existingMs !== undefined && Math.abs(msgMs - existingMs) <= 5000) {
        continue;
      }
      contentSeen.set(contentFp, msgMs);
    }

    const key = getLiveLeadProcessMessageKey(msg);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(msg);
  }

  merged.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  return merged;
}

export function mergeLiveLeadProcessMessagesPage(input: {
  durableMessages: InboxMessage[];
  liveMessages: InboxMessage[];
  limit: number;
  feedRevision: string;
  durableHasMoreAfterWindow?: boolean;
}): MessagesPage {
  const displayMessages = mergeLiveLeadProcessMessages(
    input.durableMessages,
    input.liveMessages
  ).slice(0, input.limit);

  if (displayMessages.length === 0) {
    return {
      messages: displayMessages,
      nextCursor: null,
      hasMore: false,
      feedRevision: input.feedRevision,
    };
  }

  const durableMessageIndexByKey = new Map(
    input.durableMessages.map((message, index) => [getLiveLeadProcessMessageKey(message), index])
  );
  let lastDurableDisplayed: InboxMessage | null = null;
  for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
    const candidate = displayMessages[index];
    if (durableMessageIndexByKey.has(getLiveLeadProcessMessageKey(candidate))) {
      lastDurableDisplayed = candidate;
      break;
    }
  }

  if (!lastDurableDisplayed) {
    const boundary = displayMessages[displayMessages.length - 1];
    return {
      messages: displayMessages,
      nextCursor:
        input.durableMessages.length > 0 || input.durableHasMoreAfterWindow
          ? `${boundary.timestamp}|${boundary.messageId ?? ''}`
          : null,
      hasMore: input.durableMessages.length > 0 || Boolean(input.durableHasMoreAfterWindow),
      feedRevision: input.feedRevision,
    };
  }

  const durableIndex =
    durableMessageIndexByKey.get(getLiveLeadProcessMessageKey(lastDurableDisplayed)) ??
    Number.POSITIVE_INFINITY;
  const durableHasMore =
    durableIndex < input.durableMessages.length - 1 || Boolean(input.durableHasMoreAfterWindow);

  return {
    messages: displayMessages,
    nextCursor: durableHasMore
      ? `${lastDurableDisplayed.timestamp}|${lastDurableDisplayed.messageId ?? ''}`
      : null,
    hasMore: durableHasMore,
    feedRevision: input.feedRevision,
  };
}
