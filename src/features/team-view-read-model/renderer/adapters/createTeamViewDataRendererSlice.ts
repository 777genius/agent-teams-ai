import {
  defaultTeamViewDataCoordinator,
  type TeamViewDataCoordinator,
} from '../utils/teamViewDataCoordinator';

import { createTeamViewDataTransport } from './createTeamViewDataTransport';

import type {
  RefreshTeamDataOptions,
  SelectTeamOptions,
  TeamViewDataActionsPort,
  TeamViewDataDiagnosticsPort,
  TeamViewDataGlobalTaskProjectionPort,
  TeamViewDataLifecyclePort,
  TeamViewDataRendererSlice,
  TeamViewDataRequestScopePort,
  TeamViewDataSelectionEffectsPort,
  TeamViewDataSnapshotPolicyPort,
  TeamViewDataStatePort,
  TeamViewDataTaskPolicyPort,
  TeamViewDataTransportPort,
} from '../ports/TeamViewDataRendererPorts';
import type { TeamSummary, TeamViewSnapshot } from '@shared/types';

const POST_PAINT_TEAM_ENRICHMENT_FALLBACK_MS = 500;

export interface TeamViewDataRendererSliceDependencies<TScope, TNotification> {
  actions: TeamViewDataActionsPort;
  coordinator?: TeamViewDataCoordinator;
  diagnostics: TeamViewDataDiagnosticsPort;
  globalTasks: TeamViewDataGlobalTaskProjectionPort<TNotification>;
  lifecycle: TeamViewDataLifecyclePort;
  requestScope: TeamViewDataRequestScopePort<TScope>;
  selectionEffects: TeamViewDataSelectionEffectsPort;
  snapshots: TeamViewDataSnapshotPolicyPort;
  state: TeamViewDataStatePort;
  tasks: TeamViewDataTaskPolicyPort;
  transport?: TeamViewDataTransportPort;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function patchTeamSummary(
  teamName: string,
  data: TeamViewSnapshot,
  statePort: TeamViewDataStatePort
): void {
  const previousByName = statePort.getState().teamByName;
  const existing = previousByName[teamName];
  const color = data.config.color;
  if (!color || existing?.color === color) return;

  const patched: TeamSummary = existing
    ? { ...existing, color, displayName: data.config.name || teamName }
    : {
        teamName,
        displayName: data.config.name || teamName,
        description: data.config.description ?? '',
        color,
        memberCount: data.members.length,
        taskCount: 0,
        lastActivity: null,
      };
  statePort.setState({
    teamByName: {
      ...previousByName,
      [teamName]: patched,
    },
  });
}

export function createTeamViewDataRendererSlice<TScope, TNotification>(
  dependencies: TeamViewDataRendererSliceDependencies<TScope, TNotification>
): TeamViewDataRendererSlice {
  const coordinator = dependencies.coordinator ?? defaultTeamViewDataCoordinator;
  const transport = dependencies.transport ?? createTeamViewDataTransport();

  const isSelectedLoadCurrent = (
    teamName: string,
    requestNonce: number,
    requestScope: TScope
  ): boolean => {
    const state = dependencies.state.getState();
    return (
      dependencies.requestScope.isCurrent(teamName, requestScope) &&
      state.selectedTeamName === teamName &&
      state.selectedTeamLoadNonce === requestNonce &&
      state.selectedTeamData?.teamName === teamName
    );
  };

  const drainQueuedFullRefresh = (teamName: string): void => {
    if (!coordinator.consumeQueuedFullRefreshAfterThin(teamName)) return;
    void dependencies.actions.getActions().refreshTeamData(teamName, { withDedup: true });
  };

  const schedulePostPaintEnrichments = (
    teamName: string,
    requestNonce: number,
    requestScope: TScope
  ): void => {
    coordinator.schedulePostPaint(
      teamName,
      () => {
        void (async () => {
          if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
            coordinator.clearQueuedFullRefreshAfterThin(teamName);
            return;
          }

          const state = dependencies.state.getState();
          if (state.selectedTeamName !== teamName) {
            drainQueuedFullRefresh(teamName);
            return;
          }
          if (state.selectedTeamLoadNonce !== requestNonce) return;
          if (state.selectedTeamData?.teamName !== teamName) {
            coordinator.clearQueuedFullRefreshAfterThin(teamName);
            return;
          }

          if (coordinator.consumeQueuedFullRefreshAfterThin(teamName)) {
            void dependencies.actions.getActions().refreshTeamData(teamName, { withDedup: true });
          }

          try {
            const result = await dependencies.actions
              .getActions()
              .refreshTeamMessagesHead(teamName);
            if (!isSelectedLoadCurrent(teamName, requestNonce, requestScope)) return;
            if (result.feedChanged || dependencies.lifecycle.isMemberActivityMetaStale(teamName)) {
              await dependencies.actions.getActions().refreshMemberActivityMeta(teamName);
            }
          } catch (error) {
            dependencies.diagnostics.debug(
              `post-paint team enrichments skipped team=${teamName} error=${errorMessage(
                error,
                String(error)
              )}`
            );
          }
        })();
      },
      POST_PAINT_TEAM_ENRICHMENT_FALLBACK_MS
    );
  };

