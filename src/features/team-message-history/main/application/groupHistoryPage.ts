import { parseHistoryCursor } from '../../core/domain/pageProgress';
import { TeamHistoryError } from '../infrastructure/messageRevision';

import type { InboxMessageCursor, InboxMessagesWindow } from '../../contracts';
import type { MessagesPage } from '@shared/types';

/** Canonical-only source isolates group reads from unrelated physical inbox failures. */
export async function readGroupHistoryPage(
  readWindow: (options: {
    cursor?: InboxMessageCursor | null;
    limit: number;
    groupChatId: string;
  }) => Promise<InboxMessagesWindow>,
  options: { cursor?: string | null; limit: number; groupChatId: string; sourceIdentity: string }
): Promise<MessagesPage> {
  const scopePrefix = `${encodeURIComponent(options.sourceIdentity)}|${encodeURIComponent(options.groupChatId)}|`;
  if (options.cursor && !options.cursor.startsWith(scopePrefix))
    throw new TeamHistoryError('invalid_cursor');
  const parsed = parseHistoryCursor(
    options.cursor ? options.cursor.slice(scopePrefix.length) : options.cursor
  );
  if (parsed.kind === 'invalid-request') throw new TeamHistoryError(parsed.reason);
  const limit = Math.max(1, Math.floor(options.limit));
  const window = await readWindow({
    cursor: parsed.cursor,
    limit: limit + 1,
    groupChatId: options.groupChatId,
  });
  const messages = window.messages.slice(0, limit);
  const hasMore = window.truncated || window.messages.length > limit;
  const last = messages.at(-1);
  return {
    messages,
    hasMore,
    nextCursor: hasMore && last ? `${scopePrefix}${last.timestamp}|${last.messageId}` : null,
    feedRevision: `${options.groupChatId}:${window.sourceRevision}`,
  };
}
