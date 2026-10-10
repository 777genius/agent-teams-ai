import { getInboxMessageQuoteText } from './agentMessageFormatting';

import type { MessageTaskSeed } from '@renderer/types/messageTaskSeed';
import type { InboxMessage } from '@shared/types';

export function buildMessageTaskSeed(
  message: InboxMessage,
  teamName: string,
  timestamp: string,
  autoSummary: string | null,
  structured: Record<string, unknown> | null
): MessageTaskSeed {
  const plainText = structured
    ? JSON.stringify(structured, null, 2)
    : getInboxMessageQuoteText(message);
  return {
    subject: message.summary || autoSummary || `Task from ${message.from}`,
    description: `From: ${message.from}\nAt: ${timestamp}\n\n${plainText}`.slice(0, 2000),
    source: { teamName, groupChatId: message.groupChatId },
  };
}
