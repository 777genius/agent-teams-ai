import { useEffect, useMemo } from 'react';

import { buildTaskProjectFilterOptions } from '@renderer/components/sidebar/taskFilterOptions';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

/** Both task views lazily initialize the same project catalog when their filters open. */
export function useTaskProjectFilterOptions(
  filtersOpen: boolean
): ReturnType<typeof buildTaskProjectFilterOptions> {
  const {
    viewMode,
    projects,
    projectsLoading,
    projectsInitialized,
    projectsError,
    repositoryGroups,
    repositoryGroupsLoading,
    repositoryGroupsInitialized,
    repositoryGroupsError,
    fetchProjects,
    fetchRepositoryGroups,
  } = useStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      projects: s.projects,
      projectsLoading: s.projectsLoading,
      projectsInitialized: s.projectsInitialized,
      projectsError: s.projectsError,
      repositoryGroups: s.repositoryGroups,
      repositoryGroupsLoading: s.repositoryGroupsLoading,
      repositoryGroupsInitialized: s.repositoryGroupsInitialized,
      repositoryGroupsError: s.repositoryGroupsError,
      fetchProjects: s.fetchProjects,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
    }))
  );
  useEffect(() => {
    if (!filtersOpen) return;
    // Another task view may have started loading earlier in the same commit.
    const current = useStore.getState();
    if (
      current.viewMode === 'grouped' &&
      !current.repositoryGroupsInitialized &&
      !current.repositoryGroupsLoading &&
      !current.repositoryGroupsError
    ) {
      void current.fetchRepositoryGroups();
    } else if (
      current.viewMode === 'flat' &&
      !current.projectsInitialized &&
      !current.projectsLoading &&
      !current.projectsError
    ) {
      void current.fetchProjects();
    }
  }, [
    filtersOpen,
    viewMode,
    projectsLoading,
    projectsInitialized,
    projectsError,
    repositoryGroupsLoading,
    repositoryGroupsInitialized,
    repositoryGroupsError,
    fetchProjects,
    fetchRepositoryGroups,
  ]);
  return useMemo(
    () => buildTaskProjectFilterOptions({ viewMode, repositoryGroups, projects }),
    [viewMode, repositoryGroups, projects]
  );
}
