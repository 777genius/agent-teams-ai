import type { TeamMcpConfigBuilder } from '../TeamMcpConfigBuilder';
import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type { RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type {
  DirectProcessMemberLaunchReason,
  EffectiveConfiguredMember,
  PersistedRuntimeMemberLike,
  ProvisioningRun,
} from './TeamProvisioningMemberLifecycleTypes';
import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  EffortLevel,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamConfig,
  TeamCreateRequest,
  TeamFastMode,
  TeamLaunchRequest,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

export interface DirectRestartPromptInput {
  teamName: string;
  memberName: string;
  leadName: string;
  leadSessionId: string | null;
  prompt: string;
  operation?: DirectProcessMemberLaunchReason;
}

export interface ProvisioningEnvResolution {
  env: NodeJS.ProcessEnv;
  providerArgs?: string[];
  warning?: string;
}

export interface TeamRuntimeLaunchArgsPlan {
  settingsArgs: string[];
  fastModeArgs: string[];
  runtimeTurnSettledHookArgs: string[];
  providerArgs: string[];
  appManagedSettingsPath: string | null;
}

export interface TeamMetaLike {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  cwd?: string;
  prompt?: string;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
}

export interface TeamProvisioningMemberLifecycleSharedStatePorts {
  runs: Map<string, ProvisioningRun>;
  runtimeAdapterRunByTeam: Map<string, { providerId: TeamProviderId; runId: string; cwd?: string }>;
  failedOpenCodeSecondaryRetryInFlightByTeam: Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >;
}

export interface TeamProvisioningMemberLifecycleStorePorts {
  mcpConfigBuilder: Pick<TeamMcpConfigBuilder, 'writeConfigFile'>;
  membersMetaStore: Pick<TeamMembersMetaStore, 'getMembers'>;
  teamMetaStore: { getMeta(teamName: string): Promise<TeamMetaLike | null> };
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  readPersistedTeamProjectPath(teamName: string): string | null;
}

export interface TeamProvisioningMemberLifecycleLaunchStatePorts {
  launchStateStore: { read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> };
  persistLaunchStateSnapshot(
    run: ProvisioningRun,
    phase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<unknown>;
}

export interface TeamProvisioningMemberLifecycleMemberSpecPorts {
  buildPrimaryOwnedMemberSpecForRuntime(input: {
    configuredMember: EffectiveConfiguredMember;
    run: ProvisioningRun;
  }): TeamCreateRequest['members'][number];
  materializeEffectiveTeamMemberSpecs(input: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: {
      providerId: TeamProviderId;
      model?: string;
      effort?: EffortLevel;
    };
    primaryProviderId: TeamProviderId;
    primaryEnv: ProvisioningEnvResolution;
    teamRuntimeAuth: {
      teamName: string;
      authMaterialId: string;
      allowAnthropicApiKeyHelper: boolean;
    };
  }): Promise<TeamCreateRequest['members']>;
  resolveEffectiveConfiguredMember(
    configMembers: TeamConfig['members'],
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>,
    memberName: string
  ): EffectiveConfiguredMember | null;
  resolveLeadMemberName(
    configMembers: TeamConfig['members'],
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>
  ): string;
  buildConfiguredProvisioningMember(
    member: EffectiveConfiguredMember
  ): TeamCreateRequest['members'][number];
}

export interface TeamProvisioningMemberLifecycleRunTrackingPorts {
  getAliveRunId(teamName: string): string | null;
  getTrackedRunId(teamName: string): string | null;
  getProvisioningRunId(teamName: string): string | null;
}

export interface TeamProvisioningMemberLifecycleRunStatePorts {
  getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null;
  appendMemberBootstrapDiagnostic(run: ProvisioningRun, memberName: string, text: string): void;
  setMemberSpawnStatus(
    run: ProvisioningRun,
    memberName: string,
    status: 'spawning' | 'waiting' | 'online' | 'error' | 'offline' | 'skipped',
    error?: string,
    livenessSource?: 'heartbeat' | 'process',
    heartbeatAt?: string
  ): void;
  upsertRunAllEffectiveMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): void;
  removeRunAllEffectiveMember(run: ProvisioningRun, memberName: string): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  resetRuntimeToolActivity(run: ProvisioningRun, memberName?: string): void;
  clearMemberSpawnToolTracking(run: ProvisioningRun, memberName: string): void;
  isCurrentTrackedRun(run: ProvisioningRun): boolean;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
}

