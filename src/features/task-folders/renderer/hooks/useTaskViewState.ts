import { useCallback, useEffect, useState } from 'react';

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

interface PersistedTaskViewState {
  filters: {
    statusIds: TaskStatusFilterId[];
    teamName: string | null;
    projectPath: string | null;
    readFilter: ReadFilter;
  };
  sortMode: TaskViewSortMode;
  searchQuery: string;
}

const cloneFilters = (filters: TaskFiltersState): TaskFiltersState => ({
  ...filters,
  statusIds: new Set(filters.statusIds),
});

export function normalizeTaskViewState(
  value: unknown,
  defaultSortMode: TaskViewSortMode
): { filters: TaskFiltersState; sortMode: TaskViewSortMode; searchQuery: string } {
  const filters = defaultTaskFiltersState();
  let sortMode: TaskViewSortMode = isTaskViewSortMode(defaultSortMode) ? defaultSortMode : 'manual';
  let searchQuery = '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { filters, sortMode, searchQuery };
  }
  const candidate = value as Partial<PersistedTaskViewState>;
  const candidateFilters = candidate.filters as Partial<PersistedTaskViewState['filters']> | undefined;
  if (candidateFilters && typeof candidateFilters === 'object' && !Array.isArray(candidateFilters)) {
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

function loadTaskViewState(storageKey: string, defaultSortMode: TaskViewSortMode) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) return normalizeTaskViewState(JSON.parse(raw), defaultSortMode);
  } catch {
    /* preserve fresh defaults on invalid or unavailable storage */
  }
  return normalizeTaskViewState(undefined, defaultSortMode);
}

export function useTaskViewState(
  storageNamespace: string,
  defaultSortMode: TaskViewSortMode = 'manual'
) {
  const storageKey = `taskFolders:taskView:v1:${storageNamespace}`;
  const [viewState, setViewState] = useState(() =>
    loadTaskViewState(storageKey, defaultSortMode)
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => {
    const persisted: PersistedTaskViewState = {
      filters: {
        statusIds: [...viewState.filters.statusIds],
        teamName: viewState.filters.teamName,
        projectPath: viewState.filters.projectPath,
        readFilter: viewState.filters.readFilter,
      },
      sortMode: viewState.sortMode,
      searchQuery: viewState.searchQuery,
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(persisted));
    } catch {
      /* preference persistence is best-effort */
    }
  }, [storageKey, viewState]);

  const setFilters = useCallback((filters: TaskFiltersState) => {
    setViewState((current) => ({ ...current, filters: cloneFilters(filters) }));
  }, []);
  const setSortMode = useCallback((sortMode: TaskViewSortMode) => {
    setViewState((current) => ({ ...current, sortMode }));
  }, []);
  const setSearchQuery = useCallback((searchQuery: string) => {
    setViewState((current) => ({ ...current, searchQuery }));
  }, []);
  const reset = useCallback(() => {
    setViewState({
      filters: defaultTaskFiltersState(),
      sortMode: defaultSortMode,
      searchQuery: '',
    });
  }, [defaultSortMode]);
  const closePopovers = useCallback(() => {
    setFiltersOpen(false);
    setSortOpen(false);
  }, []);

  useEffect(() => () => closePopovers(), [closePopovers]);

  return {
    filters: viewState.filters,
    sortMode: viewState.sortMode,
    searchQuery: viewState.searchQuery,
    filtersOpen,
    sortOpen,
    setFilters,
    setSortMode,
    setSearchQuery,
    setFiltersOpen,
    setSortOpen,
    reset,
    closePopovers,
  };
}
