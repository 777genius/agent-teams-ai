import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';

import { getTeamsBasePathsToProbe } from './TeamProvisioningRuntimeLaunchSelection';
import { createMixedSecondaryLaneStates } from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export interface CreateOpenCodeAggregateProvisioningRunParams {
  runId: string;
  startedAt: string;
  progress: TeamProvisioningProgress;
  request: TeamCreateRequest | TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
  onProgress: (progress: TeamProvisioningProgress) => void;
}

export function createOpenCodeAggregateProvisioningRun(
  params: CreateOpenCodeAggregateProvisioningRunParams
) {
  return {
    runId: params.runId,
    teamName: params.request.teamName,
    startedAt: params.startedAt,
    progress: params.progress,
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    lastClaudeLogStream: null,
    stdoutLogLineBuf: '',
    stderrLogLineBuf: '',
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    deterministicBootstrapMemberSpawnSeen: false,
    deterministicBootstrapMemberResultSeen: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    teamsBasePathsToProbe: getTeamsBasePathsToProbe(),
    child: null,
    timeoutHandle: null,
    fsMonitorHandle: null,
    onProgress: params.onProgress,
    expectedMembers: params.lanePlan.primaryMembers.map((member) => member.name),
    request: {
      ...params.request,
      members: params.members,
    } as TeamCreateRequest,
    allEffectiveMembers: params.members,
    effectiveMembers: params.lanePlan.primaryMembers,
    launchIdentity: null,
    mixedSecondaryLanes: createMixedSecondaryLaneStates(params.lanePlan),
    lastLogProgressAt: 0,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    stallCheckHandle: null,
    stallWarningIndex: null,
    preStallMessage: null,
    lastRetryAt: 0,
    apiRetryWarningIndex: null,
    apiErrorWarningEmitted: false,
    fsPhase: 'all_files_found' as const,
    waitingTasksSince: null,
    provisioningComplete: false,
    processClosed: false,
    requiresFirstRealTurnSuccess: false,
    firstRealTurnSucceeded: false,
    mcpConfigPath: null,
    memberMcpConfigPaths: [],
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    isLaunch: true,
    launchStateClearedForRun: false,
    deterministicBootstrap: false,
    workspaceTrustPlan: null,
    workspaceTrustExecution: null,
    workspaceTrustDiagnostics: null,
    workspaceTrustRetryAttempted: false,
    leadRelayCapture: null,
    activeCrossTeamReplyHints: [],
    leadMsgSeq: 0,
    liveLeadTextBuffer: null,
    pendingToolCalls: [],
    activeToolCalls: new Map(),
    pendingDirectCrossTeamSendRefresh: false,
    lastLeadTextEmitMs: 0,
    silentUserDmForward: null,
    silentUserDmForwardClearHandle: null,
    pendingInboxRelayCandidates: [],
    provisioningOutputParts: [],
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputIndexByMessageId: new Map(),
    detectedSessionId: null,
    leadActivityState: 'active' as const,
    authFailureRetried: false,
    authRetryInProgress: false,
    leadContextUsage: null,
    spawnContext: null,
    anthropicApiKeyHelper: null,
    pendingApprovals: new Map(),
    processedPermissionRequestIds: new Set(),
    pendingPostCompactReminder: false,
    postCompactReminderInFlight: false,
    suppressPostCompactReminderOutput: false,
    pendingGeminiPostLaunchHydration: false,
    geminiPostLaunchHydrationInFlight: false,
    geminiPostLaunchHydrationSent: false,
    suppressGeminiPostLaunchHydrationOutput: false,
    memberSpawnStatuses: new Map(),
    memberSpawnToolUseIds: new Map(),
    pendingMemberRestarts: new Map(),
    memberSpawnLeadInboxCursorByMember: new Map(),
    lastDeterministicBootstrapSeq: 0,
    lastMemberSpawnAuditAt: 0,
    lastMemberSpawnAuditConfigReadWarningAt: 0,
    lastMemberSpawnAuditMissingWarningAt: new Map(),
  };
}

