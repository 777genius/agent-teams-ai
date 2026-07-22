import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { mergeJsonSettingsArgs } from '../../runtime/cliSettingsArgs';
import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import { buildDesktopTeammateModeCliArgs } from '../runtimeTeammateMode';

import {
  buildDeterministicCreateBootstrapSpec,
  type RuntimeBootstrapMemberMcpLaunchConfig,
  writeDeterministicBootstrapSpecFile,
  writeDeterministicBootstrapUserPromptFile,
} from './TeamProvisioningBootstrapSpec';
import { buildMembersMetaWritePayload } from './TeamProvisioningConfigLaunchNormalization';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  mergeProvisioningWarnings,
} from './TeamProvisioningLaunchCompatibility';
import {
  emitProvisioningCheckpoint,
  type TeamProvisioningCheckpointRun,
} from './TeamProvisioningProgressBuffers';
import { getPromptSizeSummary, type PromptSizeSummary } from './TeamProvisioningRuntimeDiagnostics';

import type {
  TeamRuntimeLaunchArgsPlan,
  TeamsBaseLocation,
} from './TeamProvisioningRuntimeLaunchSelection';
import type {
  MemberSpawnStatusEntry,
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

export interface TeamProvisioningCreateTeamProbe {
  location: TeamsBaseLocation;
  basePath: string;
}

export interface TeamProvisioningCreateBootstrapRun extends TeamProvisioningCheckpointRun {
  runId: string;
  progress: TeamProvisioningProgress;
  bootstrapSpecPath: string | null;
  bootstrapUserPromptPath: string | null;
  mcpConfigPath: string | null;
  requiresFirstRealTurnSuccess: boolean;
}

export interface TeamProvisioningCreateTeamMetaStore {
  writeMeta(
    teamName: string,
    payload: ReturnType<typeof buildCreateTeamMetaPayload>
  ): Promise<void>;
}

export interface TeamProvisioningCreateMembersMetaStore {
  writeMembers(
    teamName: string,
    members: ReturnType<typeof buildMembersMetaWritePayload>,
    options?: { providerBackendId?: TeamCreateRequest['providerBackendId'] }
  ): Promise<void>;
}

export interface TeamProvisioningCreateMcpConfigBuilder {
  writeConfigFile(cwd: string, options: { controlApiBaseUrl?: string }): Promise<string>;
}

export interface MaterializeDeterministicCreateTeamBootstrapFilesInput {
  request: TeamCreateRequest;
  run: TeamProvisioningCreateBootstrapRun;
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  initialUserPrompt: string;
  promptSize?: PromptSizeSummary;
  controlApiBaseUrl?: string;
  teamMetaStore: TeamProvisioningCreateTeamMetaStore;
  membersMetaStore: TeamProvisioningCreateMembersMetaStore;
  mcpConfigBuilder: TeamProvisioningCreateMcpConfigBuilder;
  buildMemberMcpLaunchConfigs(): Promise<
    ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig>
  >;
  validateAgentTeamsMcpRuntime(mcpConfigPath: string): Promise<void>;
}

export interface MaterializeDeterministicCreateTeamBootstrapFilesResult {
  teamDir: string;
  tasksDir: string;
  mcpConfigPath: string;
  bootstrapSpecPath: string;
  bootstrapUserPromptPath: string | null;
}

export async function assertCreateTeamDoesNotExist(
  teamName: string,
  probes: readonly TeamProvisioningCreateTeamProbe[],
  pathExists: (filePath: string) => Promise<boolean>
): Promise<void> {
  for (const probe of probes) {
    const configPath = path.join(probe.basePath, teamName, 'config.json');
    if (await pathExists(configPath)) {
      const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
      throw new Error(`Team already exists${suffix}`);
    }
  }
}

export function buildCreateTeamMetaPayload(
  request: TeamCreateRequest,
  launchIdentity: ProviderModelLaunchIdentity | null,
  createdAt: number = Date.now()
): {
  displayName: TeamCreateRequest['displayName'];
  description: TeamCreateRequest['description'];
  color: TeamCreateRequest['color'];
  cwd: string;
  prompt: TeamCreateRequest['prompt'];
  providerId: TeamCreateRequest['providerId'];
  providerBackendId: TeamCreateRequest['providerBackendId'];
  model: TeamCreateRequest['model'];
  effort: TeamCreateRequest['effort'];
  fastMode: TeamCreateRequest['fastMode'];
  skipPermissions: TeamCreateRequest['skipPermissions'];
  worktree: TeamCreateRequest['worktree'];
  extraCliArgs: TeamCreateRequest['extraCliArgs'];
  limitContext: TeamCreateRequest['limitContext'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  createdAt: number;
} {
  return {
    displayName: request.displayName,
    description: request.description,
    color: request.color,
    cwd: request.cwd,
    prompt: request.prompt,
    providerId: request.providerId,
    providerBackendId: request.providerBackendId,
    model: request.model,
    effort: request.effort,
    fastMode: request.fastMode,
    skipPermissions: request.skipPermissions,
    worktree: request.worktree,
    extraCliArgs: request.extraCliArgs,
    limitContext: request.limitContext,
    launchIdentity,
    createdAt,
  };
}

export function createDeterministicCreateProvisioningRun<
  TMixedSecondaryLane,
  TWorkspaceTrustPlan,
  TAnthropicApiKeyHelper,
>(input: {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  startedAt: string;
  onProgress: (progress: TeamProvisioningProgress) => void;
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  mixedSecondaryLanes: TMixedSecondaryLane[];
  workspaceTrustFullPlan: TWorkspaceTrustPlan | null;
  largeTeamWarning?: string | null;
  anthropicApiKeyHelper: TAnthropicApiKeyHelper | null;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
}) {
  const progress: TeamProvisioningProgress = {
    runId: input.runId,
    teamName: input.teamName,
    state: 'validating',
    message: 'Validating team provisioning request',
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    warnings: input.largeTeamWarning ? [input.largeTeamWarning] : undefined,
    cliLogsTail: undefined,
  };

  return {
    runId: input.runId,
    teamName: input.teamName,
    startedAt: input.startedAt,
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    lastClaudeLogStream: null,
    stdoutLogLineBuf: '',
    stderrLogLineBuf: '',
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    claudeLogsUpdatedAt: undefined,
    deterministicBootstrapStartedAt: undefined,
    lastDeterministicBootstrapEvent: undefined,
    lastDeterministicBootstrapPhase: undefined,
    deterministicBootstrapMemberSpawnSeen: false,
    deterministicBootstrapMemberResultSeen: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    teamsBasePathsToProbe: input.teamsBasePathsToProbe,
    child: null,
    timeoutHandle: null,
    fsMonitorHandle: null,
    onProgress: input.onProgress,
    expectedMembers: input.effectiveMemberSpecs.map((member) => member.name),
    request: input.request,
    allEffectiveMembers: input.allEffectiveMemberSpecs,
    effectiveMembers: input.effectiveMemberSpecs,
    launchIdentity: input.launchIdentity,
    mixedSecondaryLanes: input.mixedSecondaryLanes,
    lastLogProgressAt: 0,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    stallCheckHandle: null,
    stallWarningIndex: null,
    preStallMessage: null,
    lastRetryAt: 0,
    apiRetryWarningIndex: null,
    apiErrorWarningEmitted: false,
    waitingTasksSince: null,
    provisioningComplete: false,
    processClosed: false,
    requiresFirstRealTurnSuccess: false,
    firstRealTurnSucceeded: false,
    mcpConfigPath: null,
    memberMcpConfigPaths: [],
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    isLaunch: false,
    launchStateClearedForRun: false,
    deterministicBootstrap: true,
    workspaceTrustPlan: input.workspaceTrustFullPlan,
    workspaceTrustExecution: null,
    workspaceTrustDiagnostics: null,
    workspaceTrustRetryAttempted: false,
    fsPhase: 'waiting_config' as const,
    leadRelayCapture: null,
    activeCrossTeamReplyHints: [],
    leadMsgSeq: 0,
    liveLeadTextBuffer: null,
    pendingToolCalls: [],
    activeToolCalls: new Map<string, never>(),
    pendingDirectCrossTeamSendRefresh: false,
    lastLeadTextEmitMs: 0,
    silentUserDmForward: null,
    silentUserDmForwardClearHandle: null,
    pendingInboxRelayCandidates: [],
    provisioningOutputParts: [],
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    detectedSessionId: null,
    leadActivityState: 'active' as const,
    leadContextUsage: null,
    authFailureRetried: false,
    authRetryInProgress: false,
    spawnContext: null,
    anthropicApiKeyHelper: input.anthropicApiKeyHelper,
    anthropicApiKeyHelperCleanupPromise: null,
    pendingApprovals: new Map<string, never>(),
    processedPermissionRequestIds: new Set<string>(),
    pendingPostCompactReminder: false,
    postCompactReminderInFlight: false,
    suppressPostCompactReminderOutput: false,
    pendingGeminiPostLaunchHydration: false,
    geminiPostLaunchHydrationInFlight: false,
    geminiPostLaunchHydrationSent: false,
    suppressGeminiPostLaunchHydrationOutput: false,
    memberSpawnStatuses: new Map(
      input.effectiveMemberSpecs.map((member) => [
        member.name,
        input.createInitialMemberSpawnStatusEntry(),
      ])
    ),
    memberSpawnToolUseIds: new Map<string, string>(),
    pendingMemberRestarts: new Map<string, never>(),
    memberSpawnLeadInboxCursorByMember: new Map<string, never>(),
    lastDeterministicBootstrapSeq: 0,
    lastMemberSpawnAuditAt: 0,
    lastMemberSpawnAuditConfigReadWarningAt: 0,
    lastMemberSpawnAuditMissingWarningAt: new Map<string, number>(),
    progress,
  };
}

export async function materializeDeterministicCreateTeamBootstrapFiles({
  request,
  run,
  effectiveMemberSpecs,
  allEffectiveMemberSpecs,
  launchIdentity,
  initialUserPrompt,
  promptSize = getPromptSizeSummary(initialUserPrompt),
  controlApiBaseUrl,
  teamMetaStore,
  membersMetaStore,
  mcpConfigBuilder,
  buildMemberMcpLaunchConfigs,
  validateAgentTeamsMcpRuntime,
}: MaterializeDeterministicCreateTeamBootstrapFilesInput): Promise<MaterializeDeterministicCreateTeamBootstrapFilesResult> {
  assertDeterministicBootstrapPrimaryMemberLimit(effectiveMemberSpecs.length);

  emitProvisioningCheckpoint(run, 'Persisting team metadata before spawn');
  const teamDir = path.join(getTeamsBasePath(), request.teamName);
  const tasksDir = path.join(getTasksBasePath(), request.teamName);
  await fs.promises.mkdir(teamDir, { recursive: true });
  await fs.promises.mkdir(tasksDir, { recursive: true });
  await teamMetaStore.writeMeta(
    request.teamName,
    buildCreateTeamMetaPayload(request, launchIdentity)
  );
  await membersMetaStore.writeMembers(
    request.teamName,
    buildMembersMetaWritePayload(allEffectiveMemberSpecs),
    {
      providerBackendId: request.providerBackendId,
    }
  );

  emitProvisioningCheckpoint(
    run,
    'Building deterministic create bootstrap spec',
    `expectedMembers=${effectiveMemberSpecs.length}`
  );
  const nativeBootstrapBuild = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
    teamName: request.teamName,
    cwd: request.cwd,
    members: effectiveMemberSpecs,
  });
  const memberMcpLaunchConfigs = await buildMemberMcpLaunchConfigs();
  if (nativeBootstrapBuild.diagnostics.warning) {
    run.progress = {
      ...run.progress,
      warnings: mergeProvisioningWarnings(
        run.progress.warnings,
        nativeBootstrapBuild.diagnostics.warning
      ),
    };
    emitProvisioningCheckpoint(
      run,
      'Native bootstrap startup context is large',
      nativeBootstrapBuild.diagnostics.warning
    );
  }

  const bootstrapSpec = buildDeterministicCreateBootstrapSpec(
    run.runId,
    request,
    effectiveMemberSpecs,
    nativeBootstrapBuild.specs,
    memberMcpLaunchConfigs
  );
  emitProvisioningCheckpoint(run, 'Writing deterministic bootstrap spec file');
  const bootstrapSpecPath = await writeDeterministicBootstrapSpecFile(bootstrapSpec);
  run.bootstrapSpecPath = bootstrapSpecPath;

  let bootstrapUserPromptPath: string | null = null;
  if (initialUserPrompt) {
    emitProvisioningCheckpoint(
      run,
      'Writing deferred user prompt file',
      `chars=${promptSize.chars} lines=${promptSize.lines}`
    );
    bootstrapUserPromptPath = await writeDeterministicBootstrapUserPromptFile(initialUserPrompt);
    run.bootstrapUserPromptPath = bootstrapUserPromptPath;
    run.requiresFirstRealTurnSuccess = true;
  }

  emitProvisioningCheckpoint(run, 'Writing MCP config file');
  const mcpConfigPath = await mcpConfigBuilder.writeConfigFile(request.cwd, {
    controlApiBaseUrl,
  });
  run.mcpConfigPath = mcpConfigPath;

  emitProvisioningCheckpoint(run, 'Validating agent-teams MCP runtime');
  await validateAgentTeamsMcpRuntime(mcpConfigPath);

  return {
    teamDir,
    tasksDir,
    mcpConfigPath,
    bootstrapSpecPath,
    bootstrapUserPromptPath,
  };
}

