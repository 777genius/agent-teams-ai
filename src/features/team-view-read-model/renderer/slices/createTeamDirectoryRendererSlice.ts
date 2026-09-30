import {
  buildTeamSummaryIndexes,
  removeProvisioningSnapshotsForTeams,
} from '../utils/teamDirectoryProjectionPolicy';

import type {
  TeamDirectoryRendererSlice,
  TeamDirectoryRendererSliceDependencies,
  TeamDirectoryRendererState,
} from '../ports/TeamDirectoryRendererPorts';

const GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS = 1_500;

export type { TeamDirectoryRendererSliceDependencies } from '../ports/TeamDirectoryRendererPorts';

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
    globalTasksReadOutcome: { snapshot: null, lastAttempt: 'none', hasSuccess: false },
    teamByName: {},
    teamBySessionId: {},
    teams: [],
    teamsError: null,
    teamsLoading: false,
    teamsReadOutcome: { snapshot: null, lastAttempt: 'none', hasSuccess: false },

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
      dependencies.state.setState((state) => ({
        teamsReadOutcome: {
          snapshot: state.teams,
          lastAttempt: 'loading',
          hasSuccess:
            state.teamsReadOutcome.snapshot === state.teams && state.teamsReadOutcome.hasSuccess,
        },
        ...(isInitialLoad ? { teamsLoading: true, teamsError: null } : {}),
      }));

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
            state.teamsError === null &&
            state.teamsReadOutcome.snapshot === nextTeams &&
            state.teamsReadOutcome.lastAttempt === 'success'
          ) {
            return {};
          }

          return {
            teams: nextTeams,
            teamByName: nextTeamByName,
            teamBySessionId: nextTeamBySessionId,
            teamsLoading: false,
            teamsError: null,
            teamsReadOutcome: { snapshot: nextTeams, lastAttempt: 'success', hasSuccess: true },
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

        dependencies.state.setState((state) => ({
          teamsLoading: false,
          teamsError: isInitialLoad ? getInitialLoadError(error, 'Failed to fetch teams') : null,
          teamsReadOutcome: {
            snapshot: state.teams,
            lastAttempt: 'failure',
            hasSuccess:
              state.teamsReadOutcome.snapshot === state.teams && state.teamsReadOutcome.hasSuccess,
          },
        }));
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
          dependencies.state.setState((state) => ({
            globalTasksReadOutcome: {
              snapshot: state.globalTasks,
              lastAttempt: 'loading',
              hasSuccess:
                state.globalTasksReadOutcome.snapshot === state.globalTasks &&
                state.globalTasksReadOutcome.hasSuccess,
            },
            ...(isInitialLoad ? { globalTasksLoading: true, globalTasksError: null } : {}),
          }));
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

            dependencies.state.setState((state) => {
              const nextTasks = dependencies.structuralSharing.share(state.globalTasks, tasks);
              return {
                globalTasks: nextTasks,
                globalTasksLoading: false,
                globalTasksInitialized: true,
                globalTasksError: null,
                globalTasksReadOutcome: {
                  snapshot: nextTasks,
                  lastAttempt: 'success',
                  hasSuccess: true,
                },
              };
            });
          } catch (error) {
            if (!dependencies.requestScope.isCurrent(requestScope)) {
              continue;
            }
            dependencies.state.setState((state) => ({
              globalTasksLoading: false,
              globalTasksInitialized: true,
              globalTasksError: isInitialLoad
                ? getInitialLoadError(error, 'Failed to fetch tasks')
                : null,
              globalTasksReadOutcome: {
                snapshot: state.globalTasks,
                lastAttempt: 'failure',
                hasSuccess:
                  state.globalTasksReadOutcome.snapshot === state.globalTasks &&
                  state.globalTasksReadOutcome.hasSuccess,
              },
            }));
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
