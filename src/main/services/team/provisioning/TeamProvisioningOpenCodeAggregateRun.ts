import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import * as path from 'path';

import { selectOpenCodeLaunchFailureDiagnostic } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  hasRetainableOpenCodeRuntimeMember,
  markOpenCodeLaneBlockedBySharedRuntimeFailure,
  selectOpenCodeSharedRuntimePreflightFailureDiagnostic,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { getTeamsBasePathsToProbe } from './TeamProvisioningRuntimeLaunchSelection';
import { createMixedSecondaryLaneStates } from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type {
  MixedSecondaryRuntimeLaneState,
  SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';
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

export type OpenCodeAggregateProvisioningRun = ProvisioningRun & {
  mixedSecondarySharedRuntimeFailuresByProject: Map<string, string>;
};

export function createOpenCodeAggregateProvisioningRun(
  params: CreateOpenCodeAggregateProvisioningRunParams
): OpenCodeAggregateProvisioningRun {
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
    mixedSecondarySharedRuntimeFailuresByProject: new Map<string, string>(),
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
    anthropicApiKeyHelperCleanupPromise: null,
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

export interface OpenCodeAggregateRuntimeRunEntry {
  runId: string;
  providerId: string;
  cwd?: string;
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
  nowMs(): number;
  nowIso(): string;
  setProvisioningRun(teamName: string, runId: string): void;
  getRun(runId: string): OpenCodeAggregateProvisioningRun | undefined;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  readLaunchState(teamName: string): Promise<TeamRuntimeLaunchInput['previousLaunchState']>;
  clearPersistedLaunchState(teamName: string, options?: { expectedRunId?: string }): Promise<void>;
  setRun(runId: string, run: OpenCodeAggregateProvisioningRun): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  launchOpenCodeAggregatePrimaryLane(input: {
    run: OpenCodeAggregateProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    assertStillCurrentAfterPersistence?: () => void;
  }): Promise<TeamRuntimeLaunchResult | null>;
  launchSingleMixedSecondaryLane(
    run: OpenCodeAggregateProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  publishMixedSecondaryLaneStatusChange(
    run: OpenCodeAggregateProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
  getSecondaryRuntimeRun(teamName: string, laneId: string): SecondaryRuntimeRunEntry | undefined;
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
  setRuntimeAdapterRun(
    teamName: string,
    run: OpenCodeAggregateRuntimeRunEntry & { providerId: 'opencode' }
  ): void;
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
    expectedRunId: string;
  }): Promise<boolean>;
  setSecondaryRuntimeRun(input: SecondaryRuntimeRunEntry & { teamName: string }): void;
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
  partialTeamCanContinue?: boolean;
  terminalFailureError?: string | null;
}

export function buildOpenCodeAggregateFinalProgress(
  input: OpenCodeAggregateFinalProgressInput
): TeamProvisioningProgress {
  const success = input.launchState === 'clean_success';
  const pending = input.launchState === 'partial_pending';
  const failed = input.launchState === 'partial_failure';
  const terminalFailure = failed && input.partialTeamCanContinue !== true;
  return {
    ...input.launching,
    state: terminalFailure ? 'failed' : 'ready',
    message: success
      ? 'OpenCode member lanes are ready'
      : pending
        ? 'OpenCode member lanes are waiting for runtime evidence or permissions'
        : input.partialTeamCanContinue
          ? 'OpenCode team is running with unavailable members'
          : 'OpenCode member lane launch failed readiness gate',
    messageSeverity:
      pending || input.partialTeamCanContinue ? 'warning' : failed ? 'error' : undefined,
    updatedAt: input.updatedAt,
    error: terminalFailure
      ? (input.terminalFailureError ??
        (input.laneDiagnostics.filter(Boolean).join('\n') || 'OpenCode member lane launch failed'))
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
  const recordCancellationIfRequested = (): TeamLaunchResponse | null =>
    ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart
      ? ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
          input.teamName,
          input.sourceWarning,
          input.onProgress
        )
      : null;
  const previousRuntimeRun = ports.getRuntimeAdapterRun(input.teamName);
  if (previousRuntimeRun?.providerId === 'opencode') {
    await ports.stopOpenCodeRuntimeAdapterTeam(input.teamName, previousRuntimeRun.runId);
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
  }
  if (ports.hasSecondaryRuntimeRuns(input.teamName)) {
    await ports.stopMixedSecondaryRuntimeLanes(input.teamName);
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
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
    const cancellation = recordCancellationIfRequested();
    if (cancellation) return cancellation;
  }
  return recordCancellationIfRequested();
}

async function stopAndRollbackOpenCodeAggregateRuntimeLanes(
  run: OpenCodeAggregateProvisioningRun,
  input: {
    adapter: TeamLaunchRuntimeAdapter;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    primaryCwd: string;
    secondaryCwds: ReadonlyMap<string, string>;
    untrackedPrimaryLaunchMayBeRunning: boolean;
  },
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): Promise<boolean> {
  let rollbackComplete = true;
  let primaryCleanupConfirmed = run.effectiveMembers.length === 0;
  let primaryStorageCleanupRequired = false;
  let exactPrimaryStopOwner:
    | (OpenCodeAggregateRuntimeRunEntry & { providerId: 'opencode' })
    | undefined;
  const ownedRuntimeRun = ports.getRuntimeAdapterRun(run.teamName);
  if (
    input.untrackedPrimaryLaunchMayBeRunning &&
    ownedRuntimeRun === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    exactPrimaryStopOwner = {
      runId: run.runId,
      providerId: 'opencode',
      cwd: input.primaryCwd,
    };
    ports.setRuntimeAdapterRun(run.teamName, exactPrimaryStopOwner);
  } else if (ownedRuntimeRun?.providerId === 'opencode' && ownedRuntimeRun.runId === run.runId) {
    exactPrimaryStopOwner = ownedRuntimeRun as OpenCodeAggregateRuntimeRunEntry & {
      providerId: 'opencode';
    };
  }
  publishOpenCodeAggregateRollbackPendingStop(run, ports);

  if (ownedRuntimeRun?.providerId === 'opencode' && ownedRuntimeRun.runId === run.runId) {
    try {
      await ports.stopOpenCodeRuntimeAdapterTeam(run.teamName, run.runId);
      primaryCleanupConfirmed = true;
    } catch {
      rollbackComplete = false;
    }
  } else if (input.untrackedPrimaryLaunchMayBeRunning) {
    try {
      const stopResult = await input.adapter.stop({
        runId: run.runId,
        teamName: run.teamName,
        laneId: 'primary',
        cwd: input.primaryCwd,
        providerId: 'opencode',
        reason: 'cleanup',
        force: true,
        previousLaunchState: input.previousLaunchState,
      });
      assertAggregateRuntimeStopConfirmed(stopResult, 'OpenCode aggregate primary lane');
      primaryCleanupConfirmed = true;
      primaryStorageCleanupRequired = true;
    } catch {
      rollbackComplete = false;
      retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
    }
  } else {
    primaryCleanupConfirmed = true;
  }

  // Secondary lanes are stopped one-by-one by exact lane/run identity. A
  // team-scoped stop here could tear down a newer sibling that took ownership
  // while the old aggregate launch was awaiting cancellation.
  for (const lane of run.mixedSecondaryLanes) {
    const laneRunId = lane.runId;
    if (!laneRunId) {
      continue;
    }
    const ownedLane = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    const launchWasSkipped = wasOpenCodeLaneBlockedBeforeLaunch(lane);
    let laneCleanupConfirmed = launchWasSkipped;
    let exactLaneStopOwner: SecondaryRuntimeRunEntry | undefined;
    if (ownedLane?.providerId === 'opencode' && ownedLane.runId === laneRunId) {
      exactLaneStopOwner = ownedLane;
      try {
        const stopResult = await input.adapter.stop({
          runId: ownedLane.runId,
          teamName: run.teamName,
          laneId: lane.laneId,
          cwd: ownedLane.cwd ?? input.secondaryCwds.get(lane.laneId),
          providerId: 'opencode',
          reason: 'cleanup',
          previousLaunchState: input.previousLaunchState,
        });
        assertAggregateRuntimeStopConfirmed(
          stopResult,
          `OpenCode aggregate secondary lane ${lane.laneId}`
        );
        laneCleanupConfirmed = true;
      } catch {
        rollbackComplete = false;
        continue;
      }
    } else if (
      ownedLane === undefined &&
      !launchWasSkipped &&
      ports.getProvisioningRun(run.teamName) === run.runId
    ) {
      const registeredLaneStopOwner = {
        teamName: run.teamName,
        runId: laneRunId,
        providerId: 'opencode',
        laneId: lane.laneId,
        memberName: lane.member.name,
        cwd: input.secondaryCwds.get(lane.laneId),
      } satisfies SecondaryRuntimeRunEntry & { teamName: string };
      ports.setSecondaryRuntimeRun(registeredLaneStopOwner);
      exactLaneStopOwner =
        ports.getSecondaryRuntimeRun(run.teamName, lane.laneId) ?? registeredLaneStopOwner;
      try {
        const stopResult = await input.adapter.stop({
          runId: laneRunId,
          teamName: run.teamName,
          laneId: lane.laneId,
          cwd: input.secondaryCwds.get(lane.laneId),
          providerId: 'opencode',
          reason: 'cleanup',
          previousLaunchState: input.previousLaunchState,
        });
        assertAggregateRuntimeStopConfirmed(
          stopResult,
          `OpenCode aggregate secondary lane ${lane.laneId}`
        );
        laneCleanupConfirmed = true;
      } catch {
        rollbackComplete = false;
        continue;
      }
    }

    if (!laneCleanupConfirmed) {
      continue;
    }

    const currentLane = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    const laneStillOwned =
      exactLaneStopOwner !== undefined
        ? currentLane === exactLaneStopOwner
        : currentLane?.providerId === 'opencode' && currentLane.runId === lane.runId;
    const teamStillOwned = ports.getProvisioningRun(run.teamName) === run.runId;
    if (!laneStillOwned && !(currentLane === undefined && teamStillOwned)) {
      continue;
    }
    let storageCleared = false;
    try {
      storageCleared = await ports.clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        expectedRunId: laneRunId,
      });
    } catch {
      rollbackComplete = false;
      retainUntrackedOpenCodeSecondaryLaneForCleanup(run, lane, laneRunId, input, ports);
      continue;
    }
    if (!storageCleared) {
      const laneAfterFailedClear = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
      const targetStillOwnsLane =
        laneAfterFailedClear?.providerId === 'opencode' && laneAfterFailedClear.runId === laneRunId;
      const targetStillOwnsUntrackedLane =
        laneAfterFailedClear === undefined && ports.getProvisioningRun(run.teamName) === run.runId;
      if (targetStillOwnsLane || (targetStillOwnsUntrackedLane && !launchWasSkipped)) {
        rollbackComplete = false;
        retainUntrackedOpenCodeSecondaryLaneForCleanup(run, lane, laneRunId, input, ports);
      }
      continue;
    }
    const laneAfterStorageClear = ports.getSecondaryRuntimeRun(run.teamName, lane.laneId);
    if (
      exactLaneStopOwner !== undefined
        ? laneAfterStorageClear === exactLaneStopOwner
        : laneAfterStorageClear?.providerId === 'opencode' &&
          laneAfterStorageClear.runId === lane.runId
    ) {
      ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    }
  }

  const currentRuntimeRun = ports.getRuntimeAdapterRun(run.teamName);
  const primaryStillOwned =
    exactPrimaryStopOwner !== undefined
      ? currentRuntimeRun === exactPrimaryStopOwner
      : currentRuntimeRun?.providerId === 'opencode' && currentRuntimeRun.runId === run.runId;
  const teamStillOwned = ports.getProvisioningRun(run.teamName) === run.runId;
  if (
    primaryCleanupConfirmed &&
    primaryStorageCleanupRequired &&
    run.effectiveMembers.length > 0 &&
    (primaryStillOwned || (currentRuntimeRun === undefined && teamStillOwned))
  ) {
    let primaryStorageCleared = false;
    try {
      primaryStorageCleared = await ports.clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.getTeamsBasePath(),
        teamName: run.teamName,
        laneId: 'primary',
        expectedRunId: run.runId,
      });
    } catch {
      rollbackComplete = false;
      retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
    }
    if (!primaryStorageCleared) {
      const ownerAfterFailedClear = ports.getRuntimeAdapterRun(run.teamName);
      const targetStillOwnsPrimary =
        ownerAfterFailedClear?.providerId === 'opencode' &&
        ownerAfterFailedClear.runId === run.runId;
      const targetStillOwnsUntrackedPrimary =
        ownerAfterFailedClear === undefined && ports.getProvisioningRun(run.teamName) === run.runId;
      if (targetStillOwnsPrimary || targetStillOwnsUntrackedPrimary) {
        rollbackComplete = false;
        retainUntrackedOpenCodePrimaryLaneForCleanup(run, input.primaryCwd, ports);
      }
    }
  }
  if (!rollbackComplete) {
    publishOpenCodeAggregateRollbackFailed(run, ports);
  }
  return rollbackComplete;
}

