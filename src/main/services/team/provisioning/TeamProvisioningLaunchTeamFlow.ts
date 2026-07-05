import * as path from 'path';

import { mergeJsonSettingsArgs } from '../../runtime/cliSettingsArgs';
import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import { buildDesktopTeammateModeCliArgs } from '../runtimeTeammateMode';

import {
  buildDeterministicLaunchBootstrapSpec,
  type RuntimeBootstrapMemberMcpLaunchConfig,
  writeDeterministicBootstrapSpecFile,
  writeDeterministicBootstrapUserPromptFile,
} from './TeamProvisioningBootstrapSpec';
import { mergeProvisioningWarnings } from './TeamProvisioningLaunchCompatibility';
import {
  emitProvisioningCheckpoint,
  initializeProvisioningTrace,
  type TeamProvisioningCheckpointRun,
} from './TeamProvisioningProgressBuffers';
import { buildDeterministicLaunchHydrationPrompt } from './TeamProvisioningPromptBuilders';
import { type PromptSizeSummary } from './TeamProvisioningRuntimeDiagnostics';
import {
  getLaunchModelArg,
  type TeamRuntimeLaunchArgsPlan,
  type TeamsBaseLocation,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { LaunchExpectedMembersResolution } from './TeamProvisioningConfigLaunchNormalization';
import type {
  MemberSpawnStatusEntry,
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamTask,
} from '@shared/types';

export type LaunchRosterSource = LaunchExpectedMembersResolution['source'];

export interface ExistingLaunchRunLike {
  child?: unknown;
  processKilled?: boolean;
  cancelRequested?: boolean;
}

export interface DeterministicLaunchStatePreparationRun extends TeamProvisioningCheckpointRun {
  runId: string;
  teamName: string;
  launchStateClearedForRun: boolean;
  mixedSecondaryLanes?: readonly unknown[];
}

export interface TeamProvisioningLaunchBootstrapRun extends TeamProvisioningCheckpointRun {
  runId: string;
  progress: TeamProvisioningProgress;
  bootstrapSpecPath: string | null;
  bootstrapUserPromptPath: string | null;
  mcpConfigPath: string | null;
  requiresFirstRealTurnSuccess: boolean;
  cancelRequested: boolean;
  processKilled: boolean;
}

export interface TeamProvisioningLaunchMcpConfigBuilder {
  writeConfigFile(cwd: string, options: { controlApiBaseUrl?: string }): Promise<string>;
}

export interface MaterializeDeterministicLaunchBootstrapFilesInput<
  TRun extends TeamProvisioningLaunchBootstrapRun,
> {
  request: TeamLaunchRequest;
  run: TRun;
  effectiveMemberSpecs: TeamCreateRequest['members'];
  controlApiBaseUrl?: string;
  isValidationCancelled(): boolean;
}

export interface MaterializeDeterministicLaunchBootstrapFilesPorts<
  TRun extends TeamProvisioningLaunchBootstrapRun,
> {
  readTasks(teamName: string): Promise<TeamTask[]>;
  logTaskReadWarning(message: string): void;
  buildDeterministicLaunchHydrationPrompt: typeof buildDeterministicLaunchHydrationPrompt;
  getPromptSizeSummary(prompt: string): PromptSizeSummary;
  buildNativeAppManagedBootstrapSpecsWithDiagnostics: typeof buildNativeAppManagedBootstrapSpecsWithDiagnostics;
  buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    controlApiBaseUrl?: string | null;
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
  }): Promise<ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig>>;
  writeDeterministicBootstrapSpecFile: typeof writeDeterministicBootstrapSpecFile;
  writeDeterministicBootstrapUserPromptFile: typeof writeDeterministicBootstrapUserPromptFile;
  mcpConfigBuilder: TeamProvisioningLaunchMcpConfigBuilder;
  validateAgentTeamsMcpRuntime(
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
}

