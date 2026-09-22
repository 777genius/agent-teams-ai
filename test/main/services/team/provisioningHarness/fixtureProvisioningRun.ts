import { HARNESS_DEFAULT_NOW_ISO, HARNESS_DEFAULT_TEAM_NAME } from './fixtureConstants';
import { makeTeamCreateRequest, normalizeTeamCreateRequestFixture } from './fixtureMembers';
import { assertNoSecretLikeFixtureValues } from './fixtureSecrets';
import { cloneFixture } from './harnessData';

import type { ProvisioningRun } from '@main/services/team/provisioning/TeamProvisioningRunModel';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

export interface ProvisioningRunFixtureOptions {
  runId?: string;
  teamName?: string;
  startedAt?: string;
  request?: TeamCreateRequest;
  progress?: Partial<TeamProvisioningProgress>;
  expectedMembers?: readonly string[];
  effectiveMembers?: TeamCreateRequest['members'];
  overrides?: Partial<ProvisioningRun>;
}

function makeProvisioningProgress(
  runId: string,
  teamName: string,
  startedAt: string,
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return cloneFixture({
    runId,
    teamName,
    state: 'configuring',
    message: 'Harness provisioning run',
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  });
}

export function makeProvisioningRun(options: ProvisioningRunFixtureOptions = {}): ProvisioningRun {
  const runId = options.runId ?? 'harness-run-id';
  const teamName = options.teamName ?? options.request?.teamName ?? HARNESS_DEFAULT_TEAM_NAME;
  const startedAt = options.startedAt ?? HARNESS_DEFAULT_NOW_ISO;
  const request = normalizeTeamCreateRequestFixture(
    cloneFixture(options.request ?? makeTeamCreateRequest({ teamName }))
  );
  const allEffectiveMembers = normalizeTeamCreateRequestFixture({
    ...request,
    members: cloneFixture(options.effectiveMembers ?? request.members),
  }).members;
  const effectiveMembers = cloneFixture(allEffectiveMembers);
  const expectedMembers =
    options.expectedMembers ?? effectiveMembers.map((memberValue) => memberValue.name);
  const progress = makeProvisioningProgress(runId, teamName, startedAt, options.progress);
  const run = {
    runId,
    teamName,
    startedAt,
    progress,
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
    teamsBasePathsToProbe: [],
    child: null,
    timeoutHandle: null,
    fsMonitorHandle: null,
    onProgress: () => undefined,
    expectedMembers: [...expectedMembers],
    request,
    allEffectiveMembers,
    effectiveMembers,
    launchIdentity: null,
    mixedSecondaryLanes: [],
    lastLogProgressAt: 0,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    stallCheckHandle: null,
    stallWarningIndex: null,
    preStallMessage: null,
    lastRetryAt: 0,
    apiRetryWarningIndex: null,
    apiErrorWarningEmitted: false,
    fsPhase: 'waiting_config',
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
    deterministicBootstrap: true,
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
    leadActivityState: 'idle',
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
    ...cloneFixture(options.overrides ?? {}),
  } as ProvisioningRun;

  run.request = normalizeTeamCreateRequestFixture({
    ...run.request,
    teamName: run.teamName,
  });
  run.allEffectiveMembers = normalizeTeamCreateRequestFixture({
    ...run.request,
    members: run.allEffectiveMembers,
  }).members;
  run.effectiveMembers = normalizeTeamCreateRequestFixture({
    ...run.request,
    members: run.effectiveMembers,
  }).members;
  const effectiveMemberNames = new Set(run.effectiveMembers.map((memberValue) => memberValue.name));
  run.expectedMembers = Array.from(
    new Set(
      run.expectedMembers
        .map((memberName) => memberName.trim())
        .filter((memberName) => effectiveMemberNames.has(memberName))
    )
  );
  assertNoSecretLikeFixtureValues({
    runId: run.runId,
    teamName: run.teamName,
    startedAt: run.startedAt,
    progress: run.progress,
    request: run.request,
    expectedMembers: run.expectedMembers,
  });
  return run;
}