function publishOpenCodeAggregateRollbackPendingStop(
  run: OpenCodeAggregateProvisioningRun,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  run.progress = ports.setRuntimeAdapterProgress(
    {
      ...run.progress,
      state: 'disconnected',
      message: 'Stopping OpenCode runtime lanes for launch rollback',
      updatedAt: ports.nowIso(),
    },
    run.onProgress
  );
  ports.invalidateRuntimeSnapshotCaches(run.teamName);
}

function publishOpenCodeAggregateRollbackFailed(
  run: OpenCodeAggregateProvisioningRun,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  run.progress = ports.setRuntimeAdapterProgress(
    {
      ...run.progress,
      state: 'failed',
      message: 'OpenCode runtime lane rollback could not confirm every stop',
      messageSeverity: 'error',
      updatedAt: ports.nowIso(),
    },
    run.onProgress
  );
  ports.invalidateRuntimeSnapshotCaches(run.teamName);
}

function wasOpenCodeLaneBlockedBeforeLaunch(lane: MixedSecondaryRuntimeLaneState): boolean {
  return lane.diagnostics.some((diagnostic) =>
    diagnostic.includes('This lane was not attempted because it uses the same project runtime.')
  );
}

function retainUntrackedOpenCodeSecondaryLaneForCleanup(
  run: OpenCodeAggregateProvisioningRun,
  lane: MixedSecondaryRuntimeLaneState,
  laneRunId: string,
  input: { secondaryCwds: ReadonlyMap<string, string> },
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  if (
    ports.getSecondaryRuntimeRun(run.teamName, lane.laneId) === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    ports.setSecondaryRuntimeRun({
      teamName: run.teamName,
      runId: laneRunId,
      providerId: 'opencode',
      laneId: lane.laneId,
      memberName: lane.member.name,
      cwd: input.secondaryCwds.get(lane.laneId),
    });
  }
}