  const selectTeam = async (teamName: string, options?: SelectTeamOptions): Promise<void> => {
    const requestScope = dependencies.requestScope.capture(teamName);
    const allowReloadWhileProvisioning = options?.allowReloadWhileProvisioning === true;
    const startingState = dependencies.state.getState();
    if (
      startingState.selectedTeamLoading &&
      startingState.selectedTeamName === teamName &&
      !allowReloadWhileProvisioning
    ) {
      return;
    }

    const requestNonce = startingState.selectedTeamLoadNonce + 1;
    const previousData = dependencies.snapshots.getForTeam(startingState, teamName);
    coordinator.cancelPostPaint(teamName);
    dependencies.state.setState({
      selectedTeamName: teamName,
      selectedTeamData: previousData,
      selectedTeamLoading: true,
      selectedTeamLoadNonce: requestNonce,
      selectedTeamError: null,
      reviewActionError: null,
      toolApprovalSettings: dependencies.selectionEffects.loadToolApprovalSettings(teamName),
    });

    try {
      const data = await coordinator.requestDataDeduped(
        teamName,
        { includeMemberBranches: false },
        (normalizedOptions) => transport.getData(teamName, normalizedOptions)
      );
      if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
        coordinator.clearQueuedFullRefreshAfterThin(teamName);
        return;
      }

      const stateAfterLoad = dependencies.state.getState();
      if (stateAfterLoad.selectedTeamName !== teamName) {
        drainQueuedFullRefresh(teamName);
        return;
      }
      if (stateAfterLoad.selectedTeamLoadNonce !== requestNonce) return;

      patchTeamSummary(teamName, data, dependencies.state);

      let committedTeamData = data;
      let projectedNotification: TNotification | null = null;
      dependencies.state.setState((state) => {
        if (
          state.selectedTeamName === teamName &&
          dependencies.snapshots.shouldPreserveSelectedSnapshot(
            state.selectedTeamData,
            previousData,
            data,
            state.teamByName[teamName]
          )
        ) {
          const preserved = state.selectedTeamData;
          committedTeamData = preserved ?? data;
          const nextCache =
            preserved && state.teamDataCacheByName[teamName] !== preserved
              ? {
                  ...state.teamDataCacheByName,
                  [teamName]: preserved,
                }
              : state.teamDataCacheByName;
          const nextGlobalTasks = preserved
            ? dependencies.globalTasks.project(state.globalTasks, teamName, preserved)
            : state.globalTasks;
          projectedNotification = dependencies.globalTasks.buildNotification(
            state,
            nextGlobalTasks
          );
          return {
            selectedTeamName: teamName,
            selectedTeamData: preserved,
            teamDataCacheByName: nextCache,
            selectedTeamLoading: false,
            selectedTeamError: null,
            ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
          };
        }

        const previousForProjection =
          dependencies.snapshots.getForTeam(state, teamName) ?? previousData;
        const projected = previousForProjection
          ? {
              ...data,
              tasks: dependencies.snapshots.preserveKnownTaskChangePresence(
                teamName,
                previousForProjection.tasks,
                data.tasks
              ),
            }
          : data;
        const nextTeamData = dependencies.snapshots.structurallyShare(
          previousForProjection,
          projected
        );
        committedTeamData = nextTeamData;
        const nextCache =
          state.teamDataCacheByName[teamName] === nextTeamData
            ? state.teamDataCacheByName
            : {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              };
        const nextGlobalTasks = dependencies.globalTasks.project(
          state.globalTasks,
          teamName,
          nextTeamData
        );
        projectedNotification = dependencies.globalTasks.buildNotification(state, nextGlobalTasks);
        return {
          selectedTeamName: teamName,
          selectedTeamData: nextTeamData,
          teamDataCacheByName: nextCache,
          selectedTeamLoading: false,
          selectedTeamError: null,
          ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
        };
      });
      if (projectedNotification) {
        dependencies.globalTasks.notify(projectedNotification);
      }
      dependencies.lifecycle.recordLastResolvedRefresh(teamName);

      try {
        const invalidation = previousData
          ? dependencies.tasks.collectInvalidation(
              teamName,
              previousData.tasks,
              committedTeamData.tasks
            )
          : { cacheKeys: [], taskIds: [] };
        if (invalidation.cacheKeys.length > 0) {
          dependencies.actions.getActions().invalidateTaskChangePresence(invalidation.cacheKeys);
        }
        if (invalidation.taskIds.length > 0) {
          void transport
            .invalidateTaskChangeSummaries(teamName, invalidation.taskIds)
            .catch(() => undefined);
        }

        const displayName = committedTeamData.config.name || teamName;
        dependencies.selectionEffects.syncTabLabels(teamName, displayName);
        const projectPath = committedTeamData.config.projectPath;
        if (
          !options?.skipProjectAutoSelect &&
          projectPath &&
          isSelectedLoadCurrent(teamName, requestNonce, requestScope)
        ) {
          dependencies.selectionEffects.autoSelectProject(projectPath);
        }
      } catch (error) {
        dependencies.diagnostics.debug(
          `selectTeam(${teamName}) post-structural sync work failed: ${errorMessage(
            error,
            String(error)
          )}`
        );
      }

      try {
        schedulePostPaintEnrichments(teamName, requestNonce, requestScope);
      } catch (error) {
        dependencies.diagnostics.debug(
          `selectTeam(${teamName}) failed to schedule post-paint enrichments: ${errorMessage(
            error,
            String(error)
          )}`
        );
      }
    } catch (error) {
      if (!dependencies.requestScope.isCurrent(teamName, requestScope)) {
        coordinator.clearQueuedFullRefreshAfterThin(teamName);
        return;
      }

      const currentState = dependencies.state.getState();
      if (currentState.selectedTeamName !== teamName) {
        coordinator.clearQueuedFullRefreshAfterThin(teamName);
        return;
      }
      if (currentState.selectedTeamLoadNonce !== requestNonce) return;
      coordinator.clearQueuedFullRefreshAfterThin(teamName);

      const isProvisioning = dependencies.lifecycle.isProvisioningActive(teamName);
      const existingSelectedTeamData =
        currentState.selectedTeamData?.teamName === teamName ? currentState.selectedTeamData : null;
      const message = errorMessage(error, String(error));
      if (
        message === 'TEAM_PROVISIONING' ||
        (message.includes('TEAM_PROVISIONING') && isProvisioning)
      ) {
        if (existingSelectedTeamData) {
          dependencies.state.setState({
            selectedTeamLoading: false,
            selectedTeamData: existingSelectedTeamData,
            selectedTeamError: null,
          });
          return;
        }
        dependencies.state.setState({
          selectedTeamLoading: true,
          selectedTeamData: null,
          selectedTeamError: null,
        });
        return;
      }
      if (message === 'TEAM_DRAFT' || message.includes('TEAM_DRAFT')) {
        dependencies.state.setState({
          selectedTeamLoading: false,
          selectedTeamData: null,
          selectedTeamError: 'TEAM_DRAFT',
        });
        return;
      }
      if (existingSelectedTeamData) {
        dependencies.state.setState({
          selectedTeamLoading: false,
          selectedTeamData: existingSelectedTeamData,
          selectedTeamError: null,
        });
        return;
      }
      dependencies.state.setState({
        selectedTeamLoading: false,
        selectedTeamData: null,
        selectedTeamError: errorMessage(error, 'Failed to fetch team data'),
      });
    }
  };

  const refreshTeamData = async (
    teamName: string,
    options?: RefreshTeamDataOptions
  ): Promise<void> => {
    const reusedDataRequest =
      options?.withDedup === true ? coordinator.getFullDataRequest(teamName) : undefined;
    const reusedInFlightRequest = reusedDataRequest !== undefined;
    const queuedBehindThinRequest =
      options?.withDedup === true &&
      !reusedInFlightRequest &&
      coordinator.hasThinDataRequest(teamName);
    if (queuedBehindThinRequest) {
      coordinator.queueFullRefreshAfterThin(teamName);
      dependencies.diagnostics.debug(
        `refreshTeamData(${teamName}) queued behind thin team:getData`
      );
      return;
    }

    const requestScope = dependencies.requestScope.capture(teamName);
    const refreshHandle = coordinator.beginRefresh(teamName);
    dependencies.diagnostics.noteRefreshBurst(teamName);
    if (reusedInFlightRequest) {
      coordinator.markFreshRefreshPending(teamName, reusedDataRequest);
    }

    try {
      const previousData = dependencies.snapshots.getForTeam(
        dependencies.state.getState(),
        teamName
      );
      const data = options?.withDedup
        ? await coordinator.requestDataDeduped(teamName, undefined, (normalizedOptions) =>
            transport.getData(teamName, normalizedOptions)
          )
        : await transport.getData(teamName);
      if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;

      const projected = previousData
        ? {
            ...data,
            tasks: dependencies.snapshots.preserveKnownTaskChangePresence(
              teamName,
              previousData.tasks,
              data.tasks
            ),
          }
        : data;
      const nextTeamData = dependencies.snapshots.structurallyShare(previousData, projected);
      let projectedNotification: TNotification | null = null;
      dependencies.state.setState((state) => {
        const nextCache =
          state.teamDataCacheByName[teamName] === nextTeamData
            ? state.teamDataCacheByName
            : {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              };
        const selectedState =
          state.selectedTeamName === teamName
            ? {
                selectedTeamData: nextTeamData,
                selectedTeamError: null,
              }
            : {};
        const nextGlobalTasks = dependencies.globalTasks.project(
          state.globalTasks,
          teamName,
          nextTeamData
        );
        projectedNotification = dependencies.globalTasks.buildNotification(state, nextGlobalTasks);
        if (
          nextCache === state.teamDataCacheByName &&
          nextGlobalTasks === state.globalTasks &&
          (state.selectedTeamName !== teamName ||
            (state.selectedTeamData === nextTeamData && state.selectedTeamError == null))
        ) {
          return {};
        }
        return {
          teamDataCacheByName: nextCache,
          ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
          ...selectedState,
        };
      });
      dependencies.lifecycle.recordTaskBoardTransitions(teamName, previousData, nextTeamData);
      if (projectedNotification) {
        dependencies.globalTasks.notify(projectedNotification);
      }
      dependencies.lifecycle.recordLastResolvedRefresh(teamName);

      const invalidation = previousData
        ? dependencies.tasks.collectInvalidation(teamName, previousData.tasks, data.tasks)
        : { cacheKeys: [], taskIds: [] };
      if (invalidation.cacheKeys.length > 0) {
        dependencies.actions.getActions().invalidateTaskChangePresence(invalidation.cacheKeys);
      }
      if (invalidation.taskIds.length > 0) {
        await transport.invalidateTaskChangeSummaries(teamName, invalidation.taskIds);
      }
    } catch (error) {
      if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;
      const message = errorMessage(error, 'Failed to refresh team data');
      if (message === 'TEAM_PROVISIONING' || message.includes('TEAM_PROVISIONING')) {
        dependencies.diagnostics.debug(
          `refreshTeamData(${teamName}) skipped: team is still provisioning`
        );
        if (dependencies.state.getState().selectedTeamName === teamName) {
          dependencies.state.setState({ selectedTeamError: null });
        }
        return;
      }

      if (dependencies.lifecycle.shouldInvalidateCachedData(teamName, message)) {
        dependencies.state.setState((state) => {
          const nextCache = state.teamDataCacheByName[teamName]
            ? { ...state.teamDataCacheByName }
            : null;
          if (nextCache) delete nextCache[teamName];
          if (state.selectedTeamName !== teamName && !nextCache) return {};
          return {
            ...(nextCache ? { teamDataCacheByName: nextCache } : {}),
            ...(state.selectedTeamName === teamName
              ? {
                  selectedTeamLoading: false,
                  selectedTeamData: null,
                  selectedTeamError:
                    message === 'TEAM_DRAFT' || message.includes('TEAM_DRAFT')
                      ? 'TEAM_DRAFT'
                      : message,
                }
              : {}),
          };
        });
        return;
      }
      if (dependencies.state.getState().selectedTeamName !== teamName) return;

      dependencies.diagnostics.warn(`refreshTeamData(${teamName}) failed: ${message}`);
      if (dependencies.state.getState().selectedTeamData) {
        dependencies.diagnostics.debug(
          `refreshTeamData(${teamName}) preserving existing data after transient error`
        );
        dependencies.state.setState({ selectedTeamError: null });
        return;
      }
      dependencies.state.setState({ selectedTeamError: message });
    } finally {
      coordinator.endRefresh(teamName, refreshHandle);
      if (
        reusedInFlightRequest &&
        coordinator.consumeFreshRefresh(teamName, reusedDataRequest) &&
        dependencies.requestScope.isCurrent(teamName, requestScope)
      ) {
        void dependencies.actions.getActions().refreshTeamData(teamName);
      }
    }
  };

  return {
    selectedTeamData: null,
    selectedTeamError: null,
    selectedTeamLoading: false,
    selectedTeamLoadNonce: 0,
    selectedTeamName: null,
    teamDataCacheByName: {},
    selectTeam,
    refreshTeamData,
  };
}
