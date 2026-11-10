import { json } from './TeamReviewCommands.js';
import { TeamOwnerError } from './contracts.js';
import { digest, safeSegment } from './identity.js';
import { messageSegments } from './pageOwnerSnapshot.js';

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

const MAX_PAGE_BYTES = 384 * 1024;
const MESSAGE_BYTES = 240 * 1024;
const CURSOR = /^([1-9][0-9]{0,8})\.([a-f0-9]{64})$/;

/** Reverse chronological signed transport; message parts remain private until UI reassembly. */
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
    if (options.groupChatId !== undefined &&
        (row.groupChatId !== options.groupChatId || row.messageId !== row.groupMessageId))
      continue;
    unique.set(typeof row.messageId === 'string' ? row.messageId : digest(message), message);
  }
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
  // Owner-bound cursors cannot be transferred to another principal, revision or filter.
  const signature = (offset: number) =>
    digest({ key: options.key, principalId: options.principalId, revision,
      protocol: 'message-parts-v1', offset });
  const segments = messageSegments([...messages].reverse(), MESSAGE_BYTES);
  const fragmented = segments.length !== messages.length;
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = CURSOR.exec(options.cursor);
    if (!match) throw new TeamOwnerError('invalid');
    offset = Number(match[1]);
    if (match[2] !== signature(offset)) throw new TeamOwnerError('hold');
  }
  if (offset >= segments.length && options.cursor !== undefined)
    throw new TeamOwnerError('hold');
  const base = {
    teamName: options.teamName,
    revision,
    messages: [] as JsonValue[],
    nextCursor: null as string | null,
    hasMore: false,
    ...(fragmented ? {
      messageTotal: messages.length,
      messageParts: [] as { index: number; part: number; total: number }[],
    } : {}),
  };
  let bytes = Buffer.byteLength(JSON.stringify(base));
  let end = offset;
  let distinct = 0;
  let previousIndex: number | undefined;
  let endedLargeMessage = false;
  const selected: typeof segments = [];
  for (; end < segments.length; end++) {
    const segment = segments[end]!;
    if (segment.part.index !== previousIndex) {
      // Stop at a fragmented-message boundary; the next call finishes that
      // record without consuming an extra page of older messages.
      if (distinct >= limit || endedLargeMessage) break;
      distinct++;
      previousIndex = segment.part.index;
    }
    const size = Buffer.byteLength(JSON.stringify(segment.value)) +
      (fragmented ? Buffer.byteLength(JSON.stringify(segment.part)) : 0) + 16;
    if (bytes + size > MAX_PAGE_BYTES - 256) {
      if (end === offset) throw new TeamOwnerError('hold');
      break;
    }
    selected.push(segment);
    bytes += size;
    if (segment.part.total > 1 && segment.part.part === segment.part.total - 1)
      endedLargeMessage = true;
  }
  // Logical messages appear oldest-to-newest, with each text part in original order.
  selected.sort((a, b) => b.part.index - a.part.index || a.part.part - b.part.part);
  base.messages.push(...selected.map((segment) => segment.value));
  if (fragmented)
    base.messageParts?.push(...selected.map((segment) => segment.part));
  base.nextCursor = end < segments.length ? end + '.' + signature(end) : null;
  base.hasMore = base.nextCursor !== null;
  if (Buffer.byteLength(JSON.stringify(base)) > MAX_PAGE_BYTES)
    throw new TeamOwnerError('hold');
  return json(base);
}
