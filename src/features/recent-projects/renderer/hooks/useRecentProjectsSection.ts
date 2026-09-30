import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DashboardRecentProject } from '@features/recent-projects/contracts';
import { api, isElectronMode } from '@renderer/api';
import { createTeamAliveListReadPort } from '@renderer/composition/team/createTeamAliveListReadPort';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { buildTaskCountsByProject } from '@renderer/utils/pathNormalize';
import { useShallow } from 'zustand/react/shallow';

import { buildActiveTeamsByProject } from '../utils/activeProjectTeams';
import {
  sortRecentProjectsByDisplayPriority,
  subscribeRecentProjectOpenHistory,
} from '../utils/recentProjectOpenHistory';
import {
  getRecentProjectsClientSnapshot,
  loadRecentProjectsWithClientCache,
} from '../utils/recentProjectsClientCache';
import { buildRecentProjectsSectionViewModel } from '../view-models/recentProjectsSectionViewModel';

import { useOpenRecentProject } from './useOpenRecentProject';

import type { RecentProjectIdentity } from '../ui/recentProjectsModel';
import type { RecentProjectCardModel } from '../view-models/recentProjectsSectionViewModel';

const DEGRADED_RECENT_PROJECTS_FAST_RETRY_DELAY_MS = 30_000;
const DEGRADED_RECENT_PROJECTS_STEADY_RETRY_DELAY_MS = 120_000;
const DEGRADED_RECENT_PROJECTS_FAST_RETRY_LIMIT = 3;
const teamAliveListReadPort = createTeamAliveListReadPort();

