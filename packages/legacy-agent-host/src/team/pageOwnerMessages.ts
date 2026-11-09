import { json } from './TeamReviewCommands.js';
import { TeamOwnerError } from './contracts.js';
import { digest, safeSegment } from './identity.js';

import type { JsonValue } from '../contracts.js';
import type { TeamGrant } from './contracts.js';

interface PageOptions {
  principalId: string;
  grant: TeamGrant;
  teamName: string;
  key: string;
  messages: JsonValue[];
  cursor?: string;
  limit?: number;
  groupChatId?: string;
}

/** Pure, bounded transport projection. The caller already holds the original authority fence. */
export function pageOwnerMessages(options: PageOptions): JsonValue {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TeamOwnerError('invalid');
  if (options.groupChatId !== undefined) safeSegment(options.groupChatId);
  const unique = new Map<string, JsonValue>();
  for (const message of options.messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message))
      throw new TeamOwnerError('hold');
    const row = message as Record<string, JsonValue>;
    if (typeof row.timestamp !== 'string') throw new TeamOwnerError('hold');
    if (
      options.groupChatId !== undefined &&
      (row.groupChatId !== options.groupChatId || row.messageId !== row.groupMessageId)
    )
      continue;
    unique.set(typeof row.messageId === 'string' ? row.messageId : digest(message), message);
  }
  // Stable sort retains original persisted order when timestamps are equal.
  const messages = [...unique.values()].sort((a, b) =>
    (a as { timestamp: string }).timestamp.localeCompare((b as { timestamp: string }).timestamp)
  );
  const revision = digest({
    principalId: options.principalId,
    grant: options.grant,
    teamName: options.teamName,
    groupChatId: options.groupChatId ?? null,
    messages,
  });
  const signature = (offset: number) =>
    digest({ key: options.key, principalId: options.principalId, revision, offset });
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (match[2] !== signature(offset)) throw new TeamOwnerError('hold');
  }
  if (offset > messages.length) throw new TeamOwnerError('hold');
  const end = messages.length - offset;
  let start = Math.max(0, end - limit);
  let page = messages.slice(start, end);
  // Reduce page length to fit the transport envelope, never silently drop history.
  while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > 384 * 1024) {
    start++;
    page = messages.slice(start, end);
  }
  const nextOffset = offset + page.length;
  const response = {
    teamName: options.teamName,
    revision,
    messages: page,
    nextCursor: start > 0 ? `${nextOffset}.${signature(nextOffset)}` : null,
    hasMore: start > 0,
  };
  if (Buffer.byteLength(JSON.stringify(response)) > 384 * 1024)
    throw new TeamOwnerError('hold');
  return json(response);
}
