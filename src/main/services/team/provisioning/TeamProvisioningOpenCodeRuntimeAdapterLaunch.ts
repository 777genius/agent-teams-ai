import { snapshotToMemberSpawnStatuses } from '../TeamLaunchStateEvaluator';

import { shouldRetainOpenCodeRuntimeLaunch } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberSpec,
} from '../runtime';
import type { OpenCodeLaunchFailureArtifactPort } from './TeamProvisioningOpenCodeLaunchFailureArtifact';
import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamLaunchDiagnosticItem,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export interface OpenCodeRuntimeAdapterRunEntry {
  runId: string;
  providerId: string;
  cwd?: string;
  allowExperimentalLocalModels?: boolean;
  members?: TeamRuntimeLaunchResult['members'];
}

export interface OpenCodeRuntimeAdapterLaunchInputParams {
  runId: string;
  teamName: string;
  cwd: string;
  prompt: string;
  request: Pick<
    TeamCreateRequest | TeamLaunchRequest,
    'model' | 'effort' | 'skipPermissions' | 'allowExperimentalLocalModels'
  >;
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
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
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
  isCancelledRuntimeAdapterRunId(runId: string): boolean;
  consumeCancelledRuntimeAdapterRunId(runId: string): boolean;
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{ result: TeamRuntimeLaunchResult; snapshot?: PersistedTeamLaunchSnapshot }>;
  launchFailureArtifacts: OpenCodeLaunchFailureArtifactPort;
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
    expectedRunId: string;
  }): Promise<unknown>;
  deleteRuntimeOwnershipIfCurrent(teamName: string, runId: string): void;
  setRuntimeAdapterRun(
    teamName: string,
    runtimeRun: {
      runId: string;
      providerId: 'opencode';
      cwd: string;
      allowExperimentalLocalModels?: boolean;
      members: TeamRuntimeLaunchResult['members'];
    }
  ): void;
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

function hasOpenCodeLaunchAuthority(
  ports: OpenCodeRuntimeAdapterLaunchPorts,
  teamName: string,
  runId: string
): boolean {
  return (
    ports.getProvisioningRun(teamName) === runId && !ports.isCancelledRuntimeAdapterRunId(runId)
  );
}

async function finishOpenCodeLaunchAuthorityLoss(
  ports: OpenCodeRuntimeAdapterLaunchPorts,
  teamName: string,
  runId: string
): Promise<TeamLaunchResponse> {
  ports.consumeCancelledRuntimeAdapterRunId(runId);
  await ports.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId).catch(() => undefined);
  return { runId };
}

async function clearOpenCodeLaunchLaneStorageBestEffort(
  ports: OpenCodeRuntimeAdapterLaunchPorts,
  teamName: string,
  runId: string
): Promise<void> {
  try {
    await ports.clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      expectedRunId: runId,
    });
  } catch {
    // Run-owned cleanup is best effort and must not replace a launch outcome.
  }
}

function flattenFailureDiagnostics(diagnostics: readonly string[], fallback: string): string[] {
  const flattened = diagnostics
    .flatMap((diagnostic) => diagnostic.split(/\r?\n/))
    .map((diagnostic) => diagnostic.trim())
    .filter(Boolean);
  return flattened.length > 0 ? [...new Set(flattened)] : [fallback];
}

function buildFailureDiagnosticItems(
  diagnostics: readonly string[],
  observedAt: string
): TeamLaunchDiagnosticItem[] {
  return diagnostics.map((detail, index) => ({
    id: `opencode-runtime-adapter:${index}`,
    severity: 'error',
    code: 'bootstrap_stalled',
    label: 'OpenCode runtime adapter launch failed',
    detail,
    observedAt,
  }));
}

function publishFailedProgress(
  ports: OpenCodeRuntimeAdapterLaunchPorts,
  onProgress: (progress: TeamProvisioningProgress) => void,
  progress: TeamProvisioningProgress
): TeamProvisioningProgress {
  try {
    return ports.setRuntimeAdapterProgress(progress, onProgress);
  } catch {
    return progress;
  }
}

