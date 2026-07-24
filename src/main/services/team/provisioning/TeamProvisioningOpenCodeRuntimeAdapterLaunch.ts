import { shouldRetainOpenCodeRuntimeLaunch } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberSpec,
} from '../runtime';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export interface OpenCodeRuntimeAdapterRunEntry {
  runId: string;
  providerId: string;
  cwd?: string;
  members?: TeamRuntimeLaunchResult['members'];
}

export interface OpenCodeRuntimeAdapterLaunchInputParams {
  runId: string;
  teamName: string;
  cwd: string;
  prompt: string;
  request: Pick<TeamCreateRequest | TeamLaunchRequest, 'model' | 'effort' | 'skipPermissions'>;
  members: TeamCreateRequest['members'];
  previousLaunchState: TeamRuntimeLaunchInput['previousLaunchState'];
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
}

export interface OpenCodeRuntimeAdapterFinalProgressInput {
  launching: TeamProvisioningProgress;
  result: Pick<TeamRuntimeLaunchResult, 'teamLaunchState' | 'warnings' | 'diagnostics'>;
  updatedAt: string;
}

export interface OpenCodeRuntimeAdapterLaunchPreflightPorts {
  getStopAllTeamsGeneration(): number;
  getRuntimeAdapterRun(teamName: string): OpenCodeRuntimeAdapterRunEntry | undefined;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  getProvisioningRun(teamName: string): string | undefined;
  getRuntimeAdapterProgress(runId: string): TeamProvisioningProgress | undefined;
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  cancelRuntimeAdapterProvisioning(
    runId: string,
    progress: TeamProvisioningProgress
  ): Promise<void>;
  recordCancelledOpenCodeRuntimeAdapterLaunch(
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse;
}

export interface OpenCodeRuntimeAdapterLaunchPorts extends OpenCodeRuntimeAdapterLaunchPreflightPorts {
  randomUUID(): string;
  nowIso(): string;
  setProvisioningRun(teamName: string, runId: string): void;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  readLaunchState(teamName: string): Promise<TeamRuntimeLaunchInput['previousLaunchState']>;
  clearPersistedLaunchState(teamName: string): Promise<void>;
  getTeamsBasePath(): string;
  migrateLegacyOpenCodeRuntimeState(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<unknown>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'active';
  }): Promise<void>;
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
  setOpenCodeRuntimeActiveRunManifest(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    runId: string;
  }): Promise<void>;
  consumeCancelledRuntimeAdapterRunId(runId: string): boolean;
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{ result: TeamRuntimeLaunchResult }>;
  syncOpenCodeRuntimeToolApprovals(input: {
    teamName: string;
    runId: string;
    laneId: string;
    cwd: string;
    members: TeamRuntimeLaunchResult['members'];
    expectedMembers: TeamRuntimeMemberSpec[];
    teamColor?: string;
    teamDisplayName?: string;
  }): void;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<unknown>;
  deleteRuntimeAdapterRun(teamName: string): void;
  setRuntimeAdapterRun(
    teamName: string,
    runtimeRun: {
      runId: string;
      providerId: 'opencode';
      cwd: string;
      members: TeamRuntimeLaunchResult['members'];
    }
  ): void;
  deleteAliveRunId(teamName: string): void;
  setAliveRunId(teamName: string, runId: string): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  deleteProvisioningRunIfCurrent(teamName: string, runId: string): void;
  emitTeamProcessChange(input: {
    type: 'process';
    teamName: string;
    runId: string;
    detail: TeamProvisioningProgress['state'];
  }): void;
}

export interface RunOpenCodeTeamRuntimeAdapterLaunchInput {
  adapter: TeamLaunchRuntimeAdapter;
  request: TeamCreateRequest | TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  prompt: string;
  sourceWarning?: string;
  onProgress: (progress: TeamProvisioningProgress) => void;
}