function retainUntrackedOpenCodePrimaryLaneForCleanup(
  run: OpenCodeAggregateProvisioningRun,
  primaryCwd: string,
  ports: OpenCodeWorktreeRootAggregateLaunchPorts
): void {
  if (
    ports.getRuntimeAdapterRun(run.teamName) === undefined &&
    ports.getProvisioningRun(run.teamName) === run.runId
  ) {
    ports.setRuntimeAdapterRun(run.teamName, {
      runId: run.runId,
      providerId: 'opencode',
      cwd: primaryCwd,
    });
  }
}

function assertAggregateRuntimeStopConfirmed(
  result: { stopped: boolean; diagnostics: string[]; warnings: string[] },
  label: string
): void {
  if (result.stopped) {
    return;
  }
  const detail = [...result.diagnostics, ...result.warnings]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
  throw new Error(
    detail ? `${label} did not confirm stop: ${detail}` : `${label} did not confirm stop`
  );
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
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();

  // Resolve every lane before any stop, map update, persisted-state clear, or
  // adapter launch. In particular, worktree-shape validation must not discover
  // an invalid side lane after the previous runtime has already been mutated.
  const primaryCwd = path.resolve(
    ports.getOpenCodeRuntimeLaunchCwd(input.request.cwd, input.lanePlan.primaryMembers)
  );
  const secondaryCwds = new Map(
    input.lanePlan.sideLanes.map((lane) => [
      lane.laneId,
      path.resolve(ports.getOpenCodeRuntimeLaunchCwd(input.request.cwd, [lane.member])),
    ])
  );

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
  if (ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart) {
    return ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
      teamName,
      input.sourceWarning,
      input.onProgress
    );
  }

  // This is intentionally the last read-only await before this launch claims
  // team ownership and begins destructive launch-state mutation.
  const previousLaunchState = await ports.readLaunchState(teamName);
  if (ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart) {
    return ports.recordCancelledOpenCodeRuntimeAdapterLaunch(
      teamName,
      input.sourceWarning,
      input.onProgress
    );
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
  ports.resetTeamScopedTransientStateForNewRun(teamName);
  let cancellationConsumed = false;
  let untrackedPrimaryLaunchMayBeRunning = false;
  const aggregateLaunchNoLongerCurrent = (): boolean => {
    cancellationConsumed ||= ports.consumeCancelledRuntimeAdapterRunId(runId);
    const runtimeOwner = ports.getRuntimeAdapterRun(teamName);
    const conflictingRuntimeOwner =
      runtimeOwner !== undefined &&
      (runtimeOwner.providerId !== 'opencode' || runtimeOwner.runId !== runId);
    return (
      cancellationConsumed ||
      run.cancelRequested ||
      run.processKilled ||
      ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart ||
      ports.getProvisioningRun(teamName) !== runId ||
      ports.getRun(runId) !== run ||
      conflictingRuntimeOwner
    );
  };
  const finishCancelledAggregateLaunch = async (): Promise<TeamLaunchResponse> => {
    run.cancelRequested = true;
    run.processKilled = true;
    const rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
      run,
      {
        adapter: input.adapter,
        previousLaunchState,
        primaryCwd,
        secondaryCwds,
        untrackedPrimaryLaunchMayBeRunning,
      },
      ports
    );
    if (rollbackComplete) {
      await ports
        .clearPersistedLaunchState(teamName, { expectedRunId: runId })
        .catch(() => undefined);
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
      if (ports.getRun(runId) === run) {
        ports.cleanupRun(run);
      }
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    return { runId };
  };

  await ports.clearPersistedLaunchState(teamName);
  if (aggregateLaunchNoLongerCurrent()) {
    return await finishCancelledAggregateLaunch();
  }
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
    untrackedPrimaryLaunchMayBeRunning = true;
    const primaryResult = await ports.launchOpenCodeAggregatePrimaryLane({
      run,
      adapter: input.adapter,
      prompt: input.prompt,
      previousLaunchState,
      assertStillCurrentAfterPersistence: () => {
        if (aggregateLaunchNoLongerCurrent()) {
          throw new Error(
            `OpenCode aggregate primary launch for team "${teamName}" was cancelled because the owning run is no longer active`
          );
        }
      },
    });
    untrackedPrimaryLaunchMayBeRunning = false;
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }
    if (primaryResult) {
      const primarySharedFailure =
        selectOpenCodeSharedRuntimePreflightFailureDiagnostic(primaryResult);
      if (primarySharedFailure) {
        run.mixedSecondarySharedRuntimeFailuresByProject.set(primaryCwd, primarySharedFailure);
      }
    }
    for (const lane of run.mixedSecondaryLanes) {
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      const laneCwd = secondaryCwds.get(lane.laneId)!;
      const sharedRuntimeFailure = run.mixedSecondarySharedRuntimeFailuresByProject.get(laneCwd);
      if (sharedRuntimeFailure) {
        markOpenCodeLaneBlockedBySharedRuntimeFailure({
          teamName,
          lane,
          rootCause: sharedRuntimeFailure,
          nowMs: ports.nowMs(),
          createRunId: () => ports.randomUUID(),
        });
        await ports.publishMixedSecondaryLaneStatusChange(run, lane);
        if (aggregateLaunchNoLongerCurrent()) {
          return await finishCancelledAggregateLaunch();
        }
        continue;
      }
      await ports.launchSingleMixedSecondaryLane(run, lane);
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      if (lane.result) {
        const laneSharedFailure = selectOpenCodeSharedRuntimePreflightFailureDiagnostic(
          lane.result
        );
        if (laneSharedFailure) {
          run.mixedSecondarySharedRuntimeFailuresByProject.set(laneCwd, laneSharedFailure);
        }
      }
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
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }

    const failed = launchState === 'partial_failure';
    const retainableResults = [
      primaryResult,
      ...run.mixedSecondaryLanes.map((lane) => lane.result),
    ].filter((result): result is TeamRuntimeLaunchResult => result !== null);
    const partialTeamCanContinue =
      failed && retainableResults.some((result) => hasRetainableOpenCodeRuntimeMember(result));
    const terminalFailure = failed && !partialTeamCanContinue;
    const laneDiagnostics = run.mixedSecondaryLanes.flatMap((lane) => lane.diagnostics);
    const terminalFailureError = selectOpenCodeLaunchFailureDiagnostic([
      ...retainableResults.flatMap((launchResult) => [
        ...Object.values(launchResult.members).flatMap((member) => [
          member.hardFailureReason,
          member.runtimeDiagnostic,
          ...member.diagnostics,
        ]),
        ...launchResult.diagnostics,
      ]),
      ...laneDiagnostics,
    ]);
    const finalProgress = ports.setRuntimeAdapterProgress(
      buildOpenCodeAggregateFinalProgress({
        launching,
        launchState,
        laneDiagnostics,
        updatedAt: ports.nowIso(),
        partialTeamCanContinue,
        terminalFailureError,
      }),
      input.onProgress
    );
    run.progress = finalProgress;
    let rollbackComplete = true;
    if (!terminalFailure) {
      ports.setAliveRunId(teamName, runId);
    } else {
      // A summarized terminal failure is non-throwing, but it owns the same
      // adapter-managed processes and rollback obligations as the catch path.
      // Stop all lanes before cleanupRun removes their tracking.
      rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
        run,
        {
          adapter: input.adapter,
          previousLaunchState,
          primaryCwd,
          secondaryCwds,
          untrackedPrimaryLaunchMayBeRunning,
        },
        ports
      );
      if (rollbackComplete) {
        run.progress = ports.setRuntimeAdapterProgress(finalProgress, input.onProgress);
      }
      if (rollbackComplete && aggregateLaunchNoLongerCurrent()) {
        if (ports.getRun(runId) === run) ports.cleanupRun(run);
        return { runId };
      }
      // Terminal failure: tear the run down fully. Removing it from the runs map
      // and clearing its timers/watchdogs/pending approvals (cleanupRun) is what a
      // clean-success run intentionally skips, but a failed one must not leak.
      if (rollbackComplete) {
        deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
        ports.cleanupRun(run);
      }
    }
    if (!terminalFailure || rollbackComplete) {
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    ports.emitTeamProcessChange({
      type: 'process',
      teamName,
      runId,
      detail: finalProgress.state,
    });
    return { runId };
  } catch (error) {
    if (aggregateLaunchNoLongerCurrent()) {
      return await finishCancelledAggregateLaunch();
    }
    // Genuine launch error after lanes came up: stop the owned primary OpenCode
    // adapter process (and any secondary lanes) BEFORE clearing their storage.
    // The adapter-managed process is not covered by run.child (null), so without
    // an explicit stop it is orphaned when the maps/storage below are cleared.
    const rollbackComplete = await stopAndRollbackOpenCodeAggregateRuntimeLanes(
      run,
      {
        adapter: input.adapter,
        previousLaunchState,
        primaryCwd,
        secondaryCwds,
        untrackedPrimaryLaunchMayBeRunning,
      },
      ports
    );
    if (rollbackComplete && aggregateLaunchNoLongerCurrent()) {
      if (ports.getRun(runId) === run) ports.cleanupRun(run);
      return { runId };
    }
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
    if (rollbackComplete) {
      deleteOpenCodeAggregateRuntimeTrackingIfOwned(teamName, runId, ports);
      ports.deleteProvisioningRunIfCurrent(teamName, runId);
    }
    // Genuine launch error: remove the run from the runs map and clear its
    // timers/watchdogs/pending approvals so a failed aggregate launch does not
    // leak a dead run (cleanupRun internally no-ops team-scoped work if a newer
    // run has since taken over).
    if (rollbackComplete) {
      ports.cleanupRun(run);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    throw error;
  }
}
