import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';

import { isTerminalProvisioningState } from '../../core/domain';
import {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
} from '../utils/teamLaunchParams';

import type {
  TeamProvisioningLaunchClockPort,
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchSliceDependencies,
  TeamProvisioningLaunchStoreState,
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

let provisioningAttemptSequence = 0;

function createProvisioningAttemptId(): string {
  provisioningAttemptSequence += 1;
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attempt-${provisioningAttemptSequence.toString(36)}`
  );
}

function omitTeamKey<TRecord extends Record<string, unknown>>(
  record: TRecord,
  teamName: string
): TRecord | null {
  if (!(teamName in record)) return null;
  const next = { ...record };
  delete next[teamName];
  return next;
}

function collectFailedProvisioningAttemptCleanup<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
>(
  state: TeamProvisioningLaunchStoreState<TMessageEntry>,
  teamName: string,
  pendingRunId: string,
  startedAtFloor: string,
  nowMs: number
): Partial<TeamProvisioningLaunchStoreState<TMessageEntry>> {
  const currentProvisioningRunId = state.currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunId = state.currentRuntimeRunIdByTeam[teamName];
  const failedRunIds = new Set([pendingRunId]);
  for (const runId of [currentProvisioningRunId, currentRuntimeRunId]) {
    if (typeof runId === 'string') failedRunIds.add(runId);
  }

  const provisioningRuns = { ...state.provisioningRuns };
  const ignoredProvisioningRunIds = { ...state.ignoredProvisioningRunIds };
  for (const runId of failedRunIds) {
    delete provisioningRuns[runId];
    ignoredProvisioningRunIds[runId] = teamName;
  }

  const clearsProvisioning =
    typeof currentProvisioningRunId === 'string' && failedRunIds.has(currentProvisioningRunId);
  const clearsRuntime =
    typeof currentRuntimeRunId === 'string' && failedRunIds.has(currentRuntimeRunId);
  const ignoredRuntimeRunIds = { ...state.ignoredRuntimeRunIds };
  if (clearsRuntime && currentRuntimeRunId) {
    ignoredRuntimeRunIds[currentRuntimeRunId] = teamName;
  }

  const memberSpawnStatusesByTeam = omitTeamKey(state.memberSpawnStatusesByTeam, teamName);
  const memberSpawnSnapshotsByTeam = omitTeamKey(state.memberSpawnSnapshotsByTeam, teamName);
  const teamAgentRuntimeByTeam = omitTeamKey(state.teamAgentRuntimeByTeam, teamName);
  const activeToolsByTeam = omitTeamKey(state.activeToolsByTeam, teamName);
  const finishedVisibleByTeam = omitTeamKey(state.finishedVisibleByTeam, teamName);
  const toolHistoryByTeam = omitTeamKey(state.toolHistoryByTeam, teamName);
  const provisioningSnapshotByTeam = omitTeamKey(state.provisioningSnapshotByTeam, teamName);
  const clearsCurrentAttempt = clearsProvisioning || clearsRuntime;
  const closedStartedAtFloor = new Date(
    Math.max(nowMs, Date.parse(startedAtFloor)) + 1
  ).toISOString();

  return {
    provisioningRuns,
    ignoredProvisioningRunIds,
    provisioningStartedAtFloorByTeam: {
      ...state.provisioningStartedAtFloorByTeam,
      [teamName]: closedStartedAtFloor,
    },
    ...(clearsProvisioning
      ? {
          currentProvisioningRunIdByTeam: omitTeamKey(
            state.currentProvisioningRunIdByTeam,
            teamName
          )!,
        }
      : {}),
    ...(clearsRuntime
      ? {
          currentRuntimeRunIdByTeam: omitTeamKey(state.currentRuntimeRunIdByTeam, teamName)!,
          ignoredRuntimeRunIds,
        }
      : {}),
    ...(clearsCurrentAttempt && memberSpawnStatusesByTeam ? { memberSpawnStatusesByTeam } : {}),
    ...(clearsCurrentAttempt && memberSpawnSnapshotsByTeam ? { memberSpawnSnapshotsByTeam } : {}),
    ...(clearsCurrentAttempt && teamAgentRuntimeByTeam ? { teamAgentRuntimeByTeam } : {}),
    ...(clearsCurrentAttempt && activeToolsByTeam ? { activeToolsByTeam } : {}),
    ...(clearsCurrentAttempt && finishedVisibleByTeam ? { finishedVisibleByTeam } : {}),
    ...(clearsCurrentAttempt && toolHistoryByTeam ? { toolHistoryByTeam } : {}),
    ...(clearsCurrentAttempt && provisioningSnapshotByTeam ? { provisioningSnapshotByTeam } : {}),
  };
}

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

export type { TeamProvisioningLaunchSliceDependencies } from '../ports/TeamProvisioningLaunchPorts';

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

function isProvisioningStateOwnedByAttempt<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
>(
  state: TeamProvisioningLaunchStoreState<TMessageEntry>,
  teamName: string,
  pendingRunId: string,
  startedAtFloor: string
): boolean {
  const currentRunId = state.currentProvisioningRunIdByTeam[teamName];
  if (currentRunId === pendingRunId) return true;
  if (!currentRunId) return false;

  const currentProgress = state.provisioningRuns[currentRunId];
  return currentProgress?.teamName === teamName && currentProgress.startedAt >= startedAtFloor;
}

export function createTeamProvisioningLaunchSlice<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
>(
  dependencies: TeamProvisioningLaunchSliceDependencies<TMessageEntry, TContext>
): TeamProvisioningLaunchSlice {
  const clock = dependencies.clock ?? defaultClock;
  const persistence = dependencies.persistence;
  const transport = dependencies.transport;
  const currentAttemptIdByTeam = new Map<string, string>();

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
    const attemptId = createProvisioningAttemptId();
    currentAttemptIdByTeam.set(request.teamName, attemptId);

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

    const pendingRunId = `pending:${request.teamName}:${attemptId}`;
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

      if (
        areTeamLaunchParamsEqual(
          dependencies.state.getState().launchParamsByTeam[request.teamName],
          optimisticLaunchParams
        )
      ) {
        persistence.saveLaunchParams(request.teamName, optimisticLaunchParams);
      }
      dependencies.state.setState((state) => {
        const provisioningRuns = { ...state.provisioningRuns };
        const currentRunId = state.currentProvisioningRunIdByTeam[request.teamName];
        const ownsCurrentRun = currentRunId === pendingRunId || currentRunId === response.runId;
        if (!ownsCurrentRun) {
          delete provisioningRuns[pendingRunId];
          delete provisioningRuns[response.runId];
          return {
            provisioningRuns,
            ignoredProvisioningRunIds: {
              ...state.ignoredProvisioningRunIds,
              [response.runId]: request.teamName,
            },
          };
        }

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
      if (currentAttemptIdByTeam.get(request.teamName) === attemptId) {
        currentAttemptIdByTeam.delete(request.teamName);
      }
      return response.runId;
    } catch (error) {
      const message = errorMessage(error, params.errorFallback);
      dependencies.state.setState((state) => {
        const ownsCurrentAttemptIdentity =
          currentAttemptIdByTeam.get(request.teamName) === attemptId;
        const ownsCurrentAttemptState = isProvisioningStateOwnedByAttempt(
          state,
          request.teamName,
          pendingRunId,
          floor
        );
        if (!ownsCurrentAttemptIdentity || !ownsCurrentAttemptState) return {};

        const failedAttemptCleanup = collectFailedProvisioningAttemptCleanup(
          state,
          request.teamName,
          pendingRunId,
          floor,
          clock.nowMs()
        );
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
          ...failedAttemptCleanup,
          launchParamsByTeam,
          provisioningErrorByTeam: {
            ...state.provisioningErrorByTeam,
            [request.teamName]: message,
          },
        };
      });
      if (currentAttemptIdByTeam.get(request.teamName) === attemptId) {
        currentAttemptIdByTeam.delete(request.teamName);
      }
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
