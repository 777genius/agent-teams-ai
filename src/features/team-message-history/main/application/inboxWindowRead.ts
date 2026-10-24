import { assertValidGroupInboxRows } from '@features/team-group-chats/contracts';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';

import { sourceSemanticEntry } from '../../core/domain/messageSemantics';
import {
  compareNewestFirst,
  isMessageAfterCursor,
  validMessagePosition,
} from '../../core/domain/pageProgress';
import {
  sourceEntriesRevision,
  TeamHistoryError,
  toSourceRevision,
} from '../infrastructure/messageRevision';

import type { InboxMessageCursor, InboxMessagesWindow, InboxWindowOutcome } from '../../contracts';
import type { SourceSemanticEntry } from '../../core/domain/messageSemantics';
import type { InboxMessage } from '@shared/types';

export interface InboxMemberData {
  kind: 'raw';
  raw: string;
}

export interface InboxWindowReadPorts {
  listMembers(): Promise<string[]>;
  readMember(member: string): Promise<InboxMemberData>;
  normalize(item: unknown): InboxMessage | null;
  assignRecipient(message: InboxMessage, member: string): void;
  visit(raw: string, onItem: (item: unknown) => void): boolean;
}

export async function readInboxWindow(
  ports: InboxWindowReadPorts,
  options: { cursor?: InboxMessageCursor | null; limit: number; groupChatId?: string }
): Promise<InboxWindowOutcome> {
  const limit = Math.max(1, Math.floor(options.limit));
  const cursor = options.cursor ?? null;
  if (cursor && (!Number.isFinite(cursor.timestampMs) || !cursor.messageId.trim())) {
    return { kind: 'unavailable', reason: 'invalid_cursor' };
  }
  let members: string[];
  try {
    members = (await ports.listMembers()).sort((a, b) => a.localeCompare(b));
  } catch {
    return { kind: 'unavailable', reason: 'listing_failed' };
  }

  const revisions = new Map<string, string>();
  let messages: InboxMessage[] = [];
  let sourceMessageCount = 0;
  let truncated = false;
  try {
    for (const member of members) {
      const data = await ports.readMember(member);
      const entries: SourceSemanticEntry[] = [];
      try {
        assertValidGroupInboxRows(JSON.parse(data.raw));
      } catch {
        return { kind: 'unavailable', reason: 'invalid_json' };
      }
      let invalidPosition = false;
      const consume = (message: InboxMessage): void => {
        ports.assignRecipient(message, member);
        if (!validMessagePosition(message)) {
          invalidPosition = true;
          return;
        }
        sourceMessageCount += 1;
        if (!isTeamInternalControlMessageEnvelope(message))
          entries.push(sourceSemanticEntry(message));
        // Preserve raw revision accounting, but hide fanout before bounding top-K.
        if (message.groupChatId && message.groupMessageId !== message.messageId) return;
        if (options.groupChatId && message.groupChatId !== options.groupChatId) return;
        if (!isMessageAfterCursor(message, cursor)) return;
        messages.push(message);
        if (messages.length > limit) {
          truncated = true;
          messages.sort(compareNewestFirst);
          messages = messages.slice(0, limit);
        }
      };
      if (
        !ports.visit(data.raw, (item) => {
          const message = ports.normalize(item);
          if (message) consume(message);
        })
      ) {
        return { kind: 'unavailable', reason: 'invalid_json' };
      }
      if (invalidPosition) return { kind: 'unavailable', reason: 'invalid_message' };
      revisions.set(member, sourceEntriesRevision(entries));
    }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof TeamHistoryError ? error.reason : 'read_failed',
    };
  }
  messages.sort(compareNewestFirst);
  return {
    kind: 'window',
    inboxCompleteness: 'complete',
    window: {
      messages,
      truncated,
      sourceMessageCount,
      sourceRevision: toSourceRevision({}, Object.fromEntries(revisions)),
    },
  };
}

export function unwrapInboxWindow(outcome: InboxWindowOutcome): InboxMessagesWindow {
  if (outcome.kind === 'unavailable') throw new TeamHistoryError(outcome.reason);
  return outcome.window;
}
