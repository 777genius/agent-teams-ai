import {
  defaultTaskFiltersState,
  isReadFilter,
  isTaskStatusFilterId,
  type ReadFilter,
  type TaskFiltersState,
  type TaskStatusFilterId,
} from '@renderer/components/sidebar/taskFiltersState';
import {
  isTaskViewSortMode,
  type TaskViewSortMode,
} from '@renderer/components/sidebar/taskViewPolicy';

export interface PersistedTaskViewState {
  filters: {
    statusIds: TaskStatusFilterId[];
    teamName: string | null;
    projectPath: string | null;
    readFilter: ReadFilter;
  };
  sortMode: TaskViewSortMode;
  searchQuery: string;
}

export interface TaskViewState {
  filters: TaskFiltersState;
  sortMode: TaskViewSortMode;
  searchQuery: string;
}

export function normalizeTaskViewState(
  value: unknown,
  defaultSortMode: TaskViewSortMode
): TaskViewState {
  const filters = defaultTaskFiltersState();
  let sortMode: TaskViewSortMode = isTaskViewSortMode(defaultSortMode) ? defaultSortMode : 'manual';
  let searchQuery = '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { filters, sortMode, searchQuery };
  }
  const candidate = value as Partial<PersistedTaskViewState>;
  const candidateFilters = candidate.filters as
    | Partial<PersistedTaskViewState['filters']>
    | undefined;
  if (
    candidateFilters &&
    typeof candidateFilters === 'object' &&
    !Array.isArray(candidateFilters)
  ) {
    if (Array.isArray(candidateFilters.statusIds)) {
      filters.statusIds = new Set(candidateFilters.statusIds.filter(isTaskStatusFilterId));
    }
    if (typeof candidateFilters.teamName === 'string' || candidateFilters.teamName === null) {
      filters.teamName = candidateFilters.teamName;
    }
    if (typeof candidateFilters.projectPath === 'string' || candidateFilters.projectPath === null) {
      filters.projectPath = candidateFilters.projectPath;
    }
    if (isReadFilter(candidateFilters.readFilter)) {
      filters.readFilter = candidateFilters.readFilter;
      filters.unreadOnly = candidateFilters.readFilter === 'unread';
    }
  }
  if (isTaskViewSortMode(candidate.sortMode)) sortMode = candidate.sortMode;
  if (typeof candidate.searchQuery === 'string') searchQuery = candidate.searchQuery;
  return { filters, sortMode, searchQuery };
}

export function serializeTaskViewState(state: TaskViewState): PersistedTaskViewState {
  return {
    filters: {
      statusIds: [...state.filters.statusIds],
      teamName: state.filters.teamName,
      projectPath: state.filters.projectPath,
      readFilter: state.filters.readFilter,
    },
    sortMode: state.sortMode,
    searchQuery: state.searchQuery,
  };
}
