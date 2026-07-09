import {
  listTmuxPaneRuntimeInfoForCurrentPlatform,
  sendKeysToTmuxPaneForCurrentPlatform,
} from '@features/tmux-installer/main';
import { spawnCli } from '@main/utils/childProcess';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import {
  buildTeamMemberMcpSettingSources,
  normalizeTeamMemberMcpPolicy,
  requiresStrictTeamMemberMcpConfig,
} from '@shared/utils/teamMemberMcpPolicy';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { mergeJsonSettingsArgs } from '../../runtime/cliSettingsArgs';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import { atomicWriteAsync } from '../atomicWrite';
import { buildNativeAppManagedBootstrapSpecs } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';
import { getConfiguredCliFlavor } from '../cliFlavor';
import { sanitizeProcessRuntimeEventFilePrefix } from '../ProcessBootstrapTransportEvidence';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import {
  createAppendDirectProcessRuntimeEventUseCase,
  type DirectProcessRuntimeEventInput,
} from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import {
  createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase,
  type OpenCodeSecondaryRetryCandidate,
} from './TeamProvisioningCollectFailedOpenCodeSecondaryRetryCandidatesUseCase';
import {
  buildDirectTmuxRestartCommand,
  isInteractiveShellCommand,
} from './TeamProvisioningDirectRestart';
import {
  matchesExactTeamMemberName,
  matchesMemberNameOrBase,
  matchesObservedMemberNameForExpected,
  matchesTeamMemberIdentity,
} from './TeamProvisioningMemberIdentity';
import { isMemberLifecycleOperationInProgressError } from './TeamProvisioningMemberLifecycleKeys';
import { type MemberLifecycleOperationKind } from './TeamProvisioningMemberLifecycleOperationRunner';
import { parseOptionalIsoMs } from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  createPersistOpenCodeMemberRestartSystemMessageUseCase,
  type OpenCodeMemberRestartSystemMessageInput,
} from './TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';
import {
  hasOpenCodeRuntimeEntryHandle,
  hasOpenCodeRuntimeHandle,
  hasOpenCodeRuntimeLivenessMarker,
  MEMBER_BOOTSTRAP_STALL_MS,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase,
  type PreparePrimaryOwnedMemberRestartRuntimeInput,
  type PreparePrimaryOwnedMemberRestartRuntimeResult,
} from './TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import {
  buildMemberSpawnPrompt,
  buildRestartMemberSpawnMessage,
} from './TeamProvisioningPromptBuilders';
import {
  createReadOpenCodeSecondaryRetryOutcomeUseCase,
  type OpenCodeSecondaryRetryOutcome,
} from './TeamProvisioningReadOpenCodeSecondaryRetryOutcomeUseCase';
import { createNodeResolveDirectRestartRuntimeCwdUseCase } from './TeamProvisioningResolveDirectRestartRuntimeCwdUseCase';
import {
  createNodeStopPrimaryOwnedRosterRuntimeUseCase,
  type StopPrimaryOwnedRosterRuntimeInput,
} from './TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import {
  createNodeUpdateDirectTmuxRestartMemberConfigUseCase,
  type DirectTmuxRestartMemberConfigInput,
} from './TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';

import type { NativeAppManagedBootstrapSpec } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type { RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type {
  DirectRestartPromptInput,
  ProvisioningEnvResolution,
  TeamProvisioningMemberLifecycleHost,
  TeamRuntimeLaunchArgsPlan,
} from './TeamProvisioningMemberLifecycleHostPorts';
import type { TeamProvisioningMemberLifecycleOperationUseCases } from './TeamProvisioningMemberLifecycleOperationUseCases';
import type {
  DirectProcessMemberLaunchReason,
  DirectProcessMemberRestartInput,
  EffectiveConfiguredMember,
  LiveRosterAttachReason,
  PersistedRuntimeMemberLike,
  ProvisioningRun,
  ReattachOpenCodeOwnedMemberLaneOptions,
} from './TeamProvisioningMemberLifecycleTypes';
import type {
  TeamProvisioningMemberLifecycleActionUseCaseSeams,
  TeamProvisioningMemberLifecycleControllerUseCaseSeams,
  TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams,
  TeamProvisioningMemberLifecycleRestartUseCaseSeams,
} from './TeamProvisioningMemberLifecycleUseCaseSeams';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeEntry,
  TeamConfig,
  TeamCreateRequest,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV = 'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH';
const TEAMMATE_RUNTIME_ENV = 'CLAUDE_CODE_TEAMMATE_RUNTIME';
const TEAMMATE_RUNTIME_EVENTS_ENV = 'CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH';
const TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV = 'CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN';
const NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV =
  'CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH';
const APP_TEAM_RUNTIME_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop';

function nowIso(): string {
  return new Date().toISOString();
}

function getTeamRuntimeEventsDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, 'runtime');
}

function buildMissingCliError(): Error {
  if (getConfiguredCliFlavor() === 'agent_teams_orchestrator') {
    return new Error(
      'Multimodel runtime not found. The packaged app must include resources/runtime/claude-multimodel, or development must provide CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
    );
  }
  return new Error('Claude CLI not found; install it or provide a valid path');
}

function applyAppManagedRuntimeSettingsPathEnv(
  env: NodeJS.ProcessEnv,
  settingsPath: string | null
): void {
  if (settingsPath) {
    env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV] = settingsPath;
  } else {
    delete env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV];
  }
}