export function buildOpenCodeRuntimeAdapterLaunchInput(
  params: OpenCodeRuntimeAdapterLaunchInputParams
): { launchCwd: string; launchInput: TeamRuntimeLaunchInput } {
  const launchCwd = params.getOpenCodeRuntimeLaunchCwd(params.cwd, params.members);
  return {
    launchCwd,
    launchInput: {
      runId: params.runId,
      laneId: 'primary',
      teamName: params.teamName,
      cwd: launchCwd,
      prompt: params.prompt,
      providerId: 'opencode',
      model: params.request.model,
      effort: params.request.effort,
      skipPermissions: params.request.skipPermissions !== false,
      expectedMembers: params.members.map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflow,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: 'opencode',
        model: member.model ?? params.request.model,
        effort: member.effort ?? params.request.effort,
        cwd: member.cwd?.trim() || launchCwd,
      })),
      previousLaunchState: params.previousLaunchState,
    },
  };
}

export function buildOpenCodeRuntimeAdapterFinalProgress(
  input: OpenCodeRuntimeAdapterFinalProgressInput
): TeamProvisioningProgress {
  const success = input.result.teamLaunchState === 'clean_success';
  const pending = input.result.teamLaunchState === 'partial_pending';
  return {
    ...input.launching,
    state: success || pending ? 'ready' : 'failed',
    message: success
      ? 'OpenCode team launch is ready'
      : pending
        ? 'OpenCode team launch is waiting for runtime evidence or permissions'
        : 'OpenCode team launch failed readiness gate',
    messageSeverity: pending
      ? 'warning'
      : input.result.teamLaunchState === 'partial_failure'
        ? 'error'
        : undefined,
    updatedAt: input.updatedAt,
    warnings: input.result.warnings.length > 0 ? input.result.warnings : input.launching.warnings,
    error:
      input.result.teamLaunchState === 'partial_failure'
        ? input.result.diagnostics.join('\n') || 'OpenCode launch failed'
        : undefined,
    cliLogsTail: input.result.diagnostics.join('\n') || undefined,
    configReady: true,
  };
}

export async function prepareOpenCodeRuntimeAdapterLaunchPreflight(
  input: {
    teamName: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  },
  ports: OpenCodeRuntimeAdapterLaunchPreflightPorts
): Promise<TeamLaunchResponse | null> {
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  const previousRuntimeRun = ports.getRuntimeAdapterRun(input.teamName);
  if (previousRuntimeRun?.providerId === 'opencode') {
    await ports.stopOpenCodeRuntimeAdapterTeam(input.teamName, previousRuntimeRun.runId);
  }
  const previousPendingRunId = ports.getProvisioningRun(input.teamName);
  const previousRuntimeProgress = previousPendingRunId
    ? ports.getRuntimeAdapterProgress(previousPendingRunId)
    : undefined;
  if (
    previousPendingRunId &&
    previousRuntimeProgress &&
    ports.isCancellableRuntimeAdapterProgress(previousRuntimeProgress)
  ) {
    await ports.cancelRuntimeAdapterProvisioning(previousPendingRunId, previousRuntimeProgress);
  }
  if (ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart) {
    return ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
      input.teamName,
      input.sourceWarning,
      input.onProgress
    );
  }
  return null;
}