export function useRecentProjectsSection(): {
  cards: RecentProjectCardModel[];
  loading: boolean;
  error: string | null;
  isElectron: boolean;
  tasksKnown: boolean;
  aliveTeamsKnown: boolean;
  degraded: boolean;
  stale: boolean;
  scopeKey: string;
  readEpoch: number;
  isCurrentIntent: (intent: RecentProjectIdentity) => boolean;
  reload: () => Promise<void>;
  openRecentProject: ReturnType<typeof useOpenRecentProject>['openRecentProject'];
  openProjectPath: ReturnType<typeof useOpenRecentProject>['openProjectPath'];
  selectProjectFolder: ReturnType<typeof useOpenRecentProject>['selectProjectFolder'];
} {
  const {
    globalTasks,
    globalTasksInitialized,
    globalTasksLoading,
    teams,
    activeContextId,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
    provisioningSnapshotByTeam,
  } = useStore(
    useShallow((state) => ({
      globalTasks: state.globalTasks,
      globalTasksInitialized: state.globalTasksInitialized,
      globalTasksLoading: state.globalTasksLoading,
      teams: state.teams,
      activeContextId: state.activeContextId,
      provisioningRuns: state.provisioningRuns,
      currentProvisioningRunIdByTeam: state.currentProvisioningRunIdByTeam,
      provisioningSnapshotByTeam: state.provisioningSnapshotByTeam,
    }))
  );
  const initialSnapshot = useMemo(
    () => getRecentProjectsClientSnapshot(activeContextId),
    [activeContextId]
  );
  const { openRecentProject, openProjectPath, selectProjectFolder } = useOpenRecentProject();
  const [recentProjects, setRecentProjects] = useState<DashboardRecentProject[]>(
    initialSnapshot?.payload.projects ?? []
  );
  const [recentProjectsDegraded, setRecentProjectsDegraded] = useState(
    initialSnapshot?.payload.degraded ?? false
  );
  const [recentProjectsStale, setRecentProjectsStale] = useState(initialSnapshot?.isStale ?? false);
  const [degradedRefreshCount, setDegradedRefreshCount] = useState(
    initialSnapshot?.payload.degraded ? 1 : 0
  );
  const [loading, setLoading] = useState(initialSnapshot == null);
  const [error, setError] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [aliveTeamsKnown, setAliveTeamsKnown] = useState(false);
  const [openHistoryVersion, setOpenHistoryVersion] = useState(0);
  const recentProjectsRef = useRef<DashboardRecentProject[]>(
    initialSnapshot?.payload.projects ?? []
  );
  const activeContextIdRef = useRef(activeContextId);
  activeContextIdRef.current = activeContextId;
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

  const reload = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      const requestContextId = activeContextId;
      const requestContextEpoch = captureContextScopedRequestEpoch();
      const hasVisibleProjects =
        recentProjectsRef.current.length > 0 ||
        getRecentProjectsClientSnapshot(requestContextId) != null;

      if (!hasVisibleProjects) {
        setLoading(true);
      }
      setError(null);
      try {
        const payload = await loadRecentProjectsWithClientCache(
          requestContextId,
          () => api.getDashboardRecentProjects(),
          options
        );
        if (
          activeContextIdRef.current !== requestContextId ||
          !isContextScopedRequestEpochCurrent(requestContextEpoch)
        ) {
          return;
        }
        setRecentProjects(payload.projects);
        setRecentProjectsDegraded(payload.degraded);
        setRecentProjectsStale(false);
        setDegradedRefreshCount((current) => (payload.degraded ? current + 1 : 0));
      } catch (nextError) {
        if (
          activeContextIdRef.current !== requestContextId ||
          !isContextScopedRequestEpochCurrent(requestContextEpoch)
        ) {
          return;
        }
        setError(nextError instanceof Error ? nextError.message : 'Failed to load recent projects');
        setRecentProjectsStale(true);
      } finally {
        if (
          activeContextIdRef.current === requestContextId &&
          isContextScopedRequestEpochCurrent(requestContextEpoch)
        ) {
          setLoading(false);
        }
      }
    },
    [activeContextId]
  );

  useEffect(() => {
    const snapshot = getRecentProjectsClientSnapshot(activeContextId);
    if (snapshot) {
      setRecentProjects(snapshot.payload.projects);
      setRecentProjectsDegraded(snapshot.payload.degraded);
      setRecentProjectsStale(snapshot.isStale);
      setDegradedRefreshCount(snapshot.payload.degraded ? 1 : 0);
      setLoading(false);
    } else {
      setRecentProjects([]);
      setRecentProjectsDegraded(false);
      setRecentProjectsStale(false);
      setDegradedRefreshCount(0);
      setLoading(true);
    }

    if (snapshot && !snapshot.isStale) {
      return;
    }

    void reload({ force: snapshot != null });
  }, [activeContextId, reload]);

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
    let cancelled = false;
    const requestContextId = activeContextId;
    const requestContextEpoch = captureContextScopedRequestEpoch();
    setAliveTeams([]);
    setAliveTeamsKnown(false);

    void teamAliveListReadPort
      .listAliveTeams()
      .then((teamNames) => {
        if (
          !cancelled &&
          activeContextIdRef.current === requestContextId &&
          isContextScopedRequestEpochCurrent(requestContextEpoch)
        ) {
          setAliveTeams(teamNames);
          setAliveTeamsKnown(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeContextId, provisioningTeamNamesKey, teams]);

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

  const decoratedCards = useMemo(() => {
    void openHistoryVersion;
    return buildRecentProjectsSectionViewModel({
      projects: sortRecentProjectsByDisplayPriority(recentProjects),
      taskCountsByProject,
      activeTeamsByProject,
      tasksLoading: globalTasksLoading,
    });
  }, [
    activeTeamsByProject,
    globalTasksLoading,
    openHistoryVersion,
    recentProjects,
    taskCountsByProject,
  ]);

  return {
    cards: decoratedCards,
    loading,
    error,
    isElectron: isElectronMode(),
    tasksKnown: globalTasksInitialized && !globalTasksLoading,
    aliveTeamsKnown,
    degraded: recentProjectsDegraded,
    stale: recentProjectsStale,
    scopeKey: activeContextId,
    readEpoch: captureContextScopedRequestEpoch(),
    isCurrentIntent: (intent) =>
      intent.scopeKey === useStore.getState().activeContextId &&
      intent.readEpoch === captureContextScopedRequestEpoch(),
    reload,
    openRecentProject,
    openProjectPath,
    selectProjectFolder,
  };
}
