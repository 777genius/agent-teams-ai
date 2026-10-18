import { useCallback, useEffect, useState } from 'react';

import {
  defaultTaskFiltersState,
  isDefaultTaskFiltersState,
  type TaskFiltersState,
} from '@renderer/components/sidebar/taskFiltersState';

import { browserTaskViewPreferencesRepository } from '../adapters/browserTaskViewRepository';
import { normalizeTaskViewState } from '../view-models/taskViewStateSchema';

import type { TaskViewPreferencesRepository } from '../adapters/taskViewRepository';
import type { TaskViewSortMode } from '@renderer/components/sidebar/taskViewPolicy';

const cloneFilters = (filters: TaskFiltersState): TaskFiltersState => ({
  ...filters,
  statusIds: new Set(filters.statusIds),
});

export { normalizeTaskViewState };

export function useTaskViewState(
  storageNamespace: string,
  defaultSortMode: TaskViewSortMode = 'manual',
  repository: TaskViewPreferencesRepository = browserTaskViewPreferencesRepository
) {
  const [viewState, setViewState] = useState(() =>
    repository.load(storageNamespace, defaultSortMode)
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => {
    repository.save(storageNamespace, viewState);
  }, [repository, storageNamespace, viewState]);

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

  const isDefault =
    isDefaultTaskFiltersState(viewState.filters) &&
    viewState.sortMode === defaultSortMode &&
    viewState.searchQuery.trim() === '';

  return {
    filters: viewState.filters,
    sortMode: viewState.sortMode,
    searchQuery: viewState.searchQuery,
    isDefault,
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
