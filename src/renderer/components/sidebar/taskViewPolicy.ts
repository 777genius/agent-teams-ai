import { normalizePath } from '@renderer/utils/pathNormalize';

import { getTaskUnreadCount, type TaskFiltersState, taskMatchesStatus } from './taskFiltersState';

import type { useReadStateSnapshot } from './taskFiltersState';
import type { GlobalTask } from '@shared/types';

export const TASK_SORT_MODES = ['time', 'project', 'team', 'unread'] as const;
export type TaskSortMode = (typeof TASK_SORT_MODES)[number];
export const TASK_VIEW_SORT_MODES = ['manual', ...TASK_SORT_MODES] as const;
export type TaskViewSortMode = (typeof TASK_VIEW_SORT_MODES)[number];
export type TaskArchiveMode = 'active' | 'archived' | 'all';

export function isTaskSortMode(value: unknown): value is TaskSortMode {
  return TASK_SORT_MODES.some((mode) => mode === value);
}

export function isTaskViewSortMode(value: unknown): value is TaskViewSortMode {
  return TASK_VIEW_SORT_MODES.some((mode) => mode === value);
}

export interface TaskViewPolicy {
  contextId: string;
  filters: TaskFiltersState;
  searchQuery: string;
  archiveMode: TaskArchiveMode;
  sortMode: TaskSortMode;
}

export type TaskEffectiveSubjectAccessor = (task: GlobalTask) => string;

export const createTaskEffectiveSubjectAccessor =
  (getRenamedSubject: (task: GlobalTask) => string | undefined): TaskEffectiveSubjectAccessor =>
  (task) =>
    getRenamedSubject(task) ?? task.subject;

export interface TaskSortContext {
  contextId: string;
  readState?: ReturnType<typeof useReadStateSnapshot>;
  teamMaxTimestamps: ReadonlyMap<string, number>;
}

const taskTimestamp = (task: GlobalTask): number => {
  const value = task.updatedAt ?? task.createdAt;
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const createTaskSortContext = (
  tasks: readonly GlobalTask[],
  contextId: string,
  readState?: ReturnType<typeof useReadStateSnapshot>
): TaskSortContext => {
  const teamMaxTimestamps = new Map<string, number>();
  for (const task of tasks) {
    const timestamp = taskTimestamp(task);
    const current = teamMaxTimestamps.get(task.teamName) ?? 0;
    if (timestamp > current) teamMaxTimestamps.set(task.teamName, timestamp);
  }
  return { contextId, readState, teamMaxTimestamps };
};

export const compareTaskFreshness = (a: GlobalTask, b: GlobalTask): number => {
  const aTime = a.updatedAt ?? a.createdAt ?? '';
  const bTime = b.updatedAt ?? b.createdAt ?? '';
  return bTime.localeCompare(aTime);
};

export function compareGlobalTasks(
  a: GlobalTask,
  b: GlobalTask,
  mode: TaskSortMode,
  context: TaskSortContext
): number {
  switch (mode) {
    case 'unread': {
      const ua = context.readState
        ? getTaskUnreadCount(
            context.readState,
            { contextId: context.contextId, teamName: a.teamName, taskId: a.id },
            a.comments
          )
        : 0;
      const ub = context.readState
        ? getTaskUnreadCount(
            context.readState,
            { contextId: context.contextId, teamName: b.teamName, taskId: b.id },
            b.comments
          )
        : 0;
      return ub - ua || compareTaskFreshness(a, b);
    }
    case 'project': {
      const comparison = (a.projectPath ?? '').localeCompare(b.projectPath ?? '');
      return comparison || compareTaskFreshness(a, b);
    }
    case 'team': {
      const comparison = a.teamDisplayName.localeCompare(b.teamDisplayName);
      return comparison || compareTaskFreshness(a, b);
    }
    case 'time':
      if (a.teamName !== b.teamName) {
        return (
          (context.teamMaxTimestamps.get(b.teamName) ?? 0) -
          (context.teamMaxTimestamps.get(a.teamName) ?? 0)
        );
      }
      return taskTimestamp(b) - taskTimestamp(a);
    default:
      return 0;
  }
}

export function sortGlobalTasks(
  tasks: readonly GlobalTask[],
  mode: TaskSortMode,
  contextId: string,
  readState?: ReturnType<typeof useReadStateSnapshot>
): GlobalTask[] {
  const context = createTaskSortContext(tasks, contextId, readState);
  return [...tasks].sort((a, b) => compareGlobalTasks(a, b, mode, context));
}

export function applyTaskSearch(
  tasks: readonly GlobalTask[],
  query: string,
  getEffectiveSubject: TaskEffectiveSubjectAccessor = (task) => task.subject
): GlobalTask[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...tasks];
  return tasks.filter(
    (task) =>
      getEffectiveSubject(task).toLowerCase().includes(normalizedQuery) ||
      task.owner?.toLowerCase().includes(normalizedQuery) ||
      task.teamDisplayName.toLowerCase().includes(normalizedQuery)
  );
}

export function applyProjectTaskFilter(
  tasks: readonly GlobalTask[],
  projectPath: string | null
): GlobalTask[] {
  if (!projectPath) return [...tasks];
  const normalizedProjectPath = normalizePath(projectPath);
  return tasks.filter(
    (task) => task.projectPath && normalizePath(task.projectPath) === normalizedProjectPath
  );
}

export function filterGlobalTasks(
  tasks: readonly GlobalTask[],
  policy: Omit<TaskViewPolicy, 'sortMode'> & {
    getEffectiveSubject?: TaskEffectiveSubjectAccessor;
  },
  readState: ReturnType<typeof useReadStateSnapshot>,
  isArchived: (task: GlobalTask) => boolean = () => false
): GlobalTask[] {
  let visible = applyProjectTaskFilter(tasks, policy.filters.projectPath);
  visible = visible.filter((task) => taskMatchesStatus(task, policy.filters.statusIds));
  if (policy.filters.teamName) {
    visible = visible.filter((task) => task.teamName === policy.filters.teamName);
  }
  if (policy.filters.readFilter === 'unread') {
    visible = visible.filter(
      (task) =>
        getTaskUnreadCount(
          readState,
          { contextId: policy.contextId, teamName: task.teamName, taskId: task.id },
          task.comments
        ) > 0
    );
  } else if (policy.filters.readFilter === 'read') {
    visible = visible.filter(
      (task) =>
        getTaskUnreadCount(
          readState,
          { contextId: policy.contextId, teamName: task.teamName, taskId: task.id },
          task.comments
        ) === 0
    );
  }
  visible = applyTaskSearch(visible, policy.searchQuery, policy.getEffectiveSubject);
  return visible.filter((task) => {
    const archived = isArchived(task);
    return policy.archiveMode === 'all'
      ? true
      : policy.archiveMode === 'archived'
        ? archived
        : !archived;
  });
}
