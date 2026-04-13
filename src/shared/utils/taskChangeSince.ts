const TASK_SINCE_GRACE_MS = 2 * 60 * 1000;

interface TaskChangeIntervalLike {
  startedAt?: string | null;
}

interface TaskChangeHistoryEventLike {
  timestamp?: string | null;
}

export interface TaskChangeSinceLike<
  TInterval extends TaskChangeIntervalLike = TaskChangeIntervalLike,
  THistoryEvent extends TaskChangeHistoryEventLike = TaskChangeHistoryEventLike,
> {
  createdAt?: string | null;
  workIntervals?: TInterval[] | null;
  historyEvents?: THistoryEvent[] | null;
}

export function deriveTaskSince<
  TInterval extends TaskChangeIntervalLike,
  THistoryEvent extends TaskChangeHistoryEventLike,
>(task: TaskChangeSinceLike<TInterval, THistoryEvent> | null | undefined): string | undefined {
  if (!task) return undefined;

  const sources: string[] = [];
  if (typeof task.createdAt === 'string' && task.createdAt.length > 0) {
    sources.push(task.createdAt);
  }
  if (Array.isArray(task.workIntervals)) {
    for (const interval of task.workIntervals) {
      if (typeof interval?.startedAt === 'string' && interval.startedAt.length > 0) {
        sources.push(interval.startedAt);
      }
    }
  }
  if (Array.isArray(task.historyEvents)) {
    for (const event of task.historyEvents) {
      if (typeof event?.timestamp === 'string' && event.timestamp.length > 0) {
        sources.push(event.timestamp);
      }
    }
  }
  if (sources.length === 0) return undefined;

  const [first, ...rest] = sources;
  const earliest = rest.reduce((a, b) => (a < b ? a : b), first);
  const date = new Date(earliest);
  date.setTime(date.getTime() - TASK_SINCE_GRACE_MS);
  return date.toISOString();
}