export interface MaterializeDeterministicLaunchBootstrapFilesResult {
  prompt: string;
  promptSize: PromptSizeSummary;
  mcpConfigPath: string;
  bootstrapSpecPath: string;
  bootstrapUserPromptPath: string | null;
}

export type ExistingLaunchRunReuseDecision =
  | { kind: 'continue' }
  | { kind: 'reuse'; runId: string }
  | { kind: 'blocked'; message: string };

export function parseLaunchConfigProjectPath(configRaw: string): string | null {
  try {
    const parsedConfig = JSON.parse(configRaw) as { projectPath?: unknown };
    return typeof parsedConfig.projectPath === 'string' &&
      parsedConfig.projectPath.trim().length > 0
      ? path.resolve(parsedConfig.projectPath.trim())
      : null;
  } catch {
    return null;
  }
}

export function resolveExistingLaunchRunReuse(input: {
  teamName: string;
  cwd: string;
  existingAliveRunId: string | null;
  existingRun: ExistingLaunchRunLike | null | undefined;
  existingRunCwd: string | null;
  configProjectPath: string | null;
}): ExistingLaunchRunReuseDecision {
  if (!input.existingAliveRunId) {
    return { kind: 'continue' };
  }

  const existingRun = input.existingRun;
  if (!existingRun?.child || existingRun.processKilled || existingRun.cancelRequested) {
    return { kind: 'continue' };
  }

  const requestedCwd = path.resolve(input.cwd);
  const existingRunCwd = input.existingRunCwd ?? input.configProjectPath;
  if (!existingRunCwd) {
    return {
      kind: 'blocked',
      message:
        `Team "${input.teamName}" is already running, but its cwd could not be determined. ` +
        'Stop it before launching again.',
    };
  }

  if (existingRunCwd !== requestedCwd) {
    return {
      kind: 'blocked',
      message:
        `Team "${input.teamName}" is already running in "${existingRunCwd}". ` +
        `Stop it before launching with cwd "${input.cwd}".`,
    };
  }

  return { kind: 'reuse', runId: input.existingAliveRunId };
}

export function getInitialLaunchValidationMessage(source: LaunchRosterSource): string {
  return source === 'members-meta'
    ? 'Validating team launch request (members from members.meta.json)'
    : source === 'inboxes'
      ? 'Validating team launch request (members from inboxes)'
      : 'Validating team launch request (fallback members from config.json)';
}

export function buildLaunchSyntheticRequest(input: {
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  configRaw: string;
}): TeamCreateRequest {
  const syntheticRequest: TeamCreateRequest = {
    teamName: input.request.teamName,
    members: input.members,
    cwd: input.request.cwd,
    providerId: input.request.providerId,
    providerBackendId: input.request.providerBackendId,
    model: input.request.model,
    effort: input.request.effort,
    fastMode: input.request.fastMode,
    skipPermissions: input.request.skipPermissions,
  };

  try {
    const cfg = JSON.parse(input.configRaw) as Record<string, unknown>;
    if (typeof cfg.color === 'string' && cfg.color.trim().length > 0) {
      syntheticRequest.color = cfg.color.trim();
    }
    if (typeof cfg.name === 'string' && cfg.name.trim().length > 0) {
      syntheticRequest.displayName = cfg.name.trim();
    }
  } catch {
    // The caller already validated config availability. Display metadata is optional.
  }

  return syntheticRequest;
}

export function createDeterministicLaunchProvisioningRun<
  TMixedSecondaryLane,
  TWorkspaceTrustPlan,
  TAnthropicApiKeyHelper,
