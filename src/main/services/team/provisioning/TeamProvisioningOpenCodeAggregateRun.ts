import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';

import { getTeamsBasePathsToProbe } from './TeamProvisioningRuntimeLaunchSelection';
import { createMixedSecondaryLaneStates } from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
} from '@shared/types';

export interface CreateOpenCodeAggregateProvisioningRunParams {
  runId: string;
  startedAt: string;
  progress: TeamProvisioningProgress;
  request: TeamCreateRequest | TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_worktree_root_lanes' }>;
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
    expectedMembers: params.members.map((member) => member.name),
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
