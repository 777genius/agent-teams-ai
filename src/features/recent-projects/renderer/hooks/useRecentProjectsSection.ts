import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DashboardRecentProject } from '@features/recent-projects/contracts';
import { api, isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { buildTaskCountsByProject } from '@renderer/utils/pathNormalize';
import { useShallow } from 'zustand/react/shallow';

import { adaptRecentProjectsSection } from '../adapters/RecentProjectsSectionAdapter';
import { buildActiveTeamsByProject } from '../utils/activeProjectTeams';
import {
  sortRecentProjectsByDisplayPriority,
  subscribeRecentProjectOpenHistory,
} from '../utils/recentProjectOpenHistory';
import {
  getRecentProjectsClientSnapshot,
  loadRecentProjectsWithClientCache,
} from '../utils/recentProjectsClientCache';

import { useOpenRecentProject } from './useOpenRecentProject';

import type { RecentProjectCardModel } from '../adapters/RecentProjectsSectionAdapter';
import type { TeamSummary } from '@shared/types';

const INITIAL_RECENT_PROJECTS = 11;
const LOAD_MORE_STEP = 8;
const DEGRADED_RECENT_PROJECTS_FAST_RETRY_DELAY_MS = 1_500;
const DEGRADED_RECENT_PROJECTS_STEADY_RETRY_DELAY_MS = 5_000;
const DEGRADED_RECENT_PROJECTS_FAST_RETRY_LIMIT = 3;

function matchesSearch(project: DashboardRecentProject, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return (
    project.name.toLowerCase().includes(normalizedQuery) ||
    project.primaryPath.toLowerCase().includes(normalizedQuery) ||
    project.associatedPaths.some((projectPath) =>
      projectPath.toLowerCase().includes(normalizedQuery)
    ) ||
    project.primaryBranch?.toLowerCase().includes(normalizedQuery) === true
  );
}

export function useRecentProjectsSection(
  searchQuery: string,
  maxProjects = INITIAL_RECENT_PROJECTS
): {
  cards: RecentProjectCardModel[];
  loading: boolean;
  error: string | null;
  canLoadMore: boolean;
  isElectron: boolean;
  loadMore: () => void;
  reload: () => Promise<void>;
  openRecentProject: (project: DashboardRecentProject) => Promise<void>;
  openProjectPath: (projectPath: string) => Promise<void>;
  selectProjectFolder: () => Promise<void>;
} {
  const {
    globalTasks,
    globalTasksInitialized,
    globalTasksLoading,
    fetchAllTasks,
    teams,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
    provisioningSnapshotByTeam,
  } = useStore(
    useShallow((state) => ({
      globalTasks: state.globalTasks,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksLoading: state.globalTasksLoading,
      fetchAllTasks: state.fetchAllTasks,
      teams: state.teams,
      provisioningRuns: state.provisioningRuns,
      currentProvisioningRunIdByTeam: state.currentProvisioningRunIdByTeam,
      provisioningSnapshotByTeam: state.provisioningSnapshotByTeam,
    }))
  );
  const initialSnapshot = useMemo(() => getRecentProjectsClientSnapshot(), []);
  const { openRecentProject, openProjectPath, selectProjectFolder } = useOpenRecentProject();
  const [recentProjects, setRecentProjects] = useState<DashboardRecentProject[]>(
    initialSnapshot?.payload.projects ?? []
  );
  const [recentProjectsDegraded, setRecentProjectsDegraded] = useState(
    initialSnapshot?.payload.degraded ?? false
  );
  const [degradedRefreshCount, setDegradedRefreshCount] = useState(
    initialSnapshot?.payload.degraded ? 1 : 0
  );
  const [loading, setLoading] = useState(initialSnapshot == null);
  const [error, setError] = useState<string | null>(null);
  const [visibleProjects, setVisibleProjects] = useState(maxProjects);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [openHistoryVersion, setOpenHistoryVersion] = useState(0);
  const hasFetchedTasksRef = useRef(globalTasksInitialized);
  const recentProjectsRef = useRef<DashboardRecentProject[]>(
    initialSnapshot?.payload.projects ?? []
  );
  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );
  const provisioningTeamNames = useMemo(
    () =>
      Object.keys(currentProvisioningRunIdByTeam).filter((teamName) =>
        isTeamProvisioningActive(provisioningState, teamName)
      ),
    [currentProvisioningRunIdByTeam, provisioningState]
  );
  const provisioningTeamNamesKey = useMemo(
    () => [...provisioningTeamNames].sort().join('\u0000'),
    [provisioningTeamNames]
  );

  useEffect(() => {
    recentProjectsRef.current = recentProjects;
  }, [recentProjects]);

  const reload = useCallback(async (options?: { force?: boolean }): Promise<void> => {
    const hasVisibleProjects =
      recentProjectsRef.current.length > 0 || getRecentProjectsClientSnapshot() != null;

    if (!hasVisibleProjects) {
      setLoading(true);
    }
    setError(null);
    try {
      const payload = await loadRecentProjectsWithClientCache(
        () => api.getDashboardRecentProjects(),
        options
      );
      setRecentProjects(payload.projects);
      setRecentProjectsDegraded(payload.degraded);
      setDegradedRefreshCount((current) => (payload.degraded ? current + 1 : 0));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to load recent projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const snapshot = getRecentProjectsClientSnapshot();
    if (snapshot && !snapshot.isStale) {
      return;
    }

    void reload({ force: snapshot != null });
  }, [reload]);

  useEffect(() => {
    if (!recentProjectsDegraded) {
      return;
    }

    const delayMs =
      degradedRefreshCount <= DEGRADED_RECENT_PROJECTS_FAST_RETRY_LIMIT
        ? DEGRADED_RECENT_PROJECTS_FAST_RETRY_DELAY_MS
        : DEGRADED_RECENT_PROJECTS_STEADY_RETRY_DELAY_MS;

    const timer = window.setTimeout(() => {
      void reload({ force: true });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [degradedRefreshCount, recentProjectsDegraded, reload]);

  useEffect(() => {
    if (recentProjects.length === 0 || hasFetchedTasksRef.current || globalTasksInitialized) {
      hasFetchedTasksRef.current = hasFetchedTasksRef.current || globalTasksInitialized;
      return;
    }

    hasFetchedTasksRef.current = true;
    void fetchAllTasks();
  }, [fetchAllTasks, globalTasksInitialized, recentProjects.length]);

  useEffect(() => {
    let cancelled = false;

    void api.teams
      .aliveList()
      .then((teamNames) => {
        if (!cancelled) {
          setAliveTeams(teamNames);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [provisioningTeamNamesKey, teams]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setVisibleProjects(maxProjects);
    }
  }, [maxProjects, searchQuery]);

  useEffect(
    () => subscribeRecentProjectOpenHistory(() => setOpenHistoryVersion((current) => current + 1)),
    []
  );

  const taskCountsByProject = useMemo(() => buildTaskCountsByProject(globalTasks), [globalTasks]);

  const activeTeamsByProject = useMemo(() => {
    return buildActiveTeamsByProject({
      teams,
      aliveTeamNames: aliveTeams,
      provisioningTeamNames,
      provisioningSnapshotByTeam,
    });
  }, [aliveTeams, provisioningSnapshotByTeam, provisioningTeamNames, teams]);

  const decoratedCards = useMemo(
    () =>
      adaptRecentProjectsSection({
        projects: sortRecentProjectsByDisplayPriority(recentProjects),
        taskCountsByProject,
        activeTeamsByProject,
        tasksLoading: globalTasksLoading,
      }),
    [
      activeTeamsByProject,
      globalTasksLoading,
      openHistoryVersion,
      recentProjects,
      taskCountsByProject,
    ]
  );

  const filteredCards = useMemo(
    () => decoratedCards.filter((card) => matchesSearch(card.project, searchQuery)),
    [decoratedCards, searchQuery]
  );

  const cards = useMemo(() => {
    if (searchQuery.trim()) {
      return filteredCards;
    }

    return filteredCards.slice(0, visibleProjects);
  }, [filteredCards, searchQuery, visibleProjects]);

  return {
    cards,
    loading,
    error,
    canLoadMore: !searchQuery.trim() && filteredCards.length > visibleProjects,
    isElectron: isElectronMode(),
    loadMore: () => setVisibleProjects((current) => current + LOAD_MORE_STEP),
    reload,
    openRecentProject,
    openProjectPath,
    selectProjectFolder,
  };
}
