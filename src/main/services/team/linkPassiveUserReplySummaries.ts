import { classifyIdleNotificationText } from '@shared/utils/idleNotificationSemantics';

import type { InboxMessage } from '@shared/types';

const PASSIVE_USER_REPLY_LINK_WINDOW_MS = 15_000;

function normalizePassiveUserReplyLinkText(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?…]+$/g, '')
    .trim();
}

function extractPassiveUserPeerSummaryBody(text: string): string | null {
  const classified = classifyIdleNotificationText(text);
  if (classified?.primaryKind !== 'heartbeat' || !classified.peerSummary) {
    return null;
  }

  const match = /^\[to\s+user\]\s*(.*)$/i.exec(classified.peerSummary);
  if (!match) {
    return null;
  }

  const body = match[1]?.trim() ?? '';
  return body.length > 0 ? body : null;
}

export function linkPassiveUserReplySummaries(messages: InboxMessage[]): InboxMessage[] {
  const canonicalReplies = messages
    .map((message) => {
      const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      if (!messageId || message.to !== 'user') {
        return null;
      }
      if (classifyIdleNotificationText(message.text)) {
        return null;
      }

      const time = Date.parse(message.timestamp);
      if (!Number.isFinite(time)) {
        return null;
      }

      return {
        messageId,
        from: message.from,
        time,
        normalizedSummary: normalizePassiveUserReplyLinkText(message.summary),
        normalizedText: normalizePassiveUserReplyLinkText(message.text),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (canonicalReplies.length === 0) {
    return messages;
  }

  let didLink = false;
  const linkedMessages = messages.map((message) => {
    if (
      typeof message.relayOfMessageId === 'string' &&
      message.relayOfMessageId.trim().length > 0
    ) {
      return message;
    }

    const body = extractPassiveUserPeerSummaryBody(message.text);
    if (!body) {
      return message;
    }

    const passiveTime = Date.parse(message.timestamp);
    if (!Number.isFinite(passiveTime)) {
      return message;
    }

    const normalizedBody = normalizePassiveUserReplyLinkText(body);
    if (!normalizedBody) {
      return message;
    }

    const matches = canonicalReplies.filter((candidate) => {
      if (candidate.from !== message.from) {
        return false;
      }
      const deltaMs = passiveTime - candidate.time;
      if (deltaMs < 0 || deltaMs > PASSIVE_USER_REPLY_LINK_WINDOW_MS) {
        return false;
      }
      if (candidate.normalizedSummary === normalizedBody) {
        return true;
      }
      return normalizedBody.length >= 6 && candidate.normalizedText.includes(normalizedBody);
    });

    if (matches.length !== 1) {
      return message;
    }

    didLink = true;
    return {
      ...message,
      relayOfMessageId: matches[0].messageId,
    };
  });

  return didLink ? linkedMessages : messages;
}