export async function runOpenCodeTeamRuntimeAdapterLaunch(
  input: RunOpenCodeTeamRuntimeAdapterLaunchInput,
  ports: OpenCodeRuntimeAdapterLaunchPorts
): Promise<TeamLaunchResponse> {
  const teamName = input.request.teamName;
  const preflightCancellation = await prepareOpenCodeRuntimeAdapterLaunchPreflight(
    {
      teamName,
      sourceWarning: input.sourceWarning,
      onProgress: input.onProgress,
    },
    ports
  );
  if (preflightCancellation) {
    return preflightCancellation;
  }

  const runId = ports.randomUUID();
  const startedAt = ports.nowIso();
  const initialProgress: TeamProvisioningProgress = {
    runId,
    teamName,
    state: 'validating',
    message: 'Validating OpenCode team launch gate',
    startedAt,
    updatedAt: startedAt,
    warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
  };
  ports.setProvisioningRun(teamName, runId);
  ports.setRuntimeAdapterProgress(initialProgress, input.onProgress);
  ports.resetTeamScopedTransientStateForNewRun(teamName);
  const previousLaunchState = await ports.readLaunchState(teamName);
  await ports.clearPersistedLaunchState(teamName);
  await ports.migrateLegacyOpenCodeRuntimeState({
    teamsBasePath: ports.getTeamsBasePath(),
    teamName,
    laneId: 'primary',
  });
  await ports.upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: ports.getTeamsBasePath(),
    teamName,
    laneId: 'primary',
    state: 'active',
  });
  const { launchCwd, launchInput } = buildOpenCodeRuntimeAdapterLaunchInput({
    runId,
    teamName,
    cwd: input.request.cwd,
    prompt: input.prompt,
    request: input.request,
    members: input.members,
    previousLaunchState,
    getOpenCodeRuntimeLaunchCwd: ports.getOpenCodeRuntimeLaunchCwd,
  });

  const launching = ports.setRuntimeAdapterProgress(
    {
      ...initialProgress,
      state: 'spawning',
      message: 'Starting OpenCode sessions through runtime adapter',
      updatedAt: ports.nowIso(),
    },
    input.onProgress
  );

  try {
    await ports.setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: ports.getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      runId,
    });
    const launchResult = await input.adapter.launch(launchInput);
    if (
      ports.consumeCancelledRuntimeAdapterRunId(runId) ||
      ports.getProvisioningRun(teamName) !== runId
    ) {
      await ports.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId);
      return { runId };
    }
    const { result } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      launchResult,
      launchInput
    );
    if (
      ports.consumeCancelledRuntimeAdapterRunId(runId) ||
      ports.getProvisioningRun(teamName) !== runId
    ) {
      await ports.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId);
      return { runId };
    }
    const requestTeamColor = 'color' in input.request ? input.request.color : undefined;
    const requestTeamDisplayName =
      'displayName' in input.request ? input.request.displayName : undefined;
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName,
      runId,
      laneId: 'primary',
      cwd: launchCwd,
      members: result.members,
      expectedMembers: launchInput.expectedMembers,
      teamColor: requestTeamColor,
      teamDisplayName: requestTeamDisplayName,
    });
    const failed = result.teamLaunchState === 'partial_failure';
    const retainRuntime = shouldRetainOpenCodeRuntimeLaunch(result);
    const finalProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeRuntimeAdapterFinalProgress({
        launching,
        result,
        updatedAt: ports.nowIso(),
      }),
      input.onProgress
    );
    if (failed && !retainRuntime) {
      await ports
        .clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: ports.getTeamsBasePath(),
          teamName,
          laneId: 'primary',
        })
        .catch(() => undefined);
      ports.deleteRuntimeAdapterRun(teamName);
      ports.deleteAliveRunId(teamName);
      ports.invalidateRuntimeSnapshotCaches(teamName);
    } else {
      ports.setRuntimeAdapterRun(teamName, {
        runId,
        providerId: 'opencode',
        cwd: launchCwd,
        members: result.members,
      });
      ports.setAliveRunId(teamName, runId);
      ports.invalidateRuntimeSnapshotCaches(teamName);
    }
    ports.deleteProvisioningRunIfCurrent(teamName, runId);
    ports.emitTeamProcessChange({
      type: 'process',
      teamName,
      runId,
      detail: finalProgress.state,
    });
    return { runId };
  } catch (error) {
    if (
      ports.consumeCancelledRuntimeAdapterRunId(runId) ||
      ports.getProvisioningRun(teamName) !== runId
    ) {
      await ports.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId);
      return { runId };
    }
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName,
        laneId: 'primary',
      })
      .catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    ports.setRuntimeAdapterProgress(
      {
        ...launching,
        state: 'failed',
        message: 'OpenCode runtime adapter launch failed',
        messageSeverity: 'error',
        updatedAt: ports.nowIso(),
        error: message,
        cliLogsTail: message,
      },
      input.onProgress
    );
    ports.deleteProvisioningRunIfCurrent(teamName, runId);
    throw error;
  }
}
