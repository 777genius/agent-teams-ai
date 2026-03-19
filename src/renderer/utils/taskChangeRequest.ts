import {
  getTaskChangeStateBucket,
  isTaskChangeSummaryCacheable,
  type TaskChangeStateBucket,
} from '@shared/utils/taskChangeState';

import type { ReviewAPI } from '@shared/types/api';
import type { TeamTaskWithKanban } from '@shared/types/team';

const TASK_SINCE_GRACE_MS = 2 * 60 * 1000;

export type TaskChangeRequestOptions = NonNullable<Parameters<ReviewAPI['getTaskChanges']>[2]>;

export interface TaskChangeContext {
  taskId: string;
  requestOptions: TaskChangeRequestOptions;
  initialFilePath?: string;
}

type TaskChangeTaskLike = Pick<
  TeamTaskWithKanban,
  | 'id'
  | 'owner'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'workIntervals'
  | 'historyEvents'
  | 'reviewState'
  | 'kanbanColumn'
>;

export function deriveTaskSince(task: TaskChangeTaskLike | null): string | undefined {
  if (!task) return undefined;

  const sources: string[] = [];
  if (task.createdAt) sources.push(task.createdAt);
  if (Array.isArray(task.workIntervals)) {
    for (const interval of task.workIntervals) {
      if (interval.startedAt) sources.push(interval.startedAt);
    }
  }
  if (Array.isArray(task.historyEvents)) {
    for (const event of task.historyEvents) {
      if (event.timestamp) sources.push(event.timestamp);
    }
  }
  if (sources.length === 0) return undefined;

  const [first, ...rest] = sources;
  const earliest = rest.reduce((a, b) => (a < b ? a : b), first);
  const date = new Date(earliest);
  date.setTime(date.getTime() - TASK_SINCE_GRACE_MS);
  return date.toISOString();
}

export function buildTaskChangeRequestOptions(
  task: TaskChangeTaskLike,
  overrides?: Partial<TaskChangeRequestOptions>
): TaskChangeRequestOptions {
  const options: TaskChangeRequestOptions = {
    owner: task.owner,
    status: task.status,
    intervals: task.workIntervals,
    since: deriveTaskSince(task),
    stateBucket: getTaskChangeStateBucket(task),
  };

  return {
    ...options,
    ...overrides,
  };
}

export function buildTaskChangeContext(
  task: TaskChangeTaskLike,
  input?: { initialFilePath?: string; summaryOnly?: boolean }
): TaskChangeContext {
  return {
    taskId: task.id,
    requestOptions: buildTaskChangeRequestOptions(task, {
      summaryOnly: input?.summaryOnly,
    }),
    initialFilePath: input?.initialFilePath,
  };
}

export function buildTaskChangeSignature(options: TaskChangeRequestOptions): string {
  const owner = typeof options.owner === 'string' ? options.owner.trim() : '';
  const status = typeof options.status === 'string' ? options.status.trim() : '';
  const since = typeof options.since === 'string' ? options.since : '';
  const stateBucket = typeof options.stateBucket === 'string' ? options.stateBucket : 'active';
  const intervals = Array.isArray(options.intervals)
    ? options.intervals.map((interval) => ({
        startedAt: interval.startedAt,
        completedAt: interval.completedAt ?? '',
      }))
    : [];

  return JSON.stringify({
    owner,
    status,
    since,
    stateBucket,
    intervals,
  });
}

export function buildTaskChangePresenceKey(
  teamName: string,
  taskId: string,
  options: TaskChangeRequestOptions
): string {
  return `${teamName}:${taskId}:${buildTaskChangeSignature(options)}`;
}

export function getTaskChangeStateBucketFromOptions(
  options: TaskChangeRequestOptions | null | undefined
): TaskChangeStateBucket {
  switch (options?.stateBucket) {
    case 'approved':
    case 'review':
    case 'completed':
      return options.stateBucket;
    default:
      return 'active';
  }
}

export function isTaskSummaryCacheableForOptions(
  options: TaskChangeRequestOptions | null | undefined
): boolean {
  return isTaskChangeSummaryCacheable(getTaskChangeStateBucketFromOptions(options));
}

export function canDisplayTaskChangesForOptions(
  options: TaskChangeRequestOptions | null | undefined
): boolean {
  const bucket = getTaskChangeStateBucketFromOptions(options);
  if (bucket !== 'active') return true;
  // 'active' bucket includes both pending and in_progress — show for in_progress only
  return options?.status === 'in_progress';
}