async function writeOpenCodeLaunchFailureArtifact(
  ports: OpenCodeRuntimeAdapterLaunchPorts,
  input: RunOpenCodeTeamRuntimeAdapterLaunchInput,
  params: {
    runId: string;
    startedAt: string;
    launchCwd: string;
    progress: TeamProvisioningProgress;
    reason: string;
    diagnostics: readonly string[];
    launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  }
): Promise<void> {
  const diagnostics = flattenFailureDiagnostics(
    params.diagnostics,
    params.progress.error ?? 'OpenCode launch failed'
  );
  const snapshot = params.launchSnapshot ?? null;
  try {
    await ports.launchFailureArtifacts.write({
      teamName: input.request.teamName,
      runId: params.runId,
      reason: params.reason,
      startedAt: params.startedAt,
      cwd: params.launchCwd,
      providerId: 'opencode',
      providerBackendId: input.request.providerBackendId,
      model: input.request.model,
      expectedMembers: input.members.map((member) => member.name),
      effectiveMembers: input.members,
      progress: params.progress,
      launchSnapshot: snapshot,
      launchDiagnostics: buildFailureDiagnosticItems(diagnostics, params.progress.updatedAt),
      ...(snapshot ? { memberSpawnStatuses: snapshotToMemberSpawnStatuses(snapshot) } : {}),
      cliLogs: diagnostics.join('\n'),
      flags: {
        isLaunch: true,
        provisioningComplete: params.reason === 'opencode_runtime_adapter_partial_failure',
        runtimeAdapterLaunch: true,
        runtimeLaneId: 'primary',
      },
    });
  } catch {
    // The concrete output adapter logs and swallows writer failures. Preserve
    // launch semantics even if a replacement port violates that contract.
  }
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
      ...(params.request.allowExperimentalLocalModels === true
        ? { allowExperimentalLocalModels: true }
        : {}),
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
  let latestProgress = initialProgress;
  let latestPersistedSnapshot: PersistedTeamLaunchSnapshot | null = null;
  let launchCwd = input.request.cwd;
  try {
    latestProgress = ports.setRuntimeAdapterProgress(initialProgress, input.onProgress);
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    ports.resetTeamScopedTransientStateForNewRun(teamName);

    const previousLaunchState = await ports.readLaunchState(teamName);
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    await ports.clearPersistedLaunchState(teamName, { expectedRunId: runId });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    await ports.migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: ports.getTeamsBasePath(),
      teamName,
      laneId: 'primary',
    });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    await ports.upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: ports.getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: 'active',
    });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }

    const builtLaunch = buildOpenCodeRuntimeAdapterLaunchInput({
      runId,
      teamName,
      cwd: input.request.cwd,
      prompt: input.prompt,
      request: input.request,
      members: input.members,
      previousLaunchState,
      getOpenCodeRuntimeLaunchCwd: ports.getOpenCodeRuntimeLaunchCwd,
    });
    launchCwd = builtLaunch.launchCwd;
    const launchInput = builtLaunch.launchInput;
    const launching = ports.setRuntimeAdapterProgress(
      {
        ...initialProgress,
        state: 'spawning',
        message: 'Starting OpenCode sessions through runtime adapter',
        updatedAt: ports.nowIso(),
      },
      input.onProgress
    );
    latestProgress = launching;
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }

    await ports.setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: ports.getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      runId,
    });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    const launchResult = await input.adapter.launch(launchInput);
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    const { result, snapshot } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
      launchResult,
      launchInput
    );
    latestPersistedSnapshot = snapshot ?? null;
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
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
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
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
    latestProgress = finalProgress;
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    if (failed) {
      await writeOpenCodeLaunchFailureArtifact(ports, input, {
        runId,
        startedAt,
        launchCwd,
        progress: finalProgress,
        reason: 'opencode_runtime_adapter_partial_failure',
        diagnostics: result.diagnostics,
        launchSnapshot: latestPersistedSnapshot,
      });
      if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
        return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
      }
    }
    if (failed && !retainRuntime) {
      await clearOpenCodeLaunchLaneStorageBestEffort(ports, teamName, runId);
      if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
        return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
      }
      ports.deleteRuntimeOwnershipIfCurrent(teamName, runId);
      ports.invalidateRuntimeSnapshotCaches(teamName);
    } else {
      ports.setRuntimeAdapterRun(teamName, {
        runId,
        providerId: 'opencode',
        cwd: launchCwd,
        ...(input.request.allowExperimentalLocalModels === true
          ? { allowExperimentalLocalModels: true }
          : {}),
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
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    const message = error instanceof Error ? error.message : String(error);
    let failureUpdatedAt = latestProgress.updatedAt;
    try {
      failureUpdatedAt = ports.nowIso();
    } catch {
      // Preserve the original failure if the injected clock is unavailable.
    }
    const failedProgress = publishFailedProgress(ports, input.onProgress, {
      ...latestProgress,
      state: 'failed',
      message: 'OpenCode runtime adapter launch failed',
      messageSeverity: 'error',
      updatedAt: failureUpdatedAt,
      error: message,
      cliLogsTail: message,
    });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    await writeOpenCodeLaunchFailureArtifact(ports, input, {
      runId,
      startedAt,
      launchCwd,
      progress: failedProgress,
      reason: 'opencode_runtime_adapter_error',
      diagnostics: [message],
      launchSnapshot: latestPersistedSnapshot,
    });
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    await clearOpenCodeLaunchLaneStorageBestEffort(ports, teamName, runId);
    if (!hasOpenCodeLaunchAuthority(ports, teamName, runId)) {
      return finishOpenCodeLaunchAuthorityLoss(ports, teamName, runId);
    }
    try {
      ports.deleteRuntimeOwnershipIfCurrent(teamName, runId);
    } catch {
      // Preserve the original failure object on rethrow.
    }
    try {
      ports.invalidateRuntimeSnapshotCaches(teamName);
    } catch {
      // Preserve the original failure object on rethrow.
    }
    try {
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
    } catch {
      // Preserve the original failure object on rethrow.
    }
    throw error;
  }
}