export interface TeamProvisioningMemberLifecycleRuntimeLaunchPorts {
  buildProvisioningEnv(
    providerId: TeamProviderId,
    providerBackendId: TeamProviderBackendId | undefined,
    options: {
      teamRuntimeAuth: {
        teamName: string;
        authMaterialId: string;
        allowAnthropicApiKeyHelper: boolean;
      };
    }
  ): Promise<ProvisioningEnvResolution>;
  resolveDirectMemberLaunchIdentity(input: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    provisioningEnv: ProvisioningEnvResolution;
    memberSpec: TeamCreateRequest['members'][number];
    run: ProvisioningRun;
  }): Promise<ProviderModelLaunchIdentity | null>;
  buildTeamRuntimeLaunchArgsPlan(input: {
    teamName: string;
    providerId: TeamProviderId;
    launchIdentity: ProviderModelLaunchIdentity | null;
    envResolution: ProvisioningEnvResolution;
    extraArgs: string[];
    includeAnthropicHelper: boolean;
    contextLabel: string;
  }): Promise<TeamRuntimeLaunchArgsPlan>;
  buildTrackedMemberMcpLaunchConfig(input: {
    cwd: string;
    mcpPolicy: TeamCreateRequest['members'][number]['mcpPolicy'];
    run: ProvisioningRun;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null>;
  removeTrackedMemberMcpLaunchConfig(
    run: ProvisioningRun,
    config: RuntimeBootstrapMemberMcpLaunchConfig | null
  ): Promise<void>;
  sendMessageToRun(run: ProvisioningRun, message: string): Promise<unknown>;
}

export interface TeamProvisioningMemberLifecycleMessagingPorts {
  persistInboxMessage(teamName: string, memberName: string, message: Record<string, unknown>): void;
  persistSentMessage(teamName: string, message: Record<string, unknown>): void;
  enqueueDirectRestartPrompt?(input: DirectRestartPromptInput): void;
}

export interface TeamProvisioningMemberLifecycleOpenCodeRuntimePorts {
  getOpenCodeRuntimeAdapter(): unknown | null;
  resolveOpenCodeMemberWorkspacesForRuntime(input: {
    teamName: string;
    baseCwd: string;
    leadProviderId: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']>;
  runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: unknown) => void;
  }): Promise<unknown>;
}

export interface TeamProvisioningMemberLifecycleMixedSecondaryRuntimePorts {
  createMixedSecondaryLaneStateForMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState;
  stopSingleMixedSecondaryRuntimeLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: 'cleanup' | 'relaunch'
  ): Promise<void>;
  getRunLeadName(run: ProvisioningRun): string;
  launchSingleMixedSecondaryLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase;
}

export interface TeamProvisioningMemberLifecycleHost
  extends
    TeamProvisioningMemberLifecycleSharedStatePorts,
    TeamProvisioningMemberLifecycleStorePorts,
    TeamProvisioningMemberLifecycleLaunchStatePorts,
    TeamProvisioningMemberLifecycleMemberSpecPorts,
    TeamProvisioningMemberLifecycleRunTrackingPorts,
    TeamProvisioningMemberLifecycleRunStatePorts,
    TeamProvisioningMemberLifecycleRuntimeLaunchPorts,
    TeamProvisioningMemberLifecycleMessagingPorts,
    TeamProvisioningMemberLifecycleOpenCodeRuntimePorts,
    TeamProvisioningMemberLifecycleMixedSecondaryRuntimePorts {}
