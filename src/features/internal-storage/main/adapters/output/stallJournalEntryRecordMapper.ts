import { sanitizeTaskStallJournalEntries } from '@main/services/team/stallMonitor/TaskStallJournalStore';

import type { StallJournalEntryRecord } from '../../../contracts/internalStorageContracts';
import type { TaskStallJournalEntry } from '@main/services/team/stallMonitor/TeamTaskStallTypes';

export function stallJournalEntryToRecord(entry: TaskStallJournalEntry): StallJournalEntryRecord {
  return {
    epochKey: entry.epochKey,
    teamName: entry.teamName,
    taskId: entry.taskId,
    memberName: entry.memberName ?? null,
    branch: entry.branch,
    signal: entry.signal,
    state: entry.state,
    consecutiveScans: entry.consecutiveScans,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    alertedAt: entry.alertedAt ?? null,
  };
}

/**
 * Records cross a worker/database boundary, so they re-enter domain code
 * through the same sanitizer the legacy JSON reader uses; malformed rows are
 * dropped rather than crashing the stall monitor.
 */
export function stallJournalRecordsToEntries(
  records: StallJournalEntryRecord[]
): TaskStallJournalEntry[] {
  return sanitizeTaskStallJournalEntries(
    records.map((record) => ({
      ...record,
      memberName: record.memberName ?? undefined,
      alertedAt: record.alertedAt ?? undefined,
    }))
  );
}

function recordSortKey(record: StallJournalEntryRecord): string {
  return `${record.teamName}\u0000${record.epochKey}`;
}

function normalizeForComparison(records: StallJournalEntryRecord[]): string {
  return JSON.stringify(
    [...records]
      .sort((a, b) => recordSortKey(a).localeCompare(recordSortKey(b)))
      .map((record) => [
        record.epochKey,
        record.teamName,
        record.taskId,
        record.memberName,
        record.branch,
        record.signal,
        record.state,
        record.consecutiveScans,
        record.createdAt,
        record.updatedAt,
        record.alertedAt,
      ])
  );
}

/** Order-insensitive equality used to verify the JSON -> SQLite import. */
export function areStallJournalRecordSetsEquivalent(
  left: StallJournalEntryRecord[],
  right: StallJournalEntryRecord[]
): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

export function resolveStallJournalRecordConflict(
  canonical: StallJournalEntryRecord,
  incoming: StallJournalEntryRecord
): StallJournalEntryRecord {
  const rank = (state: string): number =>
    state === 'alerted' ? 2 : state === 'alert_ready' ? 1 : 0;
  const canonicalRank = rank(canonical.state);
  const incomingRank = rank(incoming.state);
  if (canonicalRank !== incomingRank) return incomingRank > canonicalRank ? incoming : canonical;
  if (canonical.consecutiveScans !== incoming.consecutiveScans) {
    return incoming.consecutiveScans > canonical.consecutiveScans ? incoming : canonical;
  }
  return isLater(incoming.updatedAt, canonical.updatedAt) ? incoming : canonical;
}

function isLater(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && (!Number.isFinite(rightMs) || leftMs > rightMs);
}
