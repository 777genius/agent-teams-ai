import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import { isTerminalProvisioningState } from '../../core/domain';
import {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
} from '../utils/teamLaunchParams';

import { createTeamProvisioningLaunchPersistence } from './createTeamProvisioningLaunchPersistence';
import { createTeamProvisioningLaunchTransport } from './createTeamProvisioningLaunchTransport';

import type {
  TeamProvisioningLaunchAnalyticsPort,
  TeamProvisioningLaunchClockPort,
  TeamProvisioningLaunchControlPort,
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchPersistencePort,
  TeamProvisioningLaunchScopePort,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchStatePort,
  TeamProvisioningLaunchStoreState,
  TeamProvisioningLaunchTransportPort,
} from '../ports/TeamProvisioningLaunchPorts';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamSummary,
  ToolApprovalSettings,
} from '@shared/types';

const defaultClock: TeamProvisioningLaunchClockPort = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface StartProvisioningParams<
  TRequest extends TeamCreateRequest | TeamLaunchRequest,
  TContext,
> {
  analyticsContext: TContext;
  errorFallback: string;
  inheritPreviousLaunchParams: boolean;
  invoke(request: TRequest): Promise<{ runId: string }>;
  onAccepted(request: TRequest, runId: string, context: TContext): void;
  request: TRequest;
  snapshot?: TeamSummary;
}

export interface TeamProvisioningLaunchSliceDependencies<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
> {
  analytics: TeamProvisioningLaunchAnalyticsPort<TContext>;
  clock?: TeamProvisioningLaunchClockPort;
  control: TeamProvisioningLaunchControlPort;
  persistence?: TeamProvisioningLaunchPersistencePort;
  scope: TeamProvisioningLaunchScopePort<TMessageEntry>;
  state: TeamProvisioningLaunchStatePort<TMessageEntry>;
  transport?: TeamProvisioningLaunchTransportPort;
}

function buildProvisioningReset<TMessageEntry extends TeamProvisioningLaunchMessageEntry>(
  state: TeamProvisioningLaunchStoreState<TMessageEntry>,
  teamName: string,
  visibleLoadingResets: Partial<TeamProvisioningLaunchStoreState<TMessageEntry>>
): Partial<TeamProvisioningLaunchStoreState<TMessageEntry>> {
  const provisioningRuns = { ...state.provisioningRuns };
  for (const [runId, run] of Object.entries(provisioningRuns)) {
    if (run.teamName === teamName) delete provisioningRuns[runId];
  }

  const provisioningErrorByTeam = { ...state.provisioningErrorByTeam };
  const memberSpawnStatusesByTeam = { ...state.memberSpawnStatusesByTeam };
  const memberSpawnSnapshotsByTeam = { ...state.memberSpawnSnapshotsByTeam };
  const teamAgentRuntimeByTeam = { ...state.teamAgentRuntimeByTeam };
  const activeToolsByTeam = { ...state.activeToolsByTeam };
  const finishedVisibleByTeam = { ...state.finishedVisibleByTeam };
  const toolHistoryByTeam = { ...state.toolHistoryByTeam };
  delete provisioningErrorByTeam[teamName];
  delete memberSpawnStatusesByTeam[teamName];
  delete memberSpawnSnapshotsByTeam[teamName];
  delete teamAgentRuntimeByTeam[teamName];
  delete activeToolsByTeam[teamName];
  delete finishedVisibleByTeam[teamName];
  delete toolHistoryByTeam[teamName];

  const currentRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
  const previousRuntimeRunId = currentRuntimeRunIdByTeam[teamName];
  delete currentRuntimeRunIdByTeam[teamName];
  const ignoredRuntimeRunIds = previousRuntimeRunId
    ? {
        ...state.ignoredRuntimeRunIds,
        [previousRuntimeRunId]: teamName,
      }
    : state.ignoredRuntimeRunIds;

  return {
    provisioningRuns,
    provisioningErrorByTeam,
    memberSpawnStatusesByTeam,
    memberSpawnSnapshotsByTeam,
    teamAgentRuntimeByTeam,
    activeToolsByTeam,
    finishedVisibleByTeam,
    toolHistoryByTeam,
    currentRuntimeRunIdByTeam,
    ignoredProvisioningRunIds: state.ignoredProvisioningRunIds,
    ignoredRuntimeRunIds,
    ...visibleLoadingResets,
  };
}

