import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';

import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { getTeamsBasePathsToProbe } from './TeamProvisioningRuntimeLaunchSelection';
import {
  createMixedSecondaryLaneStates,
  type MixedSecondaryRuntimeLaneState,
  type SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
} from '../runtime';
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