export interface BuildDeterministicCreateSpawnArgsInput {
  mcpConfigPath: string;
  bootstrapSpecPath: string;
  bootstrapUserPromptPath?: string | null;
  skipPermissions?: boolean;
  launchModelArg?: string;
  resolvedEffort?: string;
  providerArgs: TeamRuntimeLaunchArgsPlan['providerArgs'];
  fastModeArgs: TeamRuntimeLaunchArgsPlan['fastModeArgs'];
  runtimeTurnSettledHookArgs: TeamRuntimeLaunchArgsPlan['runtimeTurnSettledHookArgs'];
  runtimeExtraArgs: TeamRuntimeLaunchArgsPlan['extraArgs'];
  settingsArgs: TeamRuntimeLaunchArgsPlan['settingsArgs'];
  inheritedProviderArgs: TeamRuntimeLaunchArgsPlan['inheritedProviderArgs'];
  worktree?: string;
  teammateModeDecision: Parameters<typeof buildDesktopTeammateModeCliArgs>[0];
  disallowedTools: string;
}

export function buildDeterministicCreateSpawnArgs({
  mcpConfigPath,
  bootstrapSpecPath,
  bootstrapUserPromptPath,
  skipPermissions,
  launchModelArg,
  resolvedEffort,
  providerArgs,
  fastModeArgs,
  runtimeTurnSettledHookArgs,
  runtimeExtraArgs,
  settingsArgs,
  inheritedProviderArgs,
  worktree,
  teammateModeDecision,
  disallowedTools,
}: BuildDeterministicCreateSpawnArgsInput): string[] {
  return mergeJsonSettingsArgs([
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'user,project,local',
    '--mcp-config',
    mcpConfigPath,
    '--team-bootstrap-spec',
    bootstrapSpecPath,
    ...(bootstrapUserPromptPath
      ? ['--team-bootstrap-user-prompt-file', bootstrapUserPromptPath]
      : []),
    '--disallowedTools',
    disallowedTools,
    ...(skipPermissions !== false
      ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
      : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
    ...(launchModelArg ? ['--model', launchModelArg] : []),
    ...(resolvedEffort ? ['--effort', resolvedEffort] : []),
    ...providerArgs,
    ...fastModeArgs,
    ...runtimeTurnSettledHookArgs,
    ...(worktree ? ['--worktree', worktree] : []),
    ...buildDesktopTeammateModeCliArgs(teammateModeDecision),
    ...runtimeExtraArgs,
    ...settingsArgs,
    ...inheritedProviderArgs,
  ]);
}