export type OpenCodeAggregateProvisioningRun = ReturnType<
  typeof createOpenCodeAggregateProvisioningRun
>;

export interface OpenCodeAggregateRuntimeRunEntry {
  runId: string;
  providerId: string;
}

export interface OpenCodeWorktreeRootAggregateLaunchPreflightPorts {
  getStopAllTeamsGeneration(): number;
  getRuntimeAdapterRun(teamName: string): OpenCodeAggregateRuntimeRunEntry | undefined;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
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

export interface OpenCodeWorktreeRootAggregateLaunchPorts extends OpenCodeWorktreeRootAggregateLaunchPreflightPorts {
  randomUUID(): string;
  nowIso(): string;
  setProvisioningRun(teamName: string, runId: string): void;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  readLaunchState(teamName: string): Promise<TeamRuntimeLaunchInput['previousLaunchState']>;
  clearPersistedLaunchState(teamName: string): Promise<void>;
  setRun(runId: string, run: OpenCodeAggregateProvisioningRun): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  launchOpenCodeAggregatePrimaryLane(input: {
    run: OpenCodeAggregateProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeLaunchResult | null>;
  launchSingleMixedSecondaryLane(
    run: OpenCodeAggregateProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  summarizeOpenCodeAggregateLaunchState(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'];
  persistLaunchStateSnapshot(
    run: OpenCodeAggregateProvisioningRun,
    launchPhase: 'active' | 'finished'
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  syncRunMemberSpawnStatusesFromSnapshot(
    run: OpenCodeAggregateProvisioningRun,
    snapshot: PersistedTeamLaunchSnapshot
  ): void;
  setAliveRunId(teamName: string, runId: string): void;
  deleteAliveRunId(teamName: string): void;
  deleteRuntimeAdapterRun(teamName: string): void;
  deleteProvisioningRunIfCurrent(teamName: string, runId: string): void;
  cleanupRun(run: OpenCodeAggregateProvisioningRun): void;
  emitTeamProcessChange(input: {
    type: 'process';
    teamName: string;
    runId: string;
    detail: TeamProvisioningProgress['state'];
  }): void;
  consumeCancelledRuntimeAdapterRunId(runId: string): boolean;
  getTeamsBasePath(): string;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<unknown>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
}

export interface RunOpenCodeWorktreeRootAggregateLaunchInput {
  adapter: TeamLaunchRuntimeAdapter;
  request: TeamCreateRequest | TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
  prompt: string;
  sourceWarning?: string;
  onProgress: (progress: TeamProvisioningProgress) => void;
}

export interface OpenCodeAggregateFinalProgressInput {
  launching: TeamProvisioningProgress;
  launchState: TeamRuntimeLaunchResult['teamLaunchState'];
  laneDiagnostics: readonly string[];
  updatedAt: string;
}

export function buildOpenCodeAggregateFinalProgress(
  input: OpenCodeAggregateFinalProgressInput
): TeamProvisioningProgress {
  const success = input.launchState === 'clean_success';
  const pending = input.launchState === 'partial_pending';
  const failed = input.launchState === 'partial_failure';
  return {
    ...input.launching,
    state: success || pending ? 'ready' : 'failed',
    message: success
      ? 'OpenCode member lanes are ready'
      : pending
        ? 'OpenCode member lanes are waiting for runtime evidence or permissions'
        : 'OpenCode member lane launch failed readiness gate',
    messageSeverity: pending ? 'warning' : failed ? 'error' : undefined,
    updatedAt: input.updatedAt,
    error: failed
      ? input.laneDiagnostics.filter(Boolean).join('\n') || 'OpenCode member lane launch failed'
      : undefined,
    cliLogsTail: input.laneDiagnostics.join('\n') || undefined,
    configReady: true,
  };
}

export function buildOpenCodeAggregateFailureProgress(input: {
  launching: TeamProvisioningProgress;
  message: string;
  updatedAt: string;
}): TeamProvisioningProgress {
  return {
    ...input.launching,
    state: 'failed',
    message: 'OpenCode member lane launch failed',
    messageSeverity: 'error',
    updatedAt: input.updatedAt,
    error: input.message,
    cliLogsTail: input.message,
  };
}

export async function prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
  input: {
    teamName: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  },
  ports: OpenCodeWorktreeRootAggregateLaunchPreflightPorts
): Promise<TeamLaunchResponse | null> {
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  const previousRuntimeRun = ports.getRuntimeAdapterRun(input.teamName);
  if (previousRuntimeRun?.providerId === 'opencode') {
    await ports.stopOpenCodeRuntimeAdapterTeam(input.teamName, previousRuntimeRun.runId);
  }
  if (ports.hasSecondaryRuntimeRuns(input.teamName)) {
    await ports.stopMixedSecondaryRuntimeLanes(input.teamName);
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

async function stopAndRollbackOpenCodeAggregateRuntimeLanes(
  run: OpenCodeAggregateProvisioningRun,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): Promise<void> {
  const ownedRuntimeRun = ports.getRuntimeAdapterRun(run.teamName);
  const stops: Promise<void>[] = [];
  if (ownedRuntimeRun?.providerId === 'opencode' && ownedRuntimeRun.runId === run.runId) {
    stops.push(ports.stopOpenCodeRuntimeAdapterTeam(run.teamName, run.runId));
  }
  if (ports.hasSecondaryRuntimeRuns(run.teamName)) {
    stops.push(ports.stopMixedSecondaryRuntimeLanes(run.teamName));
  }
  if (stops.length > 0) {
    await Promise.all(stops.map((stop) => stop.catch(() => undefined)));
  }

  // The stop flows clear lane storage themselves, but repeat the rollback here
  // best-effort so a rejected or partially completed stop cannot leave launch
  // artifacts behind. Lane storage deletion is intentionally idempotent.
  for (const lane of run.mixedSecondaryLanes) {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
      })
      .catch(() => undefined);
    ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
  }
  if (run.effectiveMembers.length > 0) {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: 'primary',
      })
      .catch(() => undefined);
  }
}

function deleteOpenCodeAggregateRuntimeTrackingIfOwned(
  teamName: string,
  runId: string,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  const currentRuntimeRun = ports.getRuntimeAdapterRun(teamName);
  const hasConflictingRuntimeOwner =
    currentRuntimeRun !== undefined &&
    (currentRuntimeRun.providerId !== 'opencode' || currentRuntimeRun.runId !== runId);
  if (hasConflictingRuntimeOwner) {
    return;
  }

  ports.deleteRuntimeAdapterRun(teamName);
  if (ports.getProvisioningRun(teamName) === runId) {
    ports.deleteAliveRunId(teamName);
  }
}

export async function runOpenCodeWorktreeRootAggregateLaunch(
  input: RunOpenCodeWorktreeRootAggregateLaunchInput,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): Promise<TeamLaunchResponse> {
  const teamName = input.request.teamName;
  const preflightCancellation = await prepareOpenCodeWorktreeRootAggregateLaunchPreflight(
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
    message: 'Validating OpenCode member lane launch gate',
    startedAt,
    updatedAt: startedAt,
    warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
  };
  ports.setProvisioningRun(teamName, runId);
  const initialRuntimeProgress = ports.setRuntimeAdapterProgress(initialProgress, input.onProgress);
  ports.resetTeamScopedTransientStateForNewRun(teamName);
  const previousLaunchState = await ports.readLaunchState(teamName);
  await ports.clearPersistedLaunchState(teamName);

  const run = createOpenCodeAggregateProvisioningRun({
    runId,
    startedAt,
    progress: initialRuntimeProgress,
    request: input.request,
    members: input.members,
    lanePlan: input.lanePlan,
    onProgress: input.onProgress,
  });
  ports.setRun(runId, run);
  ports.invalidateRuntimeSnapshotCaches(teamName);

  const launching = ports.setRuntimeAdapterProgress(
    {
      ...initialRuntimeProgress,
      state: 'spawning',
      message: 'Starting OpenCode member runtime lanes',
      updatedAt: ports.nowIso(),
    },
    input.onProgress
  );
  run.progress = launching;

  try {
    const primaryResult = await ports.launchOpenCodeAggregatePrimaryLane({
      run,
      adapter: input.adapter,
      prompt: input.prompt,
      previousLaunchState,
    });
    for (const lane of run.mixedSecondaryLanes) {
      if (run.cancelRequested || run.processKilled) {
        break;
      }
      await ports.launchSingleMixedSecondaryLane(run, lane);
    }

    run.provisioningComplete = true;
    const launchState = ports.summarizeOpenCodeAggregateLaunchState({
      primaryResult,
      lanes: run.mixedSecondaryLanes,
    });
    const launchPhase = launchState === 'partial_pending' ? 'active' : 'finished';
    const snapshot = await ports.persistLaunchStateSnapshot(run, launchPhase);
    if (snapshot) {
      ports.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    }

    // A concurrent (lockless) stop or a superseding run may have taken over the
    // team while the lanes launched and the snapshot persisted. Re-check exact
    // ownership before registering this run alive; otherwise the success tail
    // resurrects a run the stop just tore down (state drift). Mirrors the
    // non-aggregate primary launch path and this function's own catch branch.
    if (
      ports.consumeCancelledRuntimeAdapterRunId(runId) ||
      ports.getProvisioningRun(teamName) !== runId
    ) {
      ports.cleanupRun(run);
      return { runId };
    }

    const success = launchState === 'clean_success';
    const pending = launchState === 'partial_pending';
    const laneDiagnostics = run.mixedSecondaryLanes.flatMap((lane) => lane.diagnostics);
    const finalProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeAggregateFinalProgress({
        launching,
        launchState,
        laneDiagnostics,
        updatedAt: ports.nowIso(),
      }),
      input.onProgress
    );
    run.progress = finalProgress;
    if (success || pending) {
      ports.setAliveRunId(teamName, runId);
    } else {
      // A summarized terminal failure is non-throwing, but it owns the same
      // adapter-managed processes and rollback obligations as the catch path.
      // Stop all lanes before cleanupRun removes their tracking.
      await stopAndRollbackOpenCodeAggregateRuntimeLanes(run, ports);
      // Terminal failure: tear the run down fully. Removing it from the runs map
      // and clearing its timers/watchdogs/pending approvals (cleanupRun) is what a
      // clean-success run intentionally skips, but a failed one must not leak.
      deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
      ports.cleanupRun(run);
    }
    ports.deleteProvisioningRunIfCurrent(teamName, runId);
    ports.invalidateRuntimeSnapshotCaches(teamName);
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
      return { runId };
    }
    // Genuine launch error after lanes came up: stop the owned primary OpenCode
    // adapter process (and any secondary lanes) BEFORE clearing their storage.
    // The adapter-managed process is not covered by run.child (null), so without
    // an explicit stop it is orphaned when the maps/storage below are cleared.
    await stopAndRollbackOpenCodeAggregateRuntimeLanes(run, ports);
    const message = error instanceof Error ? error.message : String(error);
    const failedProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeAggregateFailureProgress({
        launching,
        message,
        updatedAt: ports.nowIso(),
      }),
      input.onProgress
    );
    run.progress = failedProgress;
    deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
    ports.deleteProvisioningRunIfCurrent(teamName, runId);
    // Genuine launch error: remove the run from the runs map and clear its
    // timers/watchdogs/pending approvals so a failed aggregate launch does not
    // leak a dead run (cleanupRun internally no-ops team-scoped work if a newer
    // run has since taken over).
    ports.cleanupRun(run);
    ports.invalidateRuntimeSnapshotCaches(teamName);
    throw error;
  }
}
