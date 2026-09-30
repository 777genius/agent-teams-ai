/** Display ordering independent of Desktop path history or browser storage. */
export interface RecentProjectPriorityFacts {
  name: string;
  activityAt: number;
  openedAt: number;
}

const OPEN_PRIORITY_WINDOW_MS = 1000 * 60 * 60 * 48;

function boundedTime(value: number, now: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, now) : 0;
}

export function sortRecentProjectPriority<T>(
  rows: readonly T[],
  factsFor: (row: T) => RecentProjectPriorityFacts,
  now: number = Date.now()
): T[] {
  const ranked = rows.map((row) => ({ row, facts: factsFor(row) }));
  ranked.sort((left, right) => {
    const leftOpenedAt = boundedTime(left.facts.openedAt, now);
    const rightOpenedAt = boundedTime(right.facts.openedAt, now);
    const leftPriority = leftOpenedAt > 0 && now - leftOpenedAt <= OPEN_PRIORITY_WINDOW_MS;
    const rightPriority = rightOpenedAt > 0 && now - rightOpenedAt <= OPEN_PRIORITY_WINDOW_MS;
    if (leftPriority !== rightPriority) return leftPriority ? -1 : 1;
    if (leftPriority && rightPriority && leftOpenedAt !== rightOpenedAt) {
      return rightOpenedAt - leftOpenedAt;
    }
    const leftActivity = boundedTime(left.facts.activityAt, now);
    const rightActivity = boundedTime(right.facts.activityAt, now);
    if (leftActivity !== rightActivity) return rightActivity - leftActivity;
    if (leftOpenedAt !== rightOpenedAt) return rightOpenedAt - leftOpenedAt;
    return left.facts.name.localeCompare(right.facts.name);
  });
  return ranked.map(({ row }) => row);
}
