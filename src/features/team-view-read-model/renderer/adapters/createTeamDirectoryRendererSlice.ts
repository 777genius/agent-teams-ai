import {
  buildTeamSummaryIndexes,
  removeProvisioningSnapshotsForTeams,
} from '../utils/teamDirectoryProjectionPolicy';

import type {
  TeamDirectoryNotificationPort,
  TeamDirectoryPathPort,
  TeamDirectoryRefreshCoordinatorPort,
  TeamDirectoryRendererSlice,
  TeamDirectoryRendererState,
  TeamDirectoryRequestScopePort,
  TeamDirectorySchedulerPort,
  TeamDirectoryStatePort,
  TeamDirectoryStructuralSharingPort,
  TeamDirectoryTransportPort,
} from '../ports/TeamDirectoryRendererPorts';

const GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS = 1_500;

export interface TeamDirectoryRendererSliceDependencies<
  StoreState extends TeamDirectoryRendererState,
  RequestScope,
> {
  coordinator: TeamDirectoryRefreshCoordinatorPort<RequestScope>;
  notifications: TeamDirectoryNotificationPort;
  paths: TeamDirectoryPathPort;
  requestScope: TeamDirectoryRequestScopePort<RequestScope>;
  scheduler: TeamDirectorySchedulerPort;
  state: TeamDirectoryStatePort<StoreState>;
  structuralSharing: TeamDirectoryStructuralSharingPort;
  transport: TeamDirectoryTransportPort;
}

function getInitialLoadError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function createTeamDirectoryRendererSlice<
  StoreState extends TeamDirectoryRendererState,
  RequestScope,
>(
  dependencies: TeamDirectoryRendererSliceDependencies<StoreState, RequestScope>
): TeamDirectoryRendererSlice {
  return {
    branchByPath: {},
    globalTasks: [],
    globalTasksError: null,
    globalTasksInitialized: false,
    globalTasksLoading: false,
    teamByName: {},
    teamBySessionId: {},
    teams: [],
    teamsError: null,
    teamsLoading: false,

    fetchBranches: async (paths) => {
      const entries = await Promise.all(
        paths.map(async (path) => {
          try {
            const branch = await dependencies.transport.getProjectBranch(path);
            return [dependencies.paths.normalize(path), branch] as const;
          } catch {
            return [dependencies.paths.normalize(path), null] as const;
          }
        })
      );
      const results: Record<string, string | null> = Object.fromEntries(entries);
      if (Object.keys(results).length === 0) {
        return;
      }

      dependencies.state.setState((state) => {
        const changed = Object.entries(results).some(
          ([path, branch]) => state.branchByPath[path] !== branch
        );
        return changed ? { branchByPath: { ...state.branchByPath, ...results } } : {};
      });
    },

    fetchTeams: async () => {
      if (dependencies.state.getState().teamsLoading) {
        return;
      }

      const requestScope = dependencies.requestScope.capture();
      const requestId = dependencies.coordinator.beginTeamsFetch();
      const isInitialLoad = dependencies.state.getState().teams.length === 0;
      if (isInitialLoad) {
        dependencies.state.setState({ teamsLoading: true, teamsError: null });
      }

      try {
        const teams = await dependencies.transport.listTeams();
        if (
          !dependencies.requestScope.isCurrent(requestScope) ||
          !dependencies.coordinator.isLatestTeamsFetch(requestId)
        ) {
          return;
        }

        dependencies.state.setState((state) => {
          const nextTeams = dependencies.structuralSharing.share(state.teams, teams);
          const indexes = buildTeamSummaryIndexes(nextTeams);
          const nextTeamByName = dependencies.structuralSharing.share(
            state.teamByName,
            indexes.teamByName
          );
          const nextTeamBySessionId = dependencies.structuralSharing.share(
            state.teamBySessionId,
            indexes.teamBySessionId
          );
          const nextSnapshots = removeProvisioningSnapshotsForTeams(
            state.provisioningSnapshotByTeam,
            nextTeams
          );

          if (
            nextTeams === state.teams &&
            nextTeamByName === state.teamByName &&
            nextTeamBySessionId === state.teamBySessionId &&
            nextSnapshots === state.provisioningSnapshotByTeam &&
            state.teamsLoading === false &&
            state.teamsError === null
          ) {
            return {};
          }

          return {
            teams: nextTeams,
            teamByName: nextTeamByName,
            teamBySessionId: nextTeamBySessionId,
            teamsLoading: false,
            teamsError: null,
            provisioningSnapshotByTeam: nextSnapshots,
          };
        });
      } catch (error) {
        if (
          !dependencies.requestScope.isCurrent(requestScope) ||
          !dependencies.coordinator.isLatestTeamsFetch(requestId)
        ) {
          return;
        }

        dependencies.state.setState({
          teamsLoading: false,
          teamsError: isInitialLoad ? getInitialLoadError(error, 'Failed to fetch teams') : null,
        });
      }
    },

    fetchAllTasks: async () => {
      const inFlight = dependencies.coordinator.getGlobalTasksRefresh();
      if (inFlight) {
        if (
          dependencies.state.getState().globalTasksInitialized ||
          (inFlight.scope && !dependencies.requestScope.isCurrent(inFlight.scope))
        ) {
          dependencies.coordinator.queueFreshGlobalTasksRefresh();
        }
        await inFlight.request;
        return;
      }

      const runRefresh = async (): Promise<void> => {
        do {
          const isFollowUpRefresh = dependencies.coordinator.consumeFreshGlobalTasksRefresh();
          if (isFollowUpRefresh) {
            await dependencies.scheduler.delay(GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS);
          }

          const isInitialLoad = !dependencies.state.getState().globalTasksInitialized;
          if (isInitialLoad) {
            dependencies.state.setState({
              globalTasksLoading: true,
              globalTasksError: null,
            });
          }
          const requestScope = dependencies.requestScope.capture();
          dependencies.coordinator.setGlobalTasksRefreshScope(requestScope);
          const oldTasks = dependencies.state.getState().globalTasks;

          try {
            const tasks = await dependencies.transport.getAllTasks();
            if (!dependencies.requestScope.isCurrent(requestScope)) {
              continue;
            }
            const notificationState = dependencies.state.getState();
            dependencies.notifications.process({
              oldTasks,
              newTasks: tasks,
              appConfig: notificationState.appConfig,
              teamByName: notificationState.teamByName,
              isInitialFetch: dependencies.notifications.consumeInitialFetch(),
            });

            dependencies.state.setState((state) => ({
              globalTasks: dependencies.structuralSharing.share(state.globalTasks, tasks),
              globalTasksLoading: false,
              globalTasksInitialized: true,
              globalTasksError: null,
            }));
          } catch (error) {
            if (!dependencies.requestScope.isCurrent(requestScope)) {
              continue;
            }
            dependencies.state.setState({
              globalTasksLoading: false,
              globalTasksInitialized: true,
              globalTasksError: isInitialLoad
                ? getInitialLoadError(error, 'Failed to fetch tasks')
                : null,
            });
          }
        } while (dependencies.coordinator.hasPendingFreshGlobalTasksRefresh());
      };

      const request = runRefresh().finally(() => {
        dependencies.coordinator.clearGlobalTasksRefresh(request);
      });
      dependencies.coordinator.beginGlobalTasksRefresh(request);
      await request;
    },
  };
}
