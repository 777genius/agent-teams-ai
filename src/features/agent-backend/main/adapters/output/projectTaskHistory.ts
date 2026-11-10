import type { TaskHistoryEvent, TeamReviewState, TeamTaskStatus } from '@shared/types/team';
const text = (value: unknown, empty = false): string => {
  if (
    typeof value !== 'string' ||
    (!empty && !value) ||
    value.length > 64 * 1024 ||
    value.includes('\0')
  )
    throw new Error('Invalid task history');
  return value;
};
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error('Invalid task history');
  return value as T;
}
export function projectTaskHistory(value: unknown): TaskHistoryEvent[] {
  if (!Array.isArray(value) || value.length > 4096 || JSON.stringify(value).length > 512 * 1024)
    throw new Error('Oversized task history');
  const ids = new Set<string>();
  const status = (value: unknown) =>
    choice<TeamTaskStatus>(value, ['pending', 'in_progress', 'completed', 'deleted']);
  const review = (value: unknown) =>
    choice<TeamReviewState>(value, ['none', 'review', 'needsFix', 'approved']);
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid task history');
    const row = raw as Record<string, unknown>,
      timestamp = text(row.timestamp),
      id = text(row.id);
    if (!Number.isFinite(Date.parse(timestamp)) || ids.has(id))
      throw new Error('Invalid task history identity');
    ids.add(id);
    const base = { id, timestamp, ...(row.actor === undefined ? {} : { actor: text(row.actor) }) };
    const note = row.note === undefined ? {} : { note: text(row.note, true) };
    switch (row.type) {
      case 'task_created':
        return { ...base, type: 'task_created', status: status(row.status) };
      case 'status_changed':
        return { ...base, type: 'status_changed', from: status(row.from), to: status(row.to) };
      case 'owner_changed':
        return {
          ...base,
          type: 'owner_changed',
          ...(row.from === undefined ? {} : { from: text(row.from) }),
          ...(row.to === undefined ? {} : { to: text(row.to) }),
        };
      case 'review_requested':
        return {
          ...base,
          type: 'review_requested',
          from: review(row.from),
          to: choice(row.to, ['review']),
          ...note,
          ...(row.reviewer === undefined ? {} : { reviewer: text(row.reviewer) }),
        };
      case 'review_changes_requested':
        return {
          ...base,
          type: 'review_changes_requested',
          from: review(row.from),
          to: choice(row.to, ['needsFix']),
          ...note,
        };
      case 'review_approved':
        return {
          ...base,
          type: 'review_approved',
          from: review(row.from),
          to: choice(row.to, ['approved']),
          ...note,
        };
      case 'review_disapproved':
        return {
          ...base,
          type: 'review_disapproved',
          from: choice(row.from, ['approved']),
          to: choice(row.to, ['none']),
        };
      case 'review_started':
        return {
          ...base,
          type: 'review_started',
          from: review(row.from),
          to: choice(row.to, ['review']),
        };
      default:
        throw new Error('Unsupported task history');
    }
  });
}