function pendingSummary(request: TeamCreateRequest): TeamSummary {
  return {
    teamName: request.teamName,
    displayName: request.displayName || request.teamName,
    description: request.description || '',
    color: request.color,
    memberCount: request.members.length,
    members: request.members.map((member) => ({
      name: member.name,
      role: member.role,
      mcpPolicy: member.mcpPolicy,
    })),
    taskCount: 0,
    lastActivity: null,
    projectPath: request.cwd || undefined,
  };
}

function initialToolApprovalSettings(
  request: TeamCreateRequest | TeamLaunchRequest
): ToolApprovalSettings {
  return request.skipPermissions === false
    ? DEFAULT_TOOL_APPROVAL_SETTINGS
    : { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isUnknownProvisioningRunError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Unknown runId');
}

export function createTeamProvisioningLaunchSlice<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
>(
  dependencies: TeamProvisioningLaunchSliceDependencies<TMessageEntry, TContext>
): TeamProvisioningLaunchSlice {
  const clock = dependencies.clock ?? defaultClock;
  const persistence = dependencies.persistence ?? createTeamProvisioningLaunchPersistence();
  const transport = dependencies.transport ?? createTeamProvisioningLaunchTransport();

  const pollProvisioningStatus = async (runId: string): Promise<void> => {
    let delayMs = 150;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const current = dependencies.state.getState().provisioningRuns[runId];
      if (current && isTerminalProvisioningState(current.state)) return;
      try {
        const progress = await dependencies.control.getStatus(runId);
        if (isTerminalProvisioningState(progress.state)) return;
      } catch (error) {
        if (isUnknownProvisioningRunError(error)) {
          dependencies.control.clearMissingRun(runId);
          return;
        }
      }
      await clock.sleep(delayMs);
      delayMs = Math.min(1_500, Math.round(delayMs * 1.5));
    }
  };

  const startProvisioning = async <TRequest extends TeamCreateRequest | TeamLaunchRequest>(
    params: StartProvisioningParams<TRequest, TContext>
  ): Promise<string> => {
    const { request } = params;
    dependencies.control.subscribe();
    dependencies.scope.reset(request.teamName);

    const floor = clock.nowIso();
    dependencies.state.setState((state) => ({
      provisioningStartedAtFloorByTeam: {
        ...state.provisioningStartedAtFloorByTeam,
        [request.teamName]: floor,
      },
    }));
    dependencies.state.setState((state) =>
      buildProvisioningReset(
        state,
        request.teamName,
        dependencies.scope.collectVisibleLoadingResets(state, request.teamName)
      )
    );

    const pendingRunId = `pending:${request.teamName}:${clock.nowMs()}`;
    dependencies.state.setState((state) => ({
      provisioningRuns: {
        ...state.provisioningRuns,
        [pendingRunId]: {
          runId: pendingRunId,
          teamName: request.teamName,
          state: 'spawning',
          message: 'Starting agent runtime process...',
          startedAt: floor,
          updatedAt: floor,
        },
      },
      currentProvisioningRunIdByTeam: {
        ...state.currentProvisioningRunIdByTeam,
        [request.teamName]: pendingRunId,
      },
      ...(params.snapshot
        ? {
            provisioningSnapshotByTeam: {
              ...state.provisioningSnapshotByTeam,
              [request.teamName]: params.snapshot,
            },
          }
        : {}),
    }));

    const previousLaunchParams = dependencies.state.getState().launchParamsByTeam[request.teamName];
    const optimisticLaunchParams = buildLaunchParamsFromRuntimeRequest(
      request,
      params.inheritPreviousLaunchParams ? previousLaunchParams : undefined
    );
    dependencies.state.setState((state) => ({
      launchParamsByTeam: {
        ...state.launchParamsByTeam,
        [request.teamName]: optimisticLaunchParams,
      },
    }));

    const toolApprovalSettings = initialToolApprovalSettings(request);
    persistence.saveToolApprovalSettings(request.teamName, toolApprovalSettings);
    dependencies.state.setState({ toolApprovalSettings });

    let responseRunId: string | null = null;
    try {
      const response = await params.invoke(request);
      responseRunId = response.runId;
      params.onAccepted(request, response.runId, params.analyticsContext);

      persistence.saveLaunchParams(request.teamName, optimisticLaunchParams);
      dependencies.state.setState((state) => ({
        launchParamsByTeam: {
          ...state.launchParamsByTeam,
          [request.teamName]: optimisticLaunchParams,
        },
      }));
      dependencies.state.setState((state) => {
        const provisioningRuns = { ...state.provisioningRuns };
        const pendingRun = provisioningRuns[pendingRunId];
        const realProgressAlreadyExists = response.runId in provisioningRuns;
        if (pendingRun) {
          delete provisioningRuns[pendingRunId];
          if (!realProgressAlreadyExists) {
            provisioningRuns[response.runId] = {
              ...pendingRun,
              runId: response.runId,
            };
          }
        }
        return {
          provisioningRuns,
          currentProvisioningRunIdByTeam: {
            ...state.currentProvisioningRunIdByTeam,
            [request.teamName]: response.runId,
          },
          currentRuntimeRunIdByTeam: {
            ...state.currentRuntimeRunIdByTeam,
            [request.teamName]: response.runId,
          },
        };
      });

      try {
        await dependencies.control.getStatus(response.runId);
      } catch {
        // Polling below retries and handles missing runs.
      }
      void pollProvisioningStatus(response.runId);
      return response.runId;
    } catch (error) {
      const message = errorMessage(error, params.errorFallback);
      dependencies.state.setState((state) => {
        const provisioningRuns = { ...state.provisioningRuns };
        delete provisioningRuns[pendingRunId];
        const currentProvisioningRunIdByTeam = {
          ...state.currentProvisioningRunIdByTeam,
        };
        if (currentProvisioningRunIdByTeam[request.teamName] === pendingRunId) {
          delete currentProvisioningRunIdByTeam[request.teamName];
        }
        const launchParamsByTeam = { ...state.launchParamsByTeam };
        if (
          areTeamLaunchParamsEqual(launchParamsByTeam[request.teamName], optimisticLaunchParams)
        ) {
          if (previousLaunchParams) {
            launchParamsByTeam[request.teamName] = previousLaunchParams;
          } else {
            delete launchParamsByTeam[request.teamName];
          }
        }
        return {
          provisioningRuns,
          currentProvisioningRunIdByTeam,
          launchParamsByTeam,
          provisioningErrorByTeam: {
            ...state.provisioningErrorByTeam,
            [request.teamName]: message,
          },
        };
      });
      if (!responseRunId) {
        dependencies.analytics.recordIpcFailure(params.analyticsContext, error);
      }
      throw error;
    }
  };

  return {
    launchParamsByTeam: persistence.loadAllLaunchParams(),

    createTeam: (request) => {
      const analyticsContext = dependencies.analytics.createContext(request, clock.nowMs());
      return startProvisioning({
        analyticsContext,
        errorFallback: 'Failed to create team',
        inheritPreviousLaunchParams: false,
        invoke: (currentRequest) => transport.create(currentRequest),
        onAccepted: (currentRequest, runId, context) =>
          dependencies.analytics.recordCreateAccepted(currentRequest, runId, context),
        request,
        snapshot: pendingSummary(request),
      });
    },

    launchTeam: (request) => {
      const analyticsContext = dependencies.analytics.launchContext(
        request,
        dependencies.scope.getTeamData(request.teamName),
        clock.nowMs()
      );
      return startProvisioning({
        analyticsContext,
        errorFallback: 'Failed to launch team',
        inheritPreviousLaunchParams: true,
        invoke: (currentRequest) => transport.launch(currentRequest),
        onAccepted: (_request, runId, context) =>
          dependencies.analytics.recordLaunchAccepted(runId, context),
        request,
      });
    },
  };
}
