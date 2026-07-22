export type TaskCommentNotificationState = 'seeded' | 'pending_send' | 'sent';

export interface TaskCommentNotificationJournalEntry {
  key: string;
  taskId: string;
  commentId: string;
  author: string;
  commentCreatedAt?: string;
  messageId?: string;
  state: TaskCommentNotificationState;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface TaskCommentNotificationJournalMutation<T> {
  result: T;
  changed: boolean;
}

/**
 * Persistence port for the task-comment notification journal.
 *
 * Semantics that implementations MUST preserve:
 * - exists() is an initialization marker, not an entry count: a journal that
 *   was initialized with zero entries still exists. TeamDataService uses this
 *   to decide between seeding a historical baseline and notifying, so getting
 *   it wrong spams the lead with notifications for old comments.
 * - withEntries() runs the whole read-mutate-write cycle under per-team
 *   mutual exclusion; the mutator may be async and mutates the array in place.
 */
export interface TaskCommentNotificationJournalStore {
  exists(teamName: string): Promise<boolean>;
  ensureInitialized(teamName: string): Promise<void>;
  read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]>;
  withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T>;
}

function isValidState(value: unknown): value is TaskCommentNotificationState {
  return value === 'seeded' || value === 'pending_send' || value === 'sent';
}

/**
 * Validates untrusted journal data (legacy JSON files, worker round-trips) and
 * drops malformed entries instead of failing the whole journal.
 */
export function sanitizeTaskCommentNotificationJournalEntries(
  value: unknown
): TaskCommentNotificationJournalEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is TaskCommentNotificationJournalEntry =>
        item != null &&
        typeof item === 'object' &&
        typeof (item as TaskCommentNotificationJournalEntry).key === 'string' &&
        typeof (item as TaskCommentNotificationJournalEntry).taskId === 'string' &&
        typeof (item as TaskCommentNotificationJournalEntry).commentId === 'string' &&
        typeof (item as TaskCommentNotificationJournalEntry).author === 'string' &&
        isValidState((item as TaskCommentNotificationJournalEntry).state) &&
        typeof (item as TaskCommentNotificationJournalEntry).createdAt === 'string' &&
        typeof (item as TaskCommentNotificationJournalEntry).updatedAt === 'string'
    )
    .map((entry) => ({
      key: entry.key,
      taskId: entry.taskId,
      commentId: entry.commentId,
      author: entry.author,
      ...(typeof entry.commentCreatedAt === 'string' && entry.commentCreatedAt
        ? { commentCreatedAt: entry.commentCreatedAt }
        : {}),
      ...(typeof entry.messageId === 'string' && entry.messageId
        ? { messageId: entry.messageId }
        : {}),
      state: entry.state,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(typeof entry.sentAt === 'string' && entry.sentAt ? { sentAt: entry.sentAt } : {}),
    }));
}