async function ensureCwdExists(cwd: string): Promise<void> {
  const stat = await fs.promises.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Project path is not available for teammate restart: ${cwd}`);
  }
}

export type { OpenCodeSecondaryRetryCandidate } from './TeamProvisioningCollectFailedOpenCodeSecondaryRetryCandidatesUseCase';
export type {
  MemberLifecycleOperation,
  MemberLifecycleOperationKind,
} from './TeamProvisioningMemberLifecycleOperationRunner';
export type {
  DirectProcessMemberLaunchReason,
  DirectProcessMemberRestartInput,
  EffectiveConfiguredMember,
  LiveRosterAttachReason,
  PersistedRuntimeMemberLike,
  ProvisioningRun,
  ReattachOpenCodeOwnedMemberLaneOptions,
} from './TeamProvisioningMemberLifecycleTypes';
export type { OpenCodeSecondaryRetryOutcome } from './TeamProvisioningReadOpenCodeSecondaryRetryOutcomeUseCase';

export class TeamProvisioningMemberLifecycleController {
  private readonly actionUseCases: TeamProvisioningMemberLifecycleActionUseCaseSeams;
  private readonly restartUseCases: TeamProvisioningMemberLifecycleRestartUseCaseSeams;
  private readonly openCodeRetryUseCases: TeamProvisioningMemberLifecycleOpenCodeRetryUseCaseSeams;

  private readonly persistOpenCodeMemberRestartSystemMessageFallback =
    createPersistOpenCodeMemberRestartSystemMessageUseCase({
      persistSentMessage: (teamName, message) => this.persistSentMessage(teamName, message),
      nowIso,
      randomUUID,
    });
  private readonly appendDirectProcessRuntimeEventFallback =
    createAppendDirectProcessRuntimeEventUseCase();
  private readonly updateDirectTmuxRestartMemberConfigFallback =
    createNodeUpdateDirectTmuxRestartMemberConfigUseCase();
  private readonly stopPrimaryOwnedRosterRuntimeFallback =
    createNodeStopPrimaryOwnedRosterRuntimeUseCase();
  private readonly preparePrimaryOwnedMemberRestartRuntimeFallback =
    createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase();
  private readonly resolveDirectRestartRuntimeCwdFallback =
    createNodeResolveDirectRestartRuntimeCwdUseCase();
  private readonly readOpenCodeSecondaryRetryOutcomeFallback =
    createReadOpenCodeSecondaryRetryOutcomeUseCase({
      readLaunchStateSnapshot: (teamName) => this.launchStateStore.read(teamName),
    });
  private readonly collectFailedOpenCodeSecondaryRetryCandidatesFallback =
    createCollectFailedOpenCodeSecondaryRetryCandidatesUseCase({
      hasOpenCodeRuntimeAdapter: () => Boolean(this.getOpenCodeRuntimeAdapter()),
      readConfigForStrictDecision: (teamName) => this.readConfigForStrictDecision(teamName),
      readMetaMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      readLaunchStateSnapshot: (teamName) => this.launchStateStore.read(teamName),
      resolveEffectiveConfiguredMember: (configMembers, metaMembers, memberName) =>
        this.resolveEffectiveConfiguredMember(configMembers, metaMembers, memberName),
    });

  constructor(
    private readonly host: TeamProvisioningMemberLifecycleHost,
    private readonly operationUseCases: TeamProvisioningMemberLifecycleOperationUseCases,
    useCases: TeamProvisioningMemberLifecycleControllerUseCaseSeams = {}
  ) {
    this.actionUseCases = useCases.actions ?? {};
    this.restartUseCases = useCases.restart ?? {};
    this.openCodeRetryUseCases = useCases.openCodeRetry ?? {};
  }

  private get runs(): TeamProvisioningMemberLifecycleHost['runs'] {
    return this.host.runs;
  }

  private get runtimeAdapterRunByTeam(): TeamProvisioningMemberLifecycleHost['runtimeAdapterRunByTeam'] {
    return this.host.runtimeAdapterRunByTeam;
  }

  private get failedOpenCodeSecondaryRetryInFlightByTeam(): TeamProvisioningMemberLifecycleHost['failedOpenCodeSecondaryRetryInFlightByTeam'] {
    return this.host.failedOpenCodeSecondaryRetryInFlightByTeam;
  }

  private get mcpConfigBuilder(): TeamProvisioningMemberLifecycleHost['mcpConfigBuilder'] {
    return this.host.mcpConfigBuilder;
  }

  private get membersMetaStore(): TeamProvisioningMemberLifecycleHost['membersMetaStore'] {
    return this.host.membersMetaStore;
  }

  private get teamMetaStore(): TeamProvisioningMemberLifecycleHost['teamMetaStore'] {
    return this.host.teamMetaStore;
  }

  private get launchStateStore(): TeamProvisioningMemberLifecycleHost['launchStateStore'] {
    return this.host.launchStateStore;
  }

  private getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    return this.host.getRunTrackedCwd(run);
  }

  private buildPrimaryOwnedMemberSpecForRuntime(input: {
    configuredMember: EffectiveConfiguredMember;
    run: ProvisioningRun;
  }): TeamCreateRequest['members'][number] {
    return this.host.buildPrimaryOwnedMemberSpecForRuntime(input);
  }

  private buildProvisioningEnv(
    providerId: TeamProviderId,
    providerBackendId: TeamProviderBackendId | undefined,
    options: Parameters<TeamProvisioningMemberLifecycleHost['buildProvisioningEnv']>[2]
  ): Promise<ProvisioningEnvResolution> {
    return this.host.buildProvisioningEnv(providerId, providerBackendId, options);
  }

  private materializeEffectiveTeamMemberSpecs(
    input: Parameters<TeamProvisioningMemberLifecycleHost['materializeEffectiveTeamMemberSpecs']>[0]
  ): Promise<TeamCreateRequest['members']> {
    return this.host.materializeEffectiveTeamMemberSpecs(input);
  }

  private resolveDirectMemberLaunchIdentity(
    input: Parameters<TeamProvisioningMemberLifecycleHost['resolveDirectMemberLaunchIdentity']>[0]
  ): Promise<ProviderModelLaunchIdentity | null> {
    return this.host.resolveDirectMemberLaunchIdentity(input);
  }

  private buildTeamRuntimeLaunchArgsPlan(
    input: Parameters<TeamProvisioningMemberLifecycleHost['buildTeamRuntimeLaunchArgsPlan']>[0]
  ): Promise<TeamRuntimeLaunchArgsPlan> {
    return this.host.buildTeamRuntimeLaunchArgsPlan(input);
  }

  private persistInboxMessage(
    teamName: string,
    memberName: string,
    message: Record<string, unknown>
  ): void {
    this.host.persistInboxMessage(teamName, memberName, message);
  }

  private persistSentMessage(teamName: string, message: Record<string, unknown>): void {
    this.host.persistSentMessage(teamName, message);
  }

  private appendMemberBootstrapDiagnostic(
    run: ProvisioningRun,
    memberName: string,
    text: string
  ): void {
    this.host.appendMemberBootstrapDiagnostic(run, memberName, text);
  }

  private setMemberSpawnStatus(
    run: ProvisioningRun,
    memberName: string,
    status: 'spawning' | 'waiting' | 'online' | 'error' | 'offline' | 'skipped',
    error?: string,
    livenessSource?: 'heartbeat' | 'process',
    heartbeatAt?: string
  ): void {
    this.host.setMemberSpawnStatus(run, memberName, status, error, livenessSource, heartbeatAt);
  }

  private upsertRunAllEffectiveMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): void {
    this.host.upsertRunAllEffectiveMember(run, member);
  }

  private removeRunAllEffectiveMember(run: ProvisioningRun, memberName: string): void {
    this.host.removeRunAllEffectiveMember(run, memberName);
  }

  private invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.host.invalidateRuntimeSnapshotCaches(teamName);
  }

  private resetRuntimeToolActivity(run: ProvisioningRun, memberName?: string): void {
    this.host.resetRuntimeToolActivity(run, memberName);
  }

  private clearMemberSpawnToolTracking(run: ProvisioningRun, memberName: string): void {
    this.host.clearMemberSpawnToolTracking(run, memberName);
  }

  private getAliveRunId(teamName: string): string | null {
    return this.host.getAliveRunId(teamName);
  }

  private getTrackedRunId(teamName: string): string | null {
    return this.host.getTrackedRunId(teamName);
  }

  private getProvisioningRunId(teamName: string): string | null {
    return this.host.getProvisioningRunId(teamName);
  }

  private isCurrentTrackedRun(run: ProvisioningRun): boolean {
    return this.host.isCurrentTrackedRun(run);
  }

  private readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null> {
    return this.host.readConfigForStrictDecision(teamName);
  }

  private resolveEffectiveConfiguredMember(
    configMembers: TeamConfig['members'],
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>,
    memberName: string
  ): EffectiveConfiguredMember | null {
    return this.host.resolveEffectiveConfiguredMember(configMembers, metaMembers, memberName);
  }

  private resolveLeadMemberName(
    configMembers: TeamConfig['members'],
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>
  ): string {
    return this.host.resolveLeadMemberName(configMembers, metaMembers);
  }

  private getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return this.host.getLiveTeamAgentRuntimeMetadata(teamName);
  }

  private readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[] {
    return this.host.readPersistedRuntimeMembers(teamName);
  }

  private persistLaunchStateSnapshot(
    run: ProvisioningRun,
    phase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.host.persistLaunchStateSnapshot(run, phase);
  }

  private buildTrackedMemberMcpLaunchConfig(
    input: Parameters<TeamProvisioningMemberLifecycleHost['buildTrackedMemberMcpLaunchConfig']>[0]
  ): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    return this.host.buildTrackedMemberMcpLaunchConfig(input);
  }

  private removeTrackedMemberMcpLaunchConfig(
    run: ProvisioningRun,
    config: RuntimeBootstrapMemberMcpLaunchConfig | null
  ): Promise<void> {
    return this.host.removeTrackedMemberMcpLaunchConfig(run, config);
  }

  private sendMessageToRun(run: ProvisioningRun, message: string): Promise<unknown> {
    return this.host.sendMessageToRun(run, message);
  }

  private getOpenCodeRuntimeAdapter(): unknown | null {
    return this.host.getOpenCodeRuntimeAdapter();
  }

  private resolveOpenCodeMemberWorkspacesForRuntime(
    input: Parameters<
      TeamProvisioningMemberLifecycleHost['resolveOpenCodeMemberWorkspacesForRuntime']
    >[0]
  ): Promise<TeamCreateRequest['members']> {
    return this.host.resolveOpenCodeMemberWorkspacesForRuntime(input);
  }

  private buildConfiguredProvisioningMember(
    member: EffectiveConfiguredMember
  ): TeamCreateRequest['members'][number] {
    return this.host.buildConfiguredProvisioningMember(member);
  }

  private runOpenCodeTeamRuntimeAdapterLaunch(
    input: Parameters<TeamProvisioningMemberLifecycleHost['runOpenCodeTeamRuntimeAdapterLaunch']>[0]
  ): Promise<unknown> {
    return this.host.runOpenCodeTeamRuntimeAdapterLaunch(input);
  }

  private createMixedSecondaryLaneStateForMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    return this.host.createMixedSecondaryLaneStateForMember(run, member);
  }

  private stopSingleMixedSecondaryRuntimeLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: 'cleanup' | 'relaunch'
  ): Promise<void> {
    return this.host.stopSingleMixedSecondaryRuntimeLane(run, lane, reason);
  }

  private getRunLeadName(run: ProvisioningRun): string {
    return this.host.getRunLeadName(run);
  }

  private launchSingleMixedSecondaryLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void> {
    return this.host.launchSingleMixedSecondaryLane(run, lane);
  }

  private getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase {
    return this.host.getMixedSecondaryLaunchPhase(run);
  }

  private writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<unknown> {
    return this.host.writeLaunchStateSnapshot(teamName, snapshot);
  }

  private readPersistedTeamProjectPath(teamName: string): string | null {
    return this.host.readPersistedTeamProjectPath(teamName);
  }

  private resolveDirectRestartRuntimeCwd(params: {
    configuredMember: NonNullable<EffectiveConfiguredMember | null>;
    persistedRuntimeMembers: readonly PersistedRuntimeMemberLike[];
    config: TeamConfig;
    run: ProvisioningRun;
  }): string {
    const seam = this.restartUseCases.resolveDirectRestartRuntimeCwd;
    return (seam ?? this.resolveDirectRestartRuntimeCwdFallback)({
      configuredMember: params.configuredMember,
      persistedRuntimeMembers: params.persistedRuntimeMembers,
      projectPath: params.config.projectPath,
      runTrackedCwd: this.getRunTrackedCwd(params.run),
    });
  }

  private async updateDirectTmuxRestartMemberConfig(
    input: DirectTmuxRestartMemberConfigInput
  ): Promise<void> {
    const seam = this.restartUseCases.updateDirectTmuxRestartMemberConfig;
    await (seam ?? this.updateDirectTmuxRestartMemberConfigFallback)(input);
  }

  private enqueueDirectRestartPrompt(input: DirectRestartPromptInput): void {
    const seam = this.host.enqueueDirectRestartPrompt;
    if (seam) {
      seam(input);
      return;
    }
    this.enqueueDirectRestartPromptInternal(input);
  }

  private enqueueDirectRestartPromptInternal(input: DirectRestartPromptInput): void {
    const timestamp = nowIso();
    const operation = input.operation ?? 'manual_restart';
    const isRestart = operation === 'manual_restart';
    this.persistInboxMessage(input.teamName, input.memberName, {
      from: input.leadName,
      to: input.memberName,
      text: input.prompt,
      timestamp,
      read: false,
      source: 'system_notification',
      leadSessionId: input.leadSessionId ?? undefined,
      messageId: `direct-${operation}-${input.memberName}-${randomUUID()}`,
      summary: isRestart
        ? `Restart bootstrap instructions for ${input.memberName}`
        : `Bootstrap instructions for ${input.memberName}`,
    });
  }

  private persistOpenCodeMemberRestartSystemMessage(
    input: OpenCodeMemberRestartSystemMessageInput
  ): void {
    const seam = this.restartUseCases.persistOpenCodeMemberRestartSystemMessage;
    if (seam) {
      seam(input);
      return;
    }
    this.persistOpenCodeMemberRestartSystemMessageInternal(input);
  }

  persistOpenCodeMemberRestartSystemMessageInternal(
    input: OpenCodeMemberRestartSystemMessageInput
  ): void {
    this.persistOpenCodeMemberRestartSystemMessageFallback(input);
  }

  private async launchDirectTmuxMemberRestart(input: {
    run: ProvisioningRun;
    teamName: string;
    displayName: string;
    leadName: string;
    memberName: string;
    config: TeamConfig;
    configuredMember: NonNullable<EffectiveConfiguredMember | null>;
    persistedRuntimeMembers: readonly PersistedRuntimeMemberLike[];
    paneId: string;
  }): Promise<void> {
    const paneInfo = (await listTmuxPaneRuntimeInfoForCurrentPlatform([input.paneId])).get(
      input.paneId
    );
    if (!paneInfo) {
      throw new Error(
        `Cannot restart teammate "${input.memberName}" because tmux pane ${input.paneId} is not available`
      );
    }
    if (!isInteractiveShellCommand(paneInfo.currentCommand)) {
      throw new Error(
        `Cannot restart teammate "${input.memberName}" because tmux pane ${input.paneId} is busy (${paneInfo.currentCommand ?? 'unknown command'})`
      );
    }

    const claudePath = await ClaudeBinaryResolver.resolve();
    if (!claudePath) {
      throw buildMissingCliError();
    }

    const cwd = this.resolveDirectRestartRuntimeCwd({
      configuredMember: input.configuredMember,
      persistedRuntimeMembers: input.persistedRuntimeMembers,
      config: input.config,
      run: input.run,
    });
    await ensureCwdExists(cwd);

    const operation: DirectProcessMemberLaunchReason = 'manual_restart';
    const preliminaryMemberSpec = this.buildPrimaryOwnedMemberSpecForRuntime({
      configuredMember: input.configuredMember,
      run: input.run,
    });
    const providerId = resolveTeamProviderId(preliminaryMemberSpec.providerId);
    const providerBackendId = migrateProviderBackendId(
      providerId,
      preliminaryMemberSpec.providerBackendId
    );
    const provisioningEnv = await this.buildProvisioningEnv(providerId, providerBackendId, {
      teamRuntimeAuth: {
        teamName: input.teamName,
        authMaterialId: `${input.run.runId}-direct-${input.configuredMember.name}-${randomUUID()}`,
        allowAnthropicApiKeyHelper: true,
      },
    });
    if (provisioningEnv.warning) {
      throw new Error(provisioningEnv.warning);
    }

    const [materializedMemberSpec] = await this.materializeEffectiveTeamMemberSpecs({
      claudePath,
      cwd,
      members: [preliminaryMemberSpec],
      defaults: {
        providerId: resolveTeamProviderId(input.run.request.providerId),
        model: input.run.request.model,
        effort: input.run.request.effort,
      },
      primaryProviderId: providerId,
      primaryEnv: provisioningEnv,
      teamRuntimeAuth: {
        teamName: input.teamName,
        authMaterialId: `${input.run.runId}-direct-${operation}-${input.configuredMember.name}-defaults-${randomUUID()}`,
        allowAnthropicApiKeyHelper: true,
      },
    });
    const memberSpec = materializedMemberSpec ?? preliminaryMemberSpec;
    const launchIdentity = await this.resolveDirectMemberLaunchIdentity({
      claudePath,
      cwd,
      providerId,
      ...(providerBackendId ? { providerBackendId } : {}),
      provisioningEnv,
      memberSpec,
      run: input.run,
    });
    const memberMcpPolicy = normalizeTeamMemberMcpPolicy(memberSpec.mcpPolicy);
    const mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(cwd, {
      mcpPolicy: memberMcpPolicy,
      controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
    });
    const memberMcpConfigPaths = input.run.memberMcpConfigPaths ?? [];
    input.run.memberMcpConfigPaths = memberMcpConfigPaths;
    memberMcpConfigPaths.push(mcpConfigPath);
    const memberMcpSettingSources = buildTeamMemberMcpSettingSources(memberMcpPolicy);
    const strictMemberMcpConfig = requiresStrictTeamMemberMcpConfig(memberMcpPolicy);
    const agentId = `${input.configuredMember.name}@${input.teamName}`;
    const color =
      input.config.members
        ?.find((member) => matchesExactTeamMemberName(member.name, input.memberName))
        ?.color?.trim() || getMemberColorByName(input.configuredMember.name);
    const parentSessionId =
      input.run.detectedSessionId?.trim() || input.config.leadSessionId?.trim() || input.run.runId;
    const prompt = buildMemberSpawnPrompt(
      memberSpec,
      input.displayName,
      input.teamName,
      input.leadName,
      { restart: true }
    );
    const bootstrapExpectedAfter = nowIso();
    const runtimeArgsPlan = await this.buildTeamRuntimeLaunchArgsPlan({
      teamName: input.teamName,
      providerId,
      launchIdentity,
      envResolution: provisioningEnv,
      extraArgs: [],
      includeAnthropicHelper: providerId === 'anthropic',
      contextLabel: `Direct teammate restart (${input.configuredMember.name})`,
    });
    applyAppManagedRuntimeSettingsPathEnv(
      provisioningEnv.env,
      runtimeArgsPlan.appManagedSettingsPath
    );

    const runtimeArgs = mergeJsonSettingsArgs([
      '--agent-id',
      agentId,
      '--agent-name',
      input.configuredMember.name,
      '--team-name',
      input.teamName,
      '--agent-color',
      color,
      '--parent-session-id',
      parentSessionId,
      ...(input.configuredMember.agentType
        ? ['--agent-type', input.configuredMember.agentType]
        : []),
      '--setting-sources',
      memberMcpSettingSources,
      '--mcp-config',
      mcpConfigPath,
      ...(strictMemberMcpConfig ? ['--strict-mcp-config'] : []),
      '--disallowedTools',
      APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      ...(input.run.request.skipPermissions !== false
        ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
        : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
      ...(memberSpec.model ? ['--model', memberSpec.model] : []),
      ...(memberSpec.effort ? ['--effort', memberSpec.effort] : []),
      ...runtimeArgsPlan.providerArgs,
      ...runtimeArgsPlan.fastModeArgs,
      ...runtimeArgsPlan.runtimeTurnSettledHookArgs,
      ...runtimeArgsPlan.settingsArgs,
    ]);
    const command = buildDirectTmuxRestartCommand({
      cwd,
      env: provisioningEnv.env,
      providerId,
      binaryPath: claudePath,
      args: runtimeArgs,
    });

    await this.updateDirectTmuxRestartMemberConfig({
      teamName: input.teamName,
      memberName: input.memberName,
      member: memberSpec,
      agentId,
      color,
      prompt,
      paneId: input.paneId,
      cwd,
      providerId,
      joinedAt: Date.now(),
      bootstrapExpectedAfter,
    });
    this.enqueueDirectRestartPrompt({
      teamName: input.teamName,
      memberName: input.configuredMember.name,
      leadName: input.leadName,
      leadSessionId: parentSessionId,
      prompt,
      operation,
    });
    await sendKeysToTmuxPaneForCurrentPlatform(input.paneId, command);
    this.appendMemberBootstrapDiagnostic(
      input.run,
      input.memberName,
      `restart command delivered to tmux pane ${input.paneId}`
    );
    this.setMemberSpawnStatus(input.run, input.memberName, 'waiting');
  }

  private async launchDirectProcessMemberRestart(
    input: DirectProcessMemberRestartInput
  ): Promise<void> {
    const seam = this.restartUseCases.launchDirectProcessMemberRestart;
    if (seam) {
      await seam(input);
      return;
    }
    await this.launchDirectProcessMemberRestartInternal(input);
  }

  async launchDirectProcessMemberRestartInternal(
    input: DirectProcessMemberRestartInput
  ): Promise<void> {
    const operation = input.operation ?? 'manual_restart';
    const claudePath = input.run.spawnContext?.claudePath ?? (await ClaudeBinaryResolver.resolve());
    if (!claudePath) {
      throw buildMissingCliError();
    }

    const cwd = this.resolveDirectRestartRuntimeCwd({
      configuredMember: input.configuredMember,
      persistedRuntimeMembers: input.persistedRuntimeMembers,
      config: input.config,
      run: input.run,
    });
    await ensureCwdExists(cwd);

    const preliminaryMemberSpec = this.buildPrimaryOwnedMemberSpecForRuntime({
      configuredMember: input.configuredMember,
      run: input.run,
    });
    const providerId = resolveTeamProviderId(preliminaryMemberSpec.providerId);
    const providerBackendId = migrateProviderBackendId(
      providerId,
      preliminaryMemberSpec.providerBackendId
    );
    const provisioningEnv = await this.buildProvisioningEnv(providerId, providerBackendId, {
      teamRuntimeAuth: {
        teamName: input.teamName,
        authMaterialId: `${input.run.runId}-process-${operation}-${input.configuredMember.name}-${randomUUID()}`,
        allowAnthropicApiKeyHelper: true,
      },
    });
    if (provisioningEnv.warning) {
      throw new Error(provisioningEnv.warning);
    }

    const [materializedMemberSpec] = await this.materializeEffectiveTeamMemberSpecs({
      claudePath,
      cwd,
      members: [preliminaryMemberSpec],
      defaults: {
        providerId: resolveTeamProviderId(input.run.request.providerId),
        model: input.run.request.model,
        effort: input.run.request.effort,
      },
      primaryProviderId: providerId,
      primaryEnv: provisioningEnv,
      teamRuntimeAuth: {
        teamName: input.teamName,
        authMaterialId: `${input.run.runId}-process-${operation}-${input.configuredMember.name}-defaults-${randomUUID()}`,
        allowAnthropicApiKeyHelper: true,
      },
    });
    const memberSpec = materializedMemberSpec ?? preliminaryMemberSpec;
    const launchIdentity = await this.resolveDirectMemberLaunchIdentity({
      claudePath,
      cwd,
      providerId,
      ...(providerBackendId ? { providerBackendId } : {}),
      provisioningEnv,
      memberSpec,
      run: input.run,
    });
    const memberMcpPolicy = normalizeTeamMemberMcpPolicy(memberSpec.mcpPolicy);
    const mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(cwd, {
      mcpPolicy: memberMcpPolicy,
      controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
    });
    const memberMcpConfigPaths = input.run.memberMcpConfigPaths ?? [];
    input.run.memberMcpConfigPaths = memberMcpConfigPaths;
    memberMcpConfigPaths.push(mcpConfigPath);
    const memberMcpSettingSources = buildTeamMemberMcpSettingSources(memberMcpPolicy);
    const strictMemberMcpConfig = requiresStrictTeamMemberMcpConfig(memberMcpPolicy);
    const agentId = `${input.configuredMember.name}@${input.teamName}`;
    const color =
      input.config.members
        ?.find((member) => matchesExactTeamMemberName(member.name, input.memberName))
        ?.color?.trim() || getMemberColorByName(input.configuredMember.name);
    const parentSessionId =
      input.run.detectedSessionId?.trim() || input.config.leadSessionId?.trim() || input.run.runId;
    const prompt = buildMemberSpawnPrompt(
      memberSpec,
      input.displayName,
      input.teamName,
      input.leadName,
      operation === 'manual_restart' ? { restart: true } : undefined
    );
    const bootstrapExpectedAfter = nowIso();
    const bootstrapProofToken = randomUUID();
    const runtimePaths = this.getDirectProcessRestartRuntimePaths(
      input.teamName,
      input.configuredMember.name
    );
    await atomicWriteAsync(runtimePaths.eventsPath, '', { mode: 0o600 });

    const nativeBootstrapSpec =
      (
        await buildNativeAppManagedBootstrapSpecs({
          teamName: input.teamName,
          cwd,
          members: [memberSpec],
        })
      ).get(input.configuredMember.name) ?? null;
    const nativeBootstrapEnv = await this.materializeDirectProcessNativeBootstrapContext({
      teamName: input.teamName,
      memberName: input.configuredMember.name,
      agentId,
      providerId,
      runId: input.run.runId,
      bootstrapProofToken,
      spec: nativeBootstrapSpec,
    });

    const runtimeArgsPlan = await this.buildTeamRuntimeLaunchArgsPlan({
      teamName: input.teamName,
      providerId,
      launchIdentity,
      envResolution: provisioningEnv,
      extraArgs: [],
      includeAnthropicHelper: providerId === 'anthropic',
      contextLabel: `Direct process teammate ${operation} (${input.configuredMember.name})`,
    });
    applyAppManagedRuntimeSettingsPathEnv(
      provisioningEnv.env,
      runtimeArgsPlan.appManagedSettingsPath
    );

    const runtimeArgs = mergeJsonSettingsArgs([
      '--teammate-runtime',
      'headless',
      '--agent-id',
      agentId,
      '--agent-name',
      input.configuredMember.name,
      '--team-name',
      input.teamName,
      '--agent-color',
      color,
      '--parent-session-id',
      parentSessionId,
      ...(input.configuredMember.agentType
        ? ['--agent-type', input.configuredMember.agentType]
        : []),
      '--setting-sources',
      memberMcpSettingSources,
      '--mcp-config',
      mcpConfigPath,
      ...(strictMemberMcpConfig ? ['--strict-mcp-config'] : []),
      '--disallowedTools',
      APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      ...(input.run.request.skipPermissions !== false
        ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
        : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
      ...(memberSpec.model ? ['--model', memberSpec.model] : []),
      ...(memberSpec.effort ? ['--effort', memberSpec.effort] : []),
      ...runtimeArgsPlan.providerArgs,
      ...runtimeArgsPlan.fastModeArgs,
      ...runtimeArgsPlan.runtimeTurnSettledHookArgs,
      ...runtimeArgsPlan.settingsArgs,
    ]);

    const stdoutLog = fs.createWriteStream(runtimePaths.stdoutPath, { flags: 'a', mode: 0o600 });
    const stderrLog = fs.createWriteStream(runtimePaths.stderrPath, { flags: 'a', mode: 0o600 });
    const child = spawnCli(claudePath, runtimeArgs, {
      cwd,
      detached: true,
      env: {
        ...provisioningEnv.env,
        ...nativeBootstrapEnv,
        [TEAMMATE_RUNTIME_ENV]: 'headless',
        [TEAMMATE_RUNTIME_EVENTS_ENV]: runtimePaths.eventsPath,
        [TEAMMATE_BOOTSTRAP_PROOF_TOKEN_ENV]: bootstrapProofToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child.pid) {
      stdoutLog.destroy();
      stderrLog.destroy();
      throw new Error(`Failed to spawn teammate process for ${agentId}: missing pid`);
    }

    const runtimePid = child.pid;
    const processPaneId = `process:${runtimePid}`;
    const runtimeEventSource = `TeamProvisioningService.direct_process_${operation}`;
    child.stdout?.pipe(stdoutLog);
    child.stderr?.pipe(stderrLog);
    child.stdin?.on('error', (error) => {
      logger.debug(
        `[${input.teamName}] Direct process ${operation} stdin failed for ${agentId}: ${error.message}`
      );
    });
    child.once('close', (code, signal) => {
      void this.appendDirectProcessRuntimeEvent({
        type: 'exited',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName: input.teamName,
        agentName: input.configuredMember.name,
        agentId,
        runId: parentSessionId,
        bootstrapRunId: input.run.runId,
        source: runtimeEventSource,
        detail:
          code !== null
            ? `process exited with code ${code}`
            : signal
              ? `process exited from signal ${signal}`
              : 'process exited',
      });
      stdoutLog.end();
      stderrLog.end();
    });
    child.once('error', (error) => {
      void this.appendDirectProcessRuntimeEvent({
        type: 'failed',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName: input.teamName,
        agentName: input.configuredMember.name,
        agentId,
        runId: parentSessionId,
        bootstrapRunId: input.run.runId,
        source: runtimeEventSource,
        detail: `process error: ${error.message}`,
      });
    });
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.unref();

    try {
      await this.appendDirectProcessRuntimeEvent({
        type: 'process_spawned',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName: input.teamName,
        agentName: input.configuredMember.name,
        agentId,
        runId: parentSessionId,
        bootstrapRunId: input.run.runId,
        source: runtimeEventSource,
        detail: 'process spawned',
      });
      await this.appendDirectProcessRuntimeEvent({
        type: 'stdout_attached',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName: input.teamName,
        agentName: input.configuredMember.name,
        agentId,
        runId: parentSessionId,
        bootstrapRunId: input.run.runId,
        source: runtimeEventSource,
        detail: 'stdout and stderr attached',
      });
      await this.updateDirectTmuxRestartMemberConfig({
        teamName: input.teamName,
        memberName: input.memberName,
        member: memberSpec,
        agentId,
        color,
        prompt,
        paneId: processPaneId,
        cwd,
        providerId,
        joinedAt: Date.now(),
        bootstrapExpectedAfter,
        backendType: 'process',
        runtimePid,
        bootstrapRuntimeEventsPath: runtimePaths.eventsPath,
        bootstrapProofToken,
        bootstrapRunId: input.run.runId,
        ...(nativeBootstrapSpec
          ? {
              bootstrapContextHash: nativeBootstrapSpec.contextHash,
              bootstrapBriefingHash: nativeBootstrapSpec.briefingHash,
            }
          : {}),
      });
      this.enqueueDirectRestartPrompt({
        teamName: input.teamName,
        memberName: input.configuredMember.name,
        leadName: input.leadName,
        leadSessionId: parentSessionId,
        prompt,
        operation,
      });
      await this.appendDirectProcessRuntimeEvent({
        type: 'mailbox_bootstrap_written',
        eventsPath: runtimePaths.eventsPath,
        pid: runtimePid,
        teamName: input.teamName,
        agentName: input.configuredMember.name,
        agentId,
        runId: parentSessionId,
        bootstrapRunId: input.run.runId,
        source: runtimeEventSource,
      });
      this.upsertRunAllEffectiveMember(input.run, memberSpec);
      this.appendMemberBootstrapDiagnostic(
        input.run,
        input.memberName,
        operation === 'manual_restart'
          ? `restart process spawned with pid ${runtimePid}`
          : `runtime process spawned with pid ${runtimePid}`
      );
      this.setMemberSpawnStatus(input.run, input.memberName, 'waiting');
    } catch (error) {
      try {
        killProcessByPid(runtimePid);
      } catch (killError) {
        logger.warn(
          `[${input.teamName}] Failed to stop orphaned direct process ${agentId} pid=${runtimePid}: ${
            killError instanceof Error ? killError.message : String(killError)
          }`
        );
      }
      stdoutLog.end();
      stderrLog.end();
      throw error;
    }
  }

  private getDirectProcessRestartRuntimePaths(
    teamName: string,
    memberName: string
  ): { dir: string; eventsPath: string; stdoutPath: string; stderrPath: string } {
    const dir = getTeamRuntimeEventsDir(teamName);
    const filePrefix = sanitizeProcessRuntimeEventFilePrefix(memberName);
    return {
      dir,
      eventsPath: path.join(dir, `${filePrefix}.runtime.jsonl`),
      stdoutPath: path.join(dir, `${filePrefix}.stdout.log`),
      stderrPath: path.join(dir, `${filePrefix}.stderr.log`),
    };
  }

  private async materializeDirectProcessNativeBootstrapContext(input: {
    teamName: string;
    memberName: string;
    agentId: string;
    providerId: TeamProviderId;
    runId: string;
    bootstrapProofToken: string;
    spec: NativeAppManagedBootstrapSpec | null;
  }): Promise<Record<string, string>> {
    if (!input.spec || (input.providerId !== 'anthropic' && input.providerId !== 'codex')) {
      return {};
    }
    const context = {
      ...input.spec,
      kind: 'native_app_managed_bootstrap',
      teamName: input.teamName,
      memberName: input.memberName,
      agentId: input.agentId,
      runId: input.runId,
      provider: input.providerId,
      bootstrapProofToken: input.bootstrapProofToken,
    };
    const dir = path.join(getTeamRuntimeEventsDir(input.teamName), 'native-bootstrap');
    const finalPath = path.join(
      dir,
      `${sanitizeProcessRuntimeEventFilePrefix(input.memberName)}-${randomUUID()}.native-bootstrap.json`
    );
    await atomicWriteAsync(finalPath, JSON.stringify(context), { mode: 0o600 });
    return { [NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]: finalPath };
  }

  private async appendDirectProcessRuntimeEvent(
    input: DirectProcessRuntimeEventInput
  ): Promise<void> {
    const seam = this.restartUseCases.appendDirectProcessRuntimeEvent;
    await (seam ?? this.appendDirectProcessRuntimeEventFallback)(input);
  }

  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean {
    return this.operationUseCases.isMemberLifecycleOperationActive(teamName, memberName);
  }

  private isMemberLifecycleOperationInProgressError(error: unknown): boolean {
    return isMemberLifecycleOperationInProgressError(error);
  }

  private async runMemberLifecycleOperation<T>(
    teamName: string,
    memberName: string,
    kind: MemberLifecycleOperationKind,
    operation: () => Promise<T>
  ): Promise<T> {
    return await this.runMemberLifecycleOperationInternal(teamName, memberName, kind, operation);
  }

  async runMemberLifecycleOperationInternal<T>(
    teamName: string,
    memberName: string,
    kind: MemberLifecycleOperationKind,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.operationUseCases.runMemberLifecycleOperation(
      teamName,
      memberName,
      kind,
      operation
    );
  }

  private getOpenCodeReattachLifecycleKind(
    reason?: 'member_added' | 'member_updated' | 'manual_restart'
  ): MemberLifecycleOperationKind {
    if (reason === 'member_added') return 'opencode_member_added';
    if (reason === 'member_updated') return 'opencode_member_updated';
    return 'manual_restart';
  }

  private getLiveRosterAttachLifecycleKind(
    reason?: LiveRosterAttachReason
  ): MemberLifecycleOperationKind {
    if (reason === 'member_restored') return 'primary_member_restored';
    if (reason === 'member_updated') return 'primary_member_updated';
    return 'primary_member_added';
  }

  async attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void> {
    const seam = this.actionUseCases.attachLiveRosterMember;
    return this.runMemberLifecycleOperation(
      teamName,
      memberName,
      this.getLiveRosterAttachLifecycleKind(options?.reason),
      () =>
        seam
          ? seam(teamName, memberName, options)
          : this.attachLiveRosterMemberUnlocked(teamName, memberName, options)
    );
  }

  private async stopPrimaryOwnedRosterRuntime(
    input: StopPrimaryOwnedRosterRuntimeInput
  ): Promise<void> {
    const seam = this.restartUseCases.stopPrimaryOwnedRosterRuntime;
    if (seam) {
      await seam(input);
      return;
    }
    await this.stopPrimaryOwnedRosterRuntimeInternal(input);
  }

  async stopPrimaryOwnedRosterRuntimeInternal(
    input: StopPrimaryOwnedRosterRuntimeInput
  ): Promise<void> {
    await this.stopPrimaryOwnedRosterRuntimeFallback(input);
  }

  private async preparePrimaryOwnedMemberRestartRuntime(
    input: PreparePrimaryOwnedMemberRestartRuntimeInput
  ): Promise<PreparePrimaryOwnedMemberRestartRuntimeResult> {
    const seam = this.restartUseCases.preparePrimaryOwnedMemberRestartRuntime;
    if (seam) {
      return await seam(input);
    }
    return await this.preparePrimaryOwnedMemberRestartRuntimeInternal(input);
  }

  async preparePrimaryOwnedMemberRestartRuntimeInternal(
    input: PreparePrimaryOwnedMemberRestartRuntimeInput
  ): Promise<PreparePrimaryOwnedMemberRestartRuntimeResult> {
    return await this.preparePrimaryOwnedMemberRestartRuntimeFallback(input);
  }

  private async attachLiveRosterMemberUnlocked(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void> {
    const run = this.getMutableAliveRunOrThrow(teamName);
    const config = await this.readConfigForStrictDecision(teamName);
    if (!config) {
      throw new Error(`Team "${teamName}" configuration is no longer available`);
    }
    const metaMembers = await this.membersMetaStore.getMembers(teamName).catch(() => []);
    const configuredMember = this.resolveEffectiveConfiguredMember(
      config.members ?? [],
      metaMembers,
      memberName
    );
    if (!configuredMember) {
      throw new Error(`Member "${memberName}" is not configured in team "${teamName}"`);
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${memberName}" has been removed`);
    }
    if (isLeadMember({ name: configuredMember.name, agentType: configuredMember.agentType })) {
      throw new Error('Lead attach is not supported from member controls');
    }

    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    const desiredProviderId =
      normalizeOptionalTeamProviderId(configuredMember.providerId) ?? leadProviderId;
    if (desiredProviderId === 'opencode') {
      await this.reattachOpenCodeOwnedMemberLaneUnlocked(teamName, memberName, {
        reason: options?.reason === 'member_updated' ? 'member_updated' : 'member_added',
      });
      return;
    }
    if (leadProviderId === 'opencode') {
      throw new Error(
        'OpenCode-led mixed teams are not supported in this phase. Stop the team and relaunch with a non-OpenCode lead.'
      );
    }

    const currentStatus = run.memberSpawnStatuses.get(memberName);
    const currentUpdatedAtMs = parseOptionalIsoMs(currentStatus?.updatedAt);
    const currentStatusAgeMs =
      currentUpdatedAtMs > 0 ? Date.now() - currentUpdatedAtMs : Number.POSITIVE_INFINITY;
    const currentSpawnLooksFresh =
      currentStatus?.status === 'spawning' && currentStatusAgeMs < MEMBER_BOOTSTRAP_STALL_MS;
    if (currentSpawnLooksFresh || currentStatus?.launchState === 'runtime_pending_permission') {
      throw new Error(`Launch for teammate "${memberName}" is already in progress`);
    }

    const replaceExistingRuntime = options?.reason === 'member_updated';
    const liveRuntimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName).catch(
      () => new Map<string, LiveTeamAgentRuntimeMetadata>()
    );
    const liveRuntimeMember =
      liveRuntimeByMember.get(memberName) ??
      [...liveRuntimeByMember.entries()].find(([candidateName]) =>
        matchesObservedMemberNameForExpected(candidateName, memberName)
      )?.[1];
    if (
      !replaceExistingRuntime &&
      liveRuntimeMember?.alive &&
      liveRuntimeMember.livenessKind === 'runtime_process'
    ) {
      this.upsertRunAllEffectiveMember(
        run,
        this.buildPrimaryOwnedMemberSpecForRuntime({
          configuredMember,
          run,
        })
      );
      this.setMemberSpawnStatus(run, memberName, 'online', undefined, 'process');
      return;
    }
    if (
      !replaceExistingRuntime &&
      liveRuntimeMember?.alive &&
      (liveRuntimeMember.livenessKind === 'runtime_process_candidate' ||
        liveRuntimeMember.livenessKind === 'permission_blocked') &&
      currentStatus?.launchState === 'runtime_pending_bootstrap'
    ) {
      throw new Error(`Launch for teammate "${memberName}" is already in progress`);
    }

    const persistedRuntimeMembers = this.readPersistedRuntimeMembers(teamName).filter((member) => {
      const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
      return candidateName.length > 0 && matchesMemberNameOrBase(candidateName, memberName);
    });
    const backendTypes = new Set(
      persistedRuntimeMembers
        .map((member) => member.backendType?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    if (backendTypes.has('in-process')) {
      throw new Error(
        `Member "${memberName}" uses an in-process runtime and cannot be attached here`
      );
    }
    if (replaceExistingRuntime) {
      await this.stopPrimaryOwnedRosterRuntime({
        teamName,
        memberName,
        persistedRuntimeMembers,
        liveRuntimeByMember,
        actionLabel: `Update for teammate "${memberName}"`,
      });
      this.setMemberSpawnStatus(run, memberName, 'offline');
    }

    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    run.pendingMemberRestarts.delete(memberName);
    this.setMemberSpawnStatus(run, memberName, 'spawning');
    if (currentStatus?.launchState === 'runtime_pending_bootstrap') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'stale runtime_pending_bootstrap without live runtime process; retrying launch'
      );
    }
    this.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      `live roster ${options?.reason ?? 'member_added'} requested app-managed runtime process`
    );

    try {
      await this.launchDirectProcessMemberRestart({
        run,
        teamName,
        displayName: config.name?.trim() || teamName,
        leadName: this.resolveLeadMemberName(config.members ?? [], metaMembers),
        memberName,
        config,
        configuredMember,
        persistedRuntimeMembers,
        operation: options?.reason ?? 'member_added',
      });
    } catch (error) {
      this.setMemberSpawnStatus(
        run,
        memberName,
        'error',
        error instanceof Error ? error.message : String(error)
      );
      if (run.isLaunch) {
        await this.persistLaunchStateSnapshot(
          run,
          run.provisioningComplete ? 'finished' : 'active'
        );
      }
      throw error;
    }
  }

  async detachLiveRosterMember(teamName: string, memberName: string): Promise<void> {
    const seam = this.actionUseCases.detachLiveRosterMember;
    return this.runMemberLifecycleOperation(teamName, memberName, 'primary_member_removed', () =>
      seam ? seam(teamName, memberName) : this.detachLiveRosterMemberUnlocked(teamName, memberName)
    );
  }

  private async detachLiveRosterMemberUnlocked(
    teamName: string,
    memberName: string
  ): Promise<void> {
    const run = this.getMutableAliveRunOrThrow(teamName);
    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    const config = await this.readConfigForStrictDecision(teamName);
    const metaMembers = await this.membersMetaStore.getMembers(teamName).catch(() => []);
    const configuredMember = this.resolveEffectiveConfiguredMember(
      config?.members ?? [],
      metaMembers,
      memberName
    );
    const desiredProviderId =
      normalizeOptionalTeamProviderId(configuredMember?.providerId) ?? leadProviderId;
    if (desiredProviderId === 'opencode') {
      await this.detachOpenCodeOwnedMemberLaneUnlocked(teamName, memberName);
      return;
    }
    if (leadProviderId === 'opencode') {
      throw new Error(
        'OpenCode-led mixed teams are not supported in this phase. Stop the team and relaunch with a non-OpenCode lead.'
      );
    }

    const persistedRuntimeMembers = this.readPersistedRuntimeMembers(teamName).filter((member) => {
      const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
      return candidateName.length > 0 && matchesMemberNameOrBase(candidateName, memberName);
    });
    const liveRuntimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName).catch(
      () => new Map<string, LiveTeamAgentRuntimeMetadata>()
    );
    await this.stopPrimaryOwnedRosterRuntime({
      teamName,
      memberName,
      persistedRuntimeMembers,
      liveRuntimeByMember,
      actionLabel: `Detach for teammate "${memberName}"`,
    });

    this.removeRunAllEffectiveMember(run, memberName);
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    run.pendingMemberRestarts.delete(memberName);
    this.setMemberSpawnStatus(run, memberName, 'offline');
    if (run.isLaunch) {
      await this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  async restartMember(teamName: string, memberName: string): Promise<void> {
    const seam = this.actionUseCases.restartMember;
    return this.runMemberLifecycleOperation(teamName, memberName, 'manual_restart', () =>
      seam ? seam(teamName, memberName) : this.restartMemberUnlocked(teamName, memberName)
    );
  }

  private async restartMemberUnlocked(teamName: string, memberName: string): Promise<void> {
    const runId = this.getAliveRunId(teamName);
    if (!runId) {
      if (await this.restartPureOpenCodePrimaryMemberWithoutTrackedRun(teamName, memberName)) {
        return;
      }
      throw new Error(`Team "${teamName}" is not currently running`);
    }
    const run = this.runs.get(runId);
    if (!run || run.processKilled || run.cancelRequested) {
      if (await this.restartPureOpenCodePrimaryMemberWithoutTrackedRun(teamName, memberName)) {
        return;
      }
      throw new Error(`Team "${teamName}" is not currently running`);
    }

    const readCurrentConfiguredMember = async (): Promise<{
      config: TeamConfig | null;
      configuredMembers: TeamConfig['members'];
      metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>;
      configuredMember: EffectiveConfiguredMember | null;
    }> => {
      const config = await this.readConfigForStrictDecision(teamName);
      const configuredMembers = config?.members ?? [];
      let metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>> = [];
      try {
        metaMembers = await this.membersMetaStore.getMembers(teamName);
      } catch {
        metaMembers = [];
      }

      return {
        config,
        configuredMembers,
        metaMembers,
        configuredMember: this.resolveEffectiveConfiguredMember(
          configuredMembers,
          metaMembers,
          memberName
        ),
      };
    };

    let currentConfiguredMemberState = await readCurrentConfiguredMember();
    let config = currentConfiguredMemberState.config;
    let configuredMember = currentConfiguredMemberState.configuredMember;
    if (!config) {
      throw new Error(`Team "${teamName}" configuration is no longer available`);
    }
    if (!configuredMember) {
      throw new Error(`Member "${memberName}" is not configured in team "${teamName}"`);
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${memberName}" has been removed`);
    }
    if (isLeadMember({ name: memberName, agentType: configuredMember.agentType })) {
      throw new Error('Lead restart is not supported from member controls');
    }
    const desiredProviderId = normalizeOptionalTeamProviderId(configuredMember.providerId);
    const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
    const liveSecondaryLaneMemberName =
      mixedSecondaryLanes
        .find((lane) => lane.member.name.trim() === memberName)
        ?.member.name?.trim() ?? null;
    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    const desiredSecondaryLane = desiredProviderId === 'opencode' && leadProviderId !== 'opencode';
    if (liveSecondaryLaneMemberName === memberName || desiredSecondaryLane) {
      await this.reattachOpenCodeOwnedMemberLaneUnlocked(teamName, memberName, {
        reason: 'manual_restart',
      });
      return;
    }
    if (run.pendingMemberRestarts.has(memberName)) {
      throw new Error(`Restart for teammate "${memberName}" is already in progress`);
    }

    const persistedRuntimeMembers = this.readPersistedRuntimeMembers(teamName).filter((member) => {
      const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
      return candidateName.length > 0 && matchesMemberNameOrBase(candidateName, memberName);
    });

    const restartRuntimePreparation = await this.preparePrimaryOwnedMemberRestartRuntime({
      teamName,
      memberName,
      persistedRuntimeMembers,
      invalidateRuntimeSnapshotCaches: () => this.invalidateRuntimeSnapshotCaches(teamName),
      loadLiveRuntimeByMember: () => this.getLiveTeamAgentRuntimeMetadata(teamName),
    });
    const { directTmuxRestartPaneId, shouldDirectProcessRestart } = restartRuntimePreparation;

    this.setMemberSpawnStatus(run, memberName, 'offline');

    const latestRunId = this.getAliveRunId(teamName);
    const currentRun = this.runs.get(runId);
    if (
      latestRunId !== runId ||
      !currentRun ||
      currentRun !== run ||
      currentRun.processKilled ||
      currentRun.cancelRequested
    ) {
      throw new Error(`Team "${teamName}" is not currently running`);
    }

    currentConfiguredMemberState = await readCurrentConfiguredMember();
    config = currentConfiguredMemberState.config;
    configuredMember = currentConfiguredMemberState.configuredMember;
    if (!config) {
      throw new Error(`Team "${teamName}" configuration disappeared while restart was in progress`);
    }
    if (!configuredMember) {
      throw new Error(
        `Member "${memberName}" is no longer configured in team "${teamName}" after restart preparation`
      );
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${memberName}" was removed while restart was in progress`);
    }
    if (isLeadMember({ name: memberName, agentType: configuredMember.agentType })) {
      throw new Error('Lead restart is not supported from member controls');
    }

    run.pendingMemberRestarts.set(memberName, {
      requestedAt: nowIso(),
      desired: {
        name: configuredMember.name,
        role: configuredMember.role,
        workflow: configuredMember.workflow,
        isolation: configuredMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: configuredMember.providerId,
        model: configuredMember.model,
        effort: configuredMember.effort,
      },
    });
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    this.setMemberSpawnStatus(run, memberName, 'spawning');
    this.appendMemberBootstrapDiagnostic(run, memberName, 'manual restart requested from UI');

    const leadName = this.resolveLeadMemberName(
      currentConfiguredMemberState.configuredMembers,
      currentConfiguredMemberState.metaMembers
    );
    if (directTmuxRestartPaneId) {
      try {
        await this.launchDirectTmuxMemberRestart({
          run,
          teamName,
          displayName: config?.name?.trim() || teamName,
          leadName,
          memberName,
          config,
          configuredMember,
          persistedRuntimeMembers,
          paneId: directTmuxRestartPaneId,
        });
        return;
      } catch (error) {
        run.pendingMemberRestarts.delete(memberName);
        this.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          error instanceof Error ? error.message : String(error)
        );
        if (run.isLaunch) {
          await this.persistLaunchStateSnapshot(
            run,
            run.provisioningComplete ? 'finished' : 'active'
          );
        }
        throw error;
      }
    }

    if (shouldDirectProcessRestart) {
      try {
        await this.launchDirectProcessMemberRestart({
          run,
          teamName,
          displayName: config?.name?.trim() || teamName,
          leadName,
          memberName,
          config,
          configuredMember,
          persistedRuntimeMembers,
        });
        return;
      } catch (error) {
        run.pendingMemberRestarts.delete(memberName);
        this.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          error instanceof Error ? error.message : String(error)
        );
        if (run.isLaunch) {
          await this.persistLaunchStateSnapshot(
            run,
            run.provisioningComplete ? 'finished' : 'active'
          );
        }
        throw error;
      }
    }

    let restartMcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null = null;
    try {
      restartMcpLaunchConfig = await this.buildTrackedMemberMcpLaunchConfig({
        cwd: configuredMember.cwd?.trim() || config.projectPath?.trim() || run.request.cwd,
        mcpPolicy: configuredMember.mcpPolicy,
        run,
      });
      const restartMessage = buildRestartMemberSpawnMessage(
        teamName,
        config?.name?.trim() || teamName,
        leadName,
        {
          name: configuredMember.name,
          role: configuredMember.role,
          workflow: configuredMember.workflow,
          isolation: configuredMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: configuredMember.providerId,
          model: configuredMember.model,
          effort: configuredMember.effort,
        },
        restartMcpLaunchConfig
      );
      await this.sendMessageToRun(run, restartMessage);
    } catch (error) {
      await this.removeTrackedMemberMcpLaunchConfig(run, restartMcpLaunchConfig).catch(() => {});
      run.pendingMemberRestarts.delete(memberName);
      this.setMemberSpawnStatus(
        run,
        memberName,
        'error',
        error instanceof Error ? error.message : String(error)
      );
      if (run.isLaunch) {
        await this.persistLaunchStateSnapshot(
          run,
          run.provisioningComplete ? 'finished' : 'active'
        );
      }
      throw error;
    }
  }

  private async restartPureOpenCodePrimaryMemberWithoutTrackedRun(
    teamName: string,
    memberName: string
  ): Promise<boolean> {
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (runtimeRun?.providerId !== 'opencode') {
      return false;
    }

    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is not available for member restart.');
    }

    const config = await this.readConfigForStrictDecision(teamName);
    if (!config) {
      return false;
    }

    const [teamMeta, metaMembers] = await Promise.all([
      this.teamMetaStore.getMeta(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    const configuredMember = this.resolveEffectiveConfiguredMember(
      config.members ?? [],
      metaMembers,
      memberName
    );
    if (!configuredMember) {
      throw new Error(`Member "${memberName}" is not configured in team "${teamName}"`);
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${memberName}" has been removed`);
    }
    if (isLeadMember({ name: configuredMember.name, agentType: configuredMember.agentType })) {
      throw new Error('Lead restart is not supported from member controls');
    }

    const leadMember = config.members?.find((member) => isLeadMember(member));
    const leadProviderId =
      normalizeOptionalTeamProviderId(teamMeta?.providerId) ??
      normalizeOptionalTeamProviderId(leadMember?.providerId);
    if (leadProviderId !== 'opencode') {
      return false;
    }

    const configuredNames = new Set<string>();
    for (const member of config.members ?? []) {
      const name = member.name?.trim();
      if (name) {
        configuredNames.add(name);
      }
    }
    for (const member of metaMembers) {
      const name = member.name?.trim();
      if (name) {
        configuredNames.add(name);
      }
    }

    const activeMembers = [...configuredNames]
      .map((name) => this.resolveEffectiveConfiguredMember(config.members ?? [], metaMembers, name))
      .filter((member): member is NonNullable<EffectiveConfiguredMember | null> => {
        if (!member || member.removedAt) {
          return false;
        }
        return !isLeadMember({ name: member.name, agentType: member.agentType });
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const targetMember = activeMembers.find((member) =>
      matchesExactTeamMemberName(member.name, configuredMember.name)
    );
    if (!targetMember) {
      throw new Error(`Member "${memberName}" is not configured in team "${teamName}"`);
    }

    const nonOpenCodeMember = activeMembers.find((member) => {
      const providerId = normalizeOptionalTeamProviderId(member.providerId) ?? leadProviderId;
      return providerId !== 'opencode';
    });
    if (nonOpenCodeMember) {
      return false;
    }

    const projectPath =
      targetMember.cwd?.trim() ||
      config.projectPath?.trim() ||
      teamMeta?.cwd?.trim() ||
      runtimeRun.cwd?.trim() ||
      this.readPersistedTeamProjectPath(teamName);
    if (!projectPath) {
      throw new Error(`Team "${teamName}" project path is not available for OpenCode restart`);
    }

    const effectiveMembers = await this.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName,
      baseCwd: projectPath,
      leadProviderId: 'opencode',
      members: activeMembers.map((member) => this.buildConfiguredProvisioningMember(member)),
    });
    const targetRuntimeMember = effectiveMembers.find((member) =>
      matchesExactTeamMemberName(member.name, targetMember.name)
    );
    if (!targetRuntimeMember) {
      throw new Error(`Member "${memberName}" could not be resolved for OpenCode restart`);
    }

    this.invalidateRuntimeSnapshotCaches(teamName);
    this.persistOpenCodeMemberRestartSystemMessage({
      teamName,
      leadName: leadMember?.name?.trim() || 'team-lead',
      leadSessionId: runtimeRun.runId,
      displayName: config.description?.trim() || config.name,
      member: targetRuntimeMember,
      reason: 'manual_restart',
    });

    await this.runOpenCodeTeamRuntimeAdapterLaunch({
      request: {
        teamName,
        cwd: projectPath,
        prompt: teamMeta?.prompt?.trim() || '',
        providerId: 'opencode',
        providerBackendId: migrateProviderBackendId('opencode', teamMeta?.providerBackendId),
        model: targetRuntimeMember.model?.trim() || teamMeta?.model,
        effort:
          targetRuntimeMember.effort ??
          (isTeamEffortLevel(teamMeta?.effort) ? teamMeta.effort : undefined),
        fastMode: teamMeta?.fastMode,
        limitContext: teamMeta?.limitContext,
        skipPermissions: teamMeta?.skipPermissions,
        worktree: teamMeta?.worktree,
        extraCliArgs: teamMeta?.extraCliArgs,
      },
      members: effectiveMembers,
      prompt: [
        `Restarting OpenCode teammate "${targetRuntimeMember.name}" by user request.`,
        'This is an app-managed OpenCode-only runtime refresh. Re-establish the team sessions and continue from persisted team context.',
      ].join('\n'),
      sourceWarning:
        'OpenCode-only member restart refreshes the primary OpenCode runtime lane because pure OpenCode teams do not keep a native lead run.',
      onProgress: () => undefined,
    });
    this.invalidateRuntimeSnapshotCaches(teamName);
    return true;
  }

  async retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    const existing = this.failedOpenCodeSecondaryRetryInFlightByTeam.get(teamName);
    if (existing) {
      return existing;
    }

    const seam = this.actionUseCases.retryFailedOpenCodeSecondaryLanes;
    const retry = Promise.resolve()
      .then(() => (seam ? seam(teamName) : this.retryFailedOpenCodeSecondaryLanesNow(teamName)))
      .finally(() => {
        this.failedOpenCodeSecondaryRetryInFlightByTeam.delete(teamName);
      });
    this.failedOpenCodeSecondaryRetryInFlightByTeam.set(teamName, retry);
    return retry;
  }

  private async retryFailedOpenCodeSecondaryLanesNow(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    const run = this.getMutableAliveRunOrThrow(teamName);
    if (this.getProvisioningRunId(teamName)) {
      throw new Error('Team launch is still in progress');
    }

    const result: RetryFailedOpenCodeSecondaryLanesResult = {
      attempted: [],
      confirmed: [],
      pending: [],
      failed: [],
      skipped: [],
    };
    const candidates = await this.collectFailedOpenCodeSecondaryRetryCandidates(run);

    for (const candidate of candidates) {
      if (!this.isCurrentTrackedRun(run) || run.processKilled || run.cancelRequested) {
        result.skipped.push({
          memberName: candidate.memberName,
          reason: 'Team stopped during retry',
        });
        continue;
      }

      try {
        await this.runMemberLifecycleOperation(
          teamName,
          candidate.memberName,
          'opencode_retry',
          () =>
            this.reattachOpenCodeOwnedMemberLaneUnlocked(teamName, candidate.memberName, {
              reason: 'manual_restart',
            })
        );
        result.attempted.push(candidate.memberName);

        const outcome = await this.readOpenCodeSecondaryRetryOutcome(
          run,
          candidate.memberName,
          candidate.laneId
        );
        if (outcome.launchState === 'confirmed_alive') {
          result.confirmed.push(candidate.memberName);
        } else if (outcome.launchState === 'failed_to_start') {
          result.failed.push({
            memberName: candidate.memberName,
            error: outcome.reason ?? 'OpenCode retry failed',
          });
        } else if (outcome.launchState === 'skipped_for_launch') {
          result.skipped.push({
            memberName: candidate.memberName,
            reason: outcome.reason ?? 'Teammate is skipped for this launch',
          });
        } else {
          result.pending.push(candidate.memberName);
        }
      } catch (error) {
        if (this.isMemberLifecycleOperationInProgressError(error)) {
          result.skipped.push({
            memberName: candidate.memberName,
            reason: 'Lifecycle operation already in progress',
          });
        } else {
          result.failed.push({
            memberName: candidate.memberName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    await this.notifyLeadAboutConfirmedOpenCodeRetries(run, result);
    return result;
  }

  private async collectFailedOpenCodeSecondaryRetryCandidates(
    run: ProvisioningRun
  ): Promise<OpenCodeSecondaryRetryCandidate[]> {
    const seam = this.openCodeRetryUseCases.collectFailedOpenCodeSecondaryRetryCandidates;
    if (seam) {
      return await seam(run);
    }
    return await this.collectFailedOpenCodeSecondaryRetryCandidatesInternal(run);
  }

  async collectFailedOpenCodeSecondaryRetryCandidatesInternal(
    run: ProvisioningRun
  ): Promise<OpenCodeSecondaryRetryCandidate[]> {
    return await this.collectFailedOpenCodeSecondaryRetryCandidatesFallback(run);
  }

  private async readOpenCodeSecondaryRetryOutcome(
    run: ProvisioningRun,
    memberName: string,
    laneId: string
  ): Promise<OpenCodeSecondaryRetryOutcome> {
    const seam = this.openCodeRetryUseCases.readOpenCodeSecondaryRetryOutcome;
    if (seam) {
      return await seam(run, memberName, laneId);
    }
    return await this.readOpenCodeSecondaryRetryOutcomeInternal(run, memberName, laneId);
  }

  async readOpenCodeSecondaryRetryOutcomeInternal(
    run: ProvisioningRun,
    memberName: string,
    laneId: string
  ): Promise<OpenCodeSecondaryRetryOutcome> {
    return await this.readOpenCodeSecondaryRetryOutcomeFallback(run, memberName, laneId);
  }

  private async notifyLeadAboutConfirmedOpenCodeRetries(
    run: ProvisioningRun,
    result: RetryFailedOpenCodeSecondaryLanesResult
  ): Promise<void> {
    const seam = this.openCodeRetryUseCases.notifyLeadAboutConfirmedOpenCodeRetries;
    if (seam) {
      await seam(run, result);
      return;
    }
    await this.notifyLeadAboutConfirmedOpenCodeRetriesInternal(run, result);
  }

  async notifyLeadAboutConfirmedOpenCodeRetriesInternal(
    run: ProvisioningRun,
    result: RetryFailedOpenCodeSecondaryLanesResult
  ): Promise<void> {
    if (result.confirmed.length === 0) {
      return;
    }
    const confirmedNames = result.confirmed.map((name) => `@${name}`).join(', ');
    const message = [
      `Системное замечание: повторный запуск OpenCode-тиммейтов подтверждён: ${confirmedNames}.`,
      `Их можно снова считать доступными.`,
    ].join(' ');
    await this.sendMessageToRun(run, message).catch((error: unknown) =>
      logger.warn(
        `[${run.teamName}] failed to send OpenCode retry recovery notice to lead: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    );
  }

  async skipMemberForLaunch(teamName: string, memberName: string): Promise<void> {
    const seam = this.actionUseCases.skipMemberForLaunch;
    if (seam) {
      await seam(teamName, memberName);
      return;
    }
    await this.skipMemberForLaunchInternal(teamName, memberName);
  }

  private async skipMemberForLaunchInternal(teamName: string, memberName: string): Promise<void> {
    const normalizedMemberName = memberName.trim();
    if (!normalizedMemberName) {
      throw new Error('Member name is required');
    }

    const config = await this.readConfigForStrictDecision(teamName);
    if (!config) {
      throw new Error(`Team "${teamName}" configuration is no longer available`);
    }

    let metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>> = [];
    try {
      metaMembers = await this.membersMetaStore.getMembers(teamName);
    } catch {
      metaMembers = [];
    }

    const configuredMember = this.resolveEffectiveConfiguredMember(
      config.members ?? [],
      metaMembers,
      normalizedMemberName
    );
    if (!configuredMember) {
      throw new Error(`Member "${normalizedMemberName}" is not configured in team "${teamName}"`);
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${normalizedMemberName}" has been removed`);
    }
    if (isLeadMember({ name: normalizedMemberName, agentType: configuredMember.agentType })) {
      throw new Error('Lead cannot be skipped for a launch');
    }

    const runId = this.getTrackedRunId(teamName);
    const run = runId ? this.runs.get(runId) : undefined;
    const persistedSnapshot = await this.launchStateStore.read(teamName).catch(() => null);
    const runEntry = run?.memberSpawnStatuses.get(normalizedMemberName);
    const persistedMember = persistedSnapshot?.members[normalizedMemberName];
    const alreadySkipped =
      runEntry?.launchState === 'skipped_for_launch' ||
      runEntry?.skippedForLaunch === true ||
      persistedMember?.launchState === 'skipped_for_launch' ||
      persistedMember?.skippedForLaunch === true;

    if (alreadySkipped) {
      return;
    }

    const failedThisLaunch =
      runEntry?.launchState === 'failed_to_start' ||
      runEntry?.status === 'error' ||
      persistedMember?.launchState === 'failed_to_start' ||
      persistedMember?.hardFailure === true;
    if (!failedThisLaunch) {
      throw new Error(`Member "${normalizedMemberName}" has not failed this launch`);
    }

    if (run?.pendingMemberRestarts.has(normalizedMemberName)) {
      throw new Error(`Restart for teammate "${normalizedMemberName}" is already in progress`);
    }

    const previousFailureReason =
      runEntry?.hardFailureReason ??
      runEntry?.error ??
      persistedMember?.hardFailureReason ??
      persistedMember?.runtimeDiagnostic;
    const reason = previousFailureReason?.trim()
      ? `Skipped by user after launch failure: ${previousFailureReason.trim()}`
      : 'Skipped by user for this launch';

    if (run && !run.processKilled && !run.cancelRequested) {
      this.invalidateRuntimeSnapshotCaches(teamName);
      this.resetRuntimeToolActivity(run, normalizedMemberName);
      this.clearMemberSpawnToolTracking(run, normalizedMemberName);
      this.setMemberSpawnStatus(run, normalizedMemberName, 'skipped', reason);
      if (run.isLaunch) {
        await this.persistLaunchStateSnapshot(
          run,
          run.provisioningComplete ? 'finished' : 'active'
        );
      }

      try {
        await this.sendMessageToRun(
          run,
          `Teammate "${normalizedMemberName}" was skipped for this launch after a startup failure. Continue without waiting for this teammate unless the user retries it.`
        );
      } catch (error) {
        logger.debug(
          `[${teamName}] Failed to notify lead about skipped teammate "${normalizedMemberName}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return;
    }

    if (!persistedSnapshot || !persistedMember) {
      throw new Error(`No launch state is available for member "${normalizedMemberName}"`);
    }

    const updatedAt = nowIso();
    const nextMembers = {
      ...persistedSnapshot.members,
      [normalizedMemberName]: {
        ...persistedMember,
        launchState: 'skipped_for_launch' as const,
        skippedForLaunch: true,
        skipReason: reason,
        skippedAt: updatedAt,
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        hardFailureReason: undefined,
        pendingPermissionRequestIds: undefined,
        livenessKind: undefined,
        runtimeDiagnostic: undefined,
        runtimeDiagnosticSeverity: undefined,
        lastEvaluatedAt: updatedAt,
        diagnostics: [`skipped for this launch: ${reason}`],
      },
    };
    const nextSnapshot = createPersistedLaunchSnapshot({
      teamName: persistedSnapshot.teamName,
      expectedMembers: persistedSnapshot.expectedMembers,
      bootstrapExpectedMembers: persistedSnapshot.bootstrapExpectedMembers,
      leadSessionId: persistedSnapshot.leadSessionId,
      launchPhase: persistedSnapshot.launchPhase,
      members: nextMembers,
      updatedAt,
    });
    await this.writeLaunchStateSnapshot(teamName, nextSnapshot);
  }

  private getMutableAliveRunOrThrow(teamName: string): ProvisioningRun {
    const runId = this.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`Team "${teamName}" is not currently running`);
    }
    const run = this.runs.get(runId);
    if (!run || run.processKilled || run.cancelRequested) {
      throw new Error(`Team "${teamName}" is not currently running`);
    }
    return run;
  }

  async reattachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_updated' | 'manual_restart' }
  ): Promise<void> {
    return this.runMemberLifecycleOperation(
      teamName,
      memberName,
      this.getOpenCodeReattachLifecycleKind(options?.reason),
      () => this.reattachOpenCodeOwnedMemberLaneUnlocked(teamName, memberName, options)
    );
  }

  private async reattachOpenCodeOwnedMemberLaneUnlocked(
    teamName: string,
    memberName: string,
    options?: ReattachOpenCodeOwnedMemberLaneOptions
  ): Promise<void> {
    const seam = this.openCodeRetryUseCases.reattachOpenCodeOwnedMemberLaneUnlocked;
    if (seam) {
      await seam(teamName, memberName, options);
      return;
    }
    await this.reattachOpenCodeOwnedMemberLaneUnlockedInternal(teamName, memberName, options);
  }

  async reattachOpenCodeOwnedMemberLaneUnlockedInternal(
    teamName: string,
    memberName: string,
    options?: ReattachOpenCodeOwnedMemberLaneOptions
  ): Promise<void> {
    const run = this.getMutableAliveRunOrThrow(teamName);
    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    if (leadProviderId === 'opencode' && (run.mixedSecondaryLanes?.length ?? 0) === 0) {
      throw new Error(
        'OpenCode secondary lane reattach requires an active OpenCode worktree lane run.'
      );
    }
    if (!this.getOpenCodeRuntimeAdapter()) {
      throw new Error('OpenCode runtime adapter is not available for controlled lane reattach.');
    }

    const config = await this.readConfigForStrictDecision(teamName);
    if (!config) {
      throw new Error(`Team "${teamName}" configuration is no longer available`);
    }
    let metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>> = [];
    try {
      metaMembers = await this.membersMetaStore.getMembers(teamName);
    } catch {
      metaMembers = [];
    }
    const configuredMember = this.resolveEffectiveConfiguredMember(
      config.members ?? [],
      metaMembers,
      memberName
    );
    if (!configuredMember) {
      throw new Error(`Member "${memberName}" is not configured in team "${teamName}"`);
    }
    if (configuredMember.removedAt) {
      throw new Error(`Member "${memberName}" has been removed`);
    }
    if (isLeadMember({ name: configuredMember.name, agentType: configuredMember.agentType })) {
      throw new Error('Lead lane reattach is not supported');
    }
    const desiredProviderId =
      normalizeOptionalTeamProviderId(configuredMember.providerId) ?? leadProviderId;
    if (desiredProviderId !== 'opencode') {
      throw new Error(
        `Controlled reattach is only supported for OpenCode-owned members. "${memberName}" remains on the primary runtime owner.`
      );
    }

    const [memberSpec] = await this.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName,
      baseCwd: run.request.cwd,
      leadProviderId,
      members: [this.buildConfiguredProvisioningMember(configuredMember)],
    });
    if (!memberSpec) {
      throw new Error(`Member "${memberName}" could not be resolved for OpenCode lane reattach.`);
    }
    const nextLane = this.createMixedSecondaryLaneStateForMember(run, memberSpec);
    const existingLaneIndex = run.mixedSecondaryLanes.findIndex(
      (lane) => lane.laneId === nextLane.laneId || lane.member.name.trim() === memberName
    );
    const existingLane = existingLaneIndex >= 0 ? run.mixedSecondaryLanes[existingLaneIndex] : null;

    if (run.pendingMemberRestarts.has(memberName)) {
      throw new Error(`Restart for teammate "${memberName}" is already in progress`);
    }
    if (existingLane?.state === 'queued' || existingLane?.state === 'launching') {
      throw new Error(`Restart for teammate "${memberName}" is already in progress`);
    }

    const hasRuntimeEvidence = await this.hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch({
      teamName,
      memberName: memberSpec.name,
      laneId: nextLane.laneId,
      existingLane,
    });

    if (existingLane) {
      await this.stopSingleMixedSecondaryRuntimeLane(run, existingLane, 'relaunch');
    }

    const laneState = existingLane ?? nextLane;
    laneState.laneId = nextLane.laneId;
    laneState.member = memberSpec;
    laneState.runId = null;
    laneState.state = 'queued';
    laneState.result = null;
    laneState.warnings = [];
    laneState.diagnostics = [
      ...(options?.reason ? [`controlled_reattach:${options.reason}`] : []),
      ...(!hasRuntimeEvidence ? ['fresh_relaunch:no_runtime_evidence'] : []),
    ];

    if (existingLaneIndex >= 0) {
      run.mixedSecondaryLanes[existingLaneIndex] = laneState;
    } else {
      run.mixedSecondaryLanes.push(laneState);
    }

    this.upsertRunAllEffectiveMember(run, memberSpec);
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    run.pendingMemberRestarts.delete(memberName);

    if (options?.reason === 'manual_restart' || options?.reason === 'member_updated') {
      this.persistOpenCodeMemberRestartSystemMessage({
        teamName,
        leadName: this.getRunLeadName(run),
        leadSessionId: run.detectedSessionId?.trim() || config.leadSessionId?.trim() || run.runId,
        displayName: config.description?.trim() || config.name,
        member: this.buildConfiguredProvisioningMember(configuredMember),
        reason: options.reason,
      });
    }

    await this.launchSingleMixedSecondaryLane(run, laneState);
  }

  private async hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch(params: {
    teamName: string;
    memberName: string;
    laneId: string;
    existingLane: MixedSecondaryRuntimeLaneState | null;
  }): Promise<boolean> {
    const laneResultMember =
      params.existingLane?.result?.members[params.memberName] ??
      Object.values(params.existingLane?.result?.members ?? {}).find(
        (member) => member.memberName?.trim() === params.memberName
      );
    if (hasOpenCodeRuntimeHandle(laneResultMember)) {
      return true;
    }

    const persistedSnapshot = await this.launchStateStore.read(params.teamName).catch(() => null);
    const persistedMember =
      persistedSnapshot?.members[params.memberName] ??
      Object.values(persistedSnapshot?.members ?? {}).find(
        (member) => member.laneId === params.laneId
      );
    if (
      hasOpenCodeRuntimeHandle(persistedMember) ||
      hasOpenCodeRuntimeLivenessMarker(persistedMember)
    ) {
      return true;
    }

    const liveRuntimeByMember = await this.getLiveTeamAgentRuntimeMetadata(params.teamName).catch(
      () => new Map<string, TeamAgentRuntimeEntry>()
    );
    const liveRuntimeMember =
      liveRuntimeByMember.get(params.memberName) ??
      [...liveRuntimeByMember.entries()].find(([candidateName]) =>
        matchesObservedMemberNameForExpected(candidateName, params.memberName)
      )?.[1];
    return hasOpenCodeRuntimeEntryHandle(liveRuntimeMember);
  }

  async detachOpenCodeOwnedMemberLane(teamName: string, memberName: string): Promise<void> {
    return this.runMemberLifecycleOperation(teamName, memberName, 'opencode_member_removed', () =>
      this.detachOpenCodeOwnedMemberLaneUnlocked(teamName, memberName)
    );
  }

  private async detachOpenCodeOwnedMemberLaneUnlocked(
    teamName: string,
    memberName: string
  ): Promise<void> {
    const seam = this.openCodeRetryUseCases.detachOpenCodeOwnedMemberLaneUnlocked;
    if (seam) {
      await seam(teamName, memberName);
      return;
    }
    await this.detachOpenCodeOwnedMemberLaneUnlockedInternal(teamName, memberName);
  }

  async detachOpenCodeOwnedMemberLaneUnlockedInternal(
    teamName: string,
    memberName: string
  ): Promise<void> {
    const run = this.getMutableAliveRunOrThrow(teamName);
    const laneIndex = run.mixedSecondaryLanes.findIndex((lane) =>
      matchesTeamMemberIdentity(lane.member.name, memberName)
    );
    if (laneIndex < 0) {
      this.removeRunAllEffectiveMember(run, memberName);
      this.invalidateRuntimeSnapshotCaches(teamName);
      await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
      return;
    }

    const [lane] = run.mixedSecondaryLanes.splice(laneIndex, 1);
    await this.stopSingleMixedSecondaryRuntimeLane(run, lane, 'cleanup');
    this.removeRunAllEffectiveMember(run, memberName);
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    run.pendingMemberRestarts.delete(memberName);
    await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
  }
}
