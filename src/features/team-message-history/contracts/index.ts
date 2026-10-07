import type { InboxMessage } from '@shared/types';

export interface InboxMessageCursor {
  timestampMs: number;
  messageId: string;
}

export interface RawMessageWindow {
  messages: InboxMessage[];
  truncated: boolean;
}

export interface InboxMessagesWindow extends RawMessageWindow {
  sourceRevision: string;
  sourceMessageCount: number;
}

export type HistoryFailureReason =
  | 'listing_failed'
  | 'read_failed'
  | 'missing_source'
  | 'timeout'
  | 'non_file'
  | 'oversized'
  | 'invalid_json'
  | 'invalid_message'
  | 'no_progress'
  | 'invalid_cursor';

export type InboxWindowOutcome =
  | { kind: 'window'; window: InboxMessagesWindow; inboxCompleteness: 'complete' }
  | { kind: 'unavailable'; reason: HistoryFailureReason };

export type PageProgressOutcome =
  | { kind: 'prefix'; messages: InboxMessage[]; sourceTruncated: boolean }
  | { kind: 'unavailable'; reason: 'invalid_message' }
  | { kind: 'busy'; reason: 'no_progress' };
