import { sanitizeTaskCommentNotificationJournalEntries } from '@main/services/team/TaskCommentNotificationJournalStore';

import type { CommentJournalEntryRecord } from '../../../contracts/internalStorageContracts';
import type { TaskCommentNotificationJournalEntry } from '@main/services/team/TaskCommentNotificationJournalStore';

export function commentJournalEntryToRecord(
  teamName: string,
  entry: TaskCommentNotificationJournalEntry
): CommentJournalEntryRecord {
  return {
    key: entry.key,
    teamName,
    taskId: entry.taskId,
    commentId: entry.commentId,
    author: entry.author,
    commentCreatedAt: entry.commentCreatedAt ?? null,
    messageId: entry.messageId ?? null,
    state: entry.state,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sentAt: entry.sentAt ?? null,
  };
}

/**
 * Records cross a worker/database boundary, so they re-enter domain code
 * through the same sanitizer the legacy JSON reader uses; malformed rows are
 * dropped rather than crashing notification processing.
 */
export function commentJournalRecordsToEntries(
  records: CommentJournalEntryRecord[]
): TaskCommentNotificationJournalEntry[] {
  return sanitizeTaskCommentNotificationJournalEntries(
    records.map((record) => ({
      ...record,
      commentCreatedAt: record.commentCreatedAt ?? undefined,
      messageId: record.messageId ?? undefined,
      sentAt: record.sentAt ?? undefined,
    }))
  );
}

function recordSortKey(record: CommentJournalEntryRecord): string {
  return `${record.teamName} ${record.key}`;
}

function normalizeForComparison(records: CommentJournalEntryRecord[]): string {
  return JSON.stringify(
    [...records]
      .sort((a, b) => recordSortKey(a).localeCompare(recordSortKey(b)))
      .map((record) => [
        record.key,
        record.teamName,
        record.taskId,
        record.commentId,
        record.author,
        record.commentCreatedAt,
        record.messageId,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.sentAt,
      ])
  );
}

/** Order-insensitive equality used to verify the JSON -> SQLite import. */
export function areCommentJournalRecordSetsEquivalent(
  left: CommentJournalEntryRecord[],
  right: CommentJournalEntryRecord[]
): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

export function resolveCommentJournalRecordConflict(
  canonical: CommentJournalEntryRecord,
  incoming: CommentJournalEntryRecord
): CommentJournalEntryRecord {
  const rank = (state: string): number => (state === 'sent' ? 2 : state === 'pending_send' ? 1 : 0);
  const canonicalRank = rank(canonical.state);
  const incomingRank = rank(incoming.state);
  if (canonicalRank !== incomingRank) return incomingRank > canonicalRank ? incoming : canonical;
  const incomingMs = Date.parse(incoming.updatedAt);
  const canonicalMs = Date.parse(canonical.updatedAt);
  return Number.isFinite(incomingMs) && (!Number.isFinite(canonicalMs) || incomingMs > canonicalMs)
    ? incoming
    : canonical;
}
