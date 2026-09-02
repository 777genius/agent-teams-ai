import type {
  TaskStallJournalEntry,
  TaskStallJournalState,
  TaskStallSignal,
} from './TeamTaskStallTypes';

export interface TaskStallJournalMutation<T> {
  entries: TaskStallJournalEntry[];
  result: T;
  /** Set to false to skip persisting when the mutation changed nothing. Defaults to true. */
  changed?: boolean;
}

/**
 * Persistence port for the stall-monitor journal.
 *
 * Implementations MUST run the whole read-mutate-write cycle under per-team
 * mutual exclusion: reconcile scans and markAlerted calls for the same team
 * must never interleave, otherwise concurrent read-modify-write cycles can
 * silently drop each other's state transitions.
 */
export interface TaskStallJournalStore {
  update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T>;
}

function isValidState(value: unknown): value is TaskStallJournalState {
  return value === 'suspected' || value === 'alert_ready' || value === 'alerted';
}

// Every signal the journal may round-trip. A signal missing here is dropped on
// read, which silently resets the two-scan counter for that branch.
const VALID_SIGNALS = new Set<TaskStallSignal>([
  'turn_ended_after_touch',
  'mid_turn_after_touch',
  'touch_then_other_turns',
  'pending_pickup_after_unblock',
]);

function isValidSignal(value: unknown): value is TaskStallSignal {
  return typeof value === 'string' && VALID_SIGNALS.has(value as TaskStallSignal);
}

/**
 * Validates untrusted journal data (legacy JSON files, worker round-trips) and
 * drops malformed entries instead of failing the whole journal.
 */
export function sanitizeTaskStallJournalEntries(value: unknown): TaskStallJournalEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is TaskStallJournalEntry =>
        item != null &&
        typeof item === 'object' &&
        typeof (item as TaskStallJournalEntry).epochKey === 'string' &&
        typeof (item as TaskStallJournalEntry).teamName === 'string' &&
        typeof (item as TaskStallJournalEntry).taskId === 'string' &&
        ((item as TaskStallJournalEntry).branch === 'work' ||
          (item as TaskStallJournalEntry).branch === 'review') &&
        isValidSignal((item as TaskStallJournalEntry).signal) &&
        isValidState((item as TaskStallJournalEntry).state) &&
        typeof (item as TaskStallJournalEntry).consecutiveScans === 'number' &&
        typeof (item as TaskStallJournalEntry).createdAt === 'string' &&
        typeof (item as TaskStallJournalEntry).updatedAt === 'string'
    )
    .map((entry) => ({
      epochKey: entry.epochKey,
      teamName: entry.teamName,
      taskId: entry.taskId,
      branch: entry.branch,
      signal: entry.signal,
      state: entry.state,
      consecutiveScans: entry.consecutiveScans,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(typeof entry.memberName === 'string' && entry.memberName.trim()
        ? { memberName: entry.memberName }
        : {}),
      ...(typeof entry.alertedAt === 'string' && entry.alertedAt
        ? { alertedAt: entry.alertedAt }
        : {}),
      ...(typeof entry.alertCount === 'number' && Number.isFinite(entry.alertCount)
        ? { alertCount: Math.max(0, Math.trunc(entry.alertCount)) }
        : {}),
    }));
}