>(input: {
  runId: string;
  teamName: string;
  startedAt: string;
  onProgress: (progress: TeamProvisioningProgress) => void;
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  syntheticRequest: TeamCreateRequest;
  expectedMembers: string[];
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  mixedSecondaryLanes: TMixedSecondaryLane[];
  workspaceTrustFullPlan: TWorkspaceTrustPlan | null;
  anthropicApiKeyHelper: TAnthropicApiKeyHelper | null;
  initialLaunchWarnings: string[];
  initialLaunchWarningSource: LaunchRosterSource;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
}) {
  const progress: TeamProvisioningProgress = {
    runId: input.runId,
    teamName: input.teamName,
    state: 'validating',
    message: getInitialLaunchValidationMessage(input.initialLaunchWarningSource),
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    warnings: input.initialLaunchWarnings.length > 0 ? input.initialLaunchWarnings : undefined,
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
    expectedMembers: input.expectedMembers,
    request: input.syntheticRequest,
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
    isLaunch: true,
    launchStateClearedForRun: false,
    deterministicBootstrap: true,
    workspaceTrustPlan: input.workspaceTrustFullPlan,
    workspaceTrustExecution: null,
    workspaceTrustDiagnostics: null,
    workspaceTrustRetryAttempted: false,
    fsPhase: 'waiting_members' as const,
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
      input.expectedMembers.map((name) => [name, input.createInitialMemberSpawnStatusEntry()])
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

export async function prepareDeterministicLaunchRunState<
  TLane,
  TRun extends DeterministicLaunchStatePreparationRun & {
    mixedSecondaryLanes?: readonly TLane[];
  },
>(input: {
  teamName: string;
  run: TRun;
  prepareWorkspaceTrustForDeterministicRun(): Promise<void>;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  registerRun(runId: string, run: TRun): void;
  setProvisioningRunByTeam(teamName: string, runId: string): void;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  publishMixedSecondaryLaneStatusChange(run: TRun, lane: TLane): Promise<void>;
}): Promise<void> {
  input.resetTeamScopedTransientStateForNewRun(input.teamName);
  input.registerRun(input.run.runId, input.run);
  input.setProvisioningRunByTeam(input.teamName, input.run.runId);
  initializeProvisioningTrace(input.run);
  input.run.onProgress(input.run.progress);
  await input.prepareWorkspaceTrustForDeterministicRun();
  emitProvisioningCheckpoint(input.run, 'Clearing persisted launch state');
  await input.clearPersistedLaunchState(input.teamName, { expectedRunId: input.run.runId });
  input.run.launchStateClearedForRun = true;
  emitProvisioningCheckpoint(input.run, 'Publishing mixed secondary lane status');
  for (const lane of input.run.mixedSecondaryLanes ?? []) {
    await input.publishMixedSecondaryLaneStatusChange(input.run, lane);
  }
}

export async function materializeDeterministicLaunchBootstrapFiles<
  TRun extends TeamProvisioningLaunchBootstrapRun,
>(
  input: MaterializeDeterministicLaunchBootstrapFilesInput<TRun>,
  ports: MaterializeDeterministicLaunchBootstrapFilesPorts<TRun>
): Promise<MaterializeDeterministicLaunchBootstrapFilesResult> {
  const { request, run, effectiveMemberSpecs } = input;

  emitProvisioningCheckpoint(run, 'Reading existing tasks for launch prompt');
  let existingTasks: TeamTask[] = [];
  try {
    existingTasks = await ports.readTasks(request.teamName);
  } catch (error) {
    ports.logTaskReadWarning(
      `[${request.teamName}] Failed to read tasks for launch prompt: ${String(error)}`
    );
  }

  const prompt = ports.buildDeterministicLaunchHydrationPrompt(
    request,
    effectiveMemberSpecs,
    existingTasks,
    false
  );
  const promptSize = ports.getPromptSizeSummary(prompt);

  emitProvisioningCheckpoint(
    run,
    'Building deterministic launch bootstrap spec',
    `expectedMembers=${effectiveMemberSpecs.length}`
  );
  const nativeBootstrapBuild = await ports.buildNativeAppManagedBootstrapSpecsWithDiagnostics({
    teamName: request.teamName,
    cwd: request.cwd,
    members: effectiveMemberSpecs,
  });
  const memberMcpLaunchConfigs = await ports.buildRuntimeBootstrapMemberMcpLaunchConfigs({
    controlApiBaseUrl: input.controlApiBaseUrl,
    cwd: request.cwd,
    members: effectiveMemberSpecs,
    run,
  });
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
  const bootstrapSpec = buildDeterministicLaunchBootstrapSpec(
    run.runId,
    request,
    effectiveMemberSpecs,
    nativeBootstrapBuild.specs,
    memberMcpLaunchConfigs
  );
  emitProvisioningCheckpoint(run, 'Writing deterministic bootstrap spec file');
  const bootstrapSpecPath = await ports.writeDeterministicBootstrapSpecFile(bootstrapSpec);
  run.bootstrapSpecPath = bootstrapSpecPath;
  emitProvisioningCheckpoint(
    run,
    'Writing launch hydration prompt file',
    `chars=${promptSize.chars} lines=${promptSize.lines}`
  );
  const bootstrapUserPromptPath =
    await ports.writeDeterministicBootstrapUserPromptFile(prompt);
  run.bootstrapUserPromptPath = bootstrapUserPromptPath;
  run.requiresFirstRealTurnSuccess = true;
  emitProvisioningCheckpoint(run, 'Writing MCP config file');
  const mcpConfigPath = await ports.mcpConfigBuilder.writeConfigFile(request.cwd, {
    controlApiBaseUrl: input.controlApiBaseUrl,
  });
  run.mcpConfigPath = mcpConfigPath;
  emitProvisioningCheckpoint(run, 'Validating agent-teams MCP runtime');
  await ports.validateAgentTeamsMcpRuntime(mcpConfigPath, {
    isCancelled: input.isValidationCancelled,
  });

  return {
    prompt,
    promptSize,
    mcpConfigPath,
    bootstrapSpecPath,
    bootstrapUserPromptPath,
  };
}

export function buildDeterministicLaunchProcessArgs(input: {
  mcpConfigPath: string;
  bootstrapSpecPath: string;
  bootstrapUserPromptPath: string | null;
  skipPermissions?: boolean;
  worktree?: string;
  providerId: TeamProviderId;
  model?: string;
  launchIdentity: ProviderModelLaunchIdentity | null;
  runtimeArgsPlan: TeamRuntimeLaunchArgsPlan;
  teammateModeDecision: { injectedTeammateMode: 'tmux' | null };
  disallowedTools: string;
}): string[] {
  const launchArgs = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'user,project,local',
    '--mcp-config',
    input.mcpConfigPath,
    '--team-bootstrap-spec',
    input.bootstrapSpecPath,
    ...(input.bootstrapUserPromptPath
      ? ['--team-bootstrap-user-prompt-file', input.bootstrapUserPromptPath]
      : []),
    '--disallowedTools',
    input.disallowedTools,
    ...(input.skipPermissions !== false
      ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
      : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
  ];
  const launchModelArg = getLaunchModelArg(input.providerId, input.model, input.launchIdentity);
  if (launchModelArg) {
    launchArgs.push('--model', launchModelArg);
  }
  if (input.launchIdentity?.resolvedEffort) {
    launchArgs.push('--effort', input.launchIdentity.resolvedEffort);
  }
  launchArgs.push(...input.runtimeArgsPlan.providerArgs);
  launchArgs.push(...input.runtimeArgsPlan.fastModeArgs);
  launchArgs.push(...input.runtimeArgsPlan.runtimeTurnSettledHookArgs);
  if (input.worktree) {
    launchArgs.push('--worktree', input.worktree);
  }
  launchArgs.push(...buildDesktopTeammateModeCliArgs(input.teammateModeDecision));
  launchArgs.push(...input.runtimeArgsPlan.extraArgs);
  launchArgs.push(...input.runtimeArgsPlan.settingsArgs);
  launchArgs.push(...input.runtimeArgsPlan.inheritedProviderArgs);
  return mergeJsonSettingsArgs(launchArgs);
}
