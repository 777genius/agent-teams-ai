import {
  resolveWorkspaceTrustFeatureFlags,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import { parseCliArgs } from '@shared/utils/cliArgsParser';

import { ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS } from '../../runtime/anthropicTeamApiKeyHelper';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import {
  applyDesktopTeammateModeDecisionToEnv,
  resolveDesktopTeammateModeDecision,
} from '../runtimeTeammateMode';

import {
  type AnthropicApiKeyHelperCleanupRetryOwner,
  type AnthropicApiKeyHelperMaterialCleanup,
  type AnthropicApiKeyHelperSetupLease,
  createAnthropicApiKeyHelperSetupLease,
  throwIfAnthropicApiKeyHelperCleanupRemainsSourceOwned,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import { ensureCwdExists } from './TeamProvisioningAsyncUtils';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  assertOpenCodeNotLaunchedThroughLegacyProvisioning,
  buildLargeDeterministicBootstrapWarning,
  getMixedLaunchFallbackRecoveryError,
  type TeamLaunchCompatibilityReport,
} from './TeamProvisioningLaunchCompatibility';
import {
  buildLaunchContinuationRosterFingerprint,
  buildRedactedLaunchMaterialDigest,
  type DeterministicLaunchContinuation,
  type DurableLaunchContinuationEvidenceRead,
  type LaunchContinuationSourceSnapshot,
  resolveDeterministicLaunchContinuation,
} from './TeamProvisioningLaunchContinuationEvidence';
import {
  probeLaunchCompatibility,
  resolveLaunchExpectedMembersFromCompatibility,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from './TeamProvisioningLaunchExpectedMembers';
import {
  buildDeterministicLaunchProcessArgs,
  buildLaunchSyntheticRequest,
  type ExistingLaunchRunLike,
  type LaunchRosterSource,
  parseLaunchConfigProjectPath,
  resolveExistingLaunchRunReuse,
} from './TeamProvisioningLaunchTeamFlow';
import { teamRequestIncludesCodexMember } from './TeamProvisioningMemberSpecs';
import { APP_TEAM_RUNTIME_DISALLOWED_TOOLS } from './TeamProvisioningRunModel';
import { buildMissingCliError } from './TeamProvisioningRuntimeFailureLabels';
import {
  filterOutSettingsPathArgs,
  getTeamsBasePathsToProbe,
  type TeamRuntimeLaunchArgsPlan,
  type TeamsBaseLocation,
} from './TeamProvisioningRuntimeLaunchSelection';
import {
  buildRuntimeTurnSettledEnvironmentForMembers,
  type RuntimeTurnSettledEnvironmentProvider,
} from './TeamProvisioningRuntimeTurnSettledPlanning';
import {
  collectWorkspaceTrustProviders,
  collectWorkspaceTrustWorkspaces,
  createDefaultModelWorkspaceTrustProviderArgsResolver,
  planWorkspaceTrustArgsOnlySafely,
  planWorkspaceTrustFullSafely,
  type WorkspaceTrustWorkspaceCollectionPorts,
} from './TeamProvisioningWorkspaceTrust';
import { buildWorkspaceTrustLaunchArgs } from './TeamProvisioningWorkspaceTrustLaunchArgs';

import type { NativeAppManagedBootstrapBuildResult } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import type { PreparedMcpConfig } from '../TeamMcpConfigBuilder';
import type { PreparedRuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type {
  CrossProviderMemberArgsResult,
  ProvisioningEnvResolution,
  TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamTask,
} from '@shared/types';

export interface PreparedDeterministicLaunchMaterial {
  existingTasks: TeamTask[];
  nativeBootstrapBuild: NativeAppManagedBootstrapBuildResult;
  runtimeArgsPlan: TeamRuntimeLaunchArgsPlan;
  teammateModeDecision: { injectedTeammateMode: 'tmux' | null };
  sourceSnapshot: LaunchContinuationSourceSnapshot;
  finalArgvTemplate: string[];
  disallowedTools: string;
  leadMcpConfig: PreparedMcpConfig;
  memberMcpLaunchConfigs: ReadonlyMap<string, PreparedRuntimeBootstrapMemberMcpLaunchConfig>;
}

function replacePreparedMaterialPaths(value: unknown, pathsToReplace: readonly string[]): unknown {
  if (typeof value === 'string') {
    return pathsToReplace.reduce(
      (result, materialPath) => result.split(materialPath).join('<app-managed-launch-material>'),
      value
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replacePreparedMaterialPaths(entry, pathsToReplace));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      replacePreparedMaterialPaths(entry, pathsToReplace),
    ])
  );
}

export interface DeterministicLaunchSetupLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface DeterministicLaunchSetupPorts<TMixedSecondaryLane> {
  readTeamConfigRaw(teamName: string): Promise<string | null>;
  getExistingAliveRunId(teamName: string): string | null;
  getExistingRun(runId: string): ExistingLaunchRunLike | null | undefined;
  getRunTrackedCwd(run: ExistingLaunchRunLike | null | undefined): string | null;
  deleteProvisioningRunByTeam(teamName: string): void;
  readLaunchContinuationEvidence(teamName: string): Promise<DurableLaunchContinuationEvidenceRead>;
  launchExpectedMembersPorts: TeamProvisioningLaunchExpectedMembersPorts;
  materializeLaunchCompatibilityRepair(
    request: TeamLaunchRequest,
    report: TeamLaunchCompatibilityReport
  ): Promise<void>;
  normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void>;
  assertConfigLeadOnlyForLaunch(teamName: string): Promise<void>;
  updateConfigProjectPath(teamName: string, cwd: string): Promise<void>;
  restorePrelaunchConfig(teamName: string): Promise<void>;
  resolveClaudePath(): Promise<string | null>;
  buildProvisioningEnv(
    providerId: TeamProviderId | undefined,
    providerBackendId: TeamLaunchRequest['providerBackendId'],
    options: { includeCodexTeammateAuth: boolean; teamRuntimeAuth: TeamRuntimeAuthContext }
  ): Promise<ProvisioningEnvResolution>;
  workspaceTrustCoordinator: WorkspaceTrustCoordinator | null;
  workspaceTrustWorkspaceCollectionPorts: WorkspaceTrustWorkspaceCollectionPorts;
  materializeEffectiveTeamMemberSpecs(params: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: {
      providerId?: TeamProviderId;
      providerBackendId?: TeamCreateRequest['providerBackendId'];
      model?: string;
      effort?: TeamCreateRequest['effort'];
    };
    primaryProviderId?: TeamProviderId;
    primaryEnv?: ProvisioningEnvResolution;
    teamRuntimeAuth?: TeamRuntimeAuthContext;
    limitContext?: boolean;
    providerArgsResolver?: (input: {
      providerId: TeamProviderId;
      providerArgs: string[];
      phase: 'default-model-resolution';
    }) => string[];
  }): Promise<TeamCreateRequest['members']>;
  resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']>;
  runtimeTurnSettledEnvironmentProvider?: RuntimeTurnSettledEnvironmentProvider | null;
  planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan;
  createMixedSecondaryLaneStates(plan: TeamRuntimeLanePlan): TMixedSecondaryLane[];
  buildCrossProviderMemberArgs(
    primaryProviderId: TeamProviderId,
    memberSpecs: TeamCreateRequest['members'],
    options: { teamRuntimeAuth: TeamRuntimeAuthContext }
  ): Promise<CrossProviderMemberArgsResult>;
  resolveAndValidateLaunchIdentity(params: {
    claudePath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    request: Pick<
      TeamCreateRequest,
      'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
    >;
    effectiveMembers: TeamCreateRequest['members'];
    providerArgsByProvider?: Map<TeamProviderId, string[]>;
  }): Promise<ProviderModelLaunchIdentity>;
  readTasks(teamName: string): Promise<TeamTask[]>;
  buildNativeAppManagedBootstrapSpecsWithDiagnostics(input: {
    teamName: string;
    cwd: string;
    members: TeamCreateRequest['members'];
  }): Promise<NativeAppManagedBootstrapBuildResult>;
  buildTeamRuntimeLaunchArgsPlan(input: {
    teamName: string;
    providerId: TeamProviderId;
    launchIdentity: ProviderModelLaunchIdentity;
    envResolution: ProvisioningEnvResolution;
    extraArgs: string[];
    inheritedProviderArgs: string[];
    includeAnthropicHelper: boolean;
    contextLabel: string;
  }): Promise<TeamRuntimeLaunchArgsPlan>;
  resolveDesktopTeammateModeDecision: typeof resolveDesktopTeammateModeDecision;
  snapshotLaunchMaterialSources(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
    shellEnv: NodeJS.ProcessEnv;
    launchArgs: string[];
    credentialDigestKey: string;
  }): Promise<LaunchContinuationSourceSnapshot>;
  getCredentialDigestKey(allowCreate: boolean): Promise<string>;
  prepareLeadMcpConfig(input: {
    cwd: string;
    controlApiBaseUrl?: string | null;
  }): Promise<PreparedMcpConfig>;
  prepareRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
    controlApiBaseUrl?: string | null;
  }): Promise<ReadonlyMap<string, PreparedRuntimeBootstrapMemberMcpLaunchConfig>>;
  randomUUID(): string;
  nowIso(): string;
  logger: DeterministicLaunchSetupLogger;
  cleanupAnthropicApiKeyHelperMaterial?: AnthropicApiKeyHelperMaterialCleanup;
  anthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner;
}

export type DeterministicLaunchSetupResult<TMixedSecondaryLane> =
  | { kind: 'reuse'; runId: string }
  | { kind: 'complete'; runId: string }
  | {
      kind: 'prepared';
      teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
      runId: string;
      startedAt: string;
      claudePath: string;
      shellEnv: NodeJS.ProcessEnv;
      provisioningEnv: ProvisioningEnvResolution;
      workspaceTrustFeatureFlags: WorkspaceTrustFeatureFlags;
      workspaceTrustFullPlan: WorkspaceTrustFullPlanResult | null;
      resolvedProviderId: TeamProviderId;
      providerArgsForLaunch: string[];
      crossProviderMemberArgsForLaunch: CrossProviderMemberArgsResult;
      expectedMembers: string[];
      launchRosterFingerprint: `sha256:${string}`;
      launchContinuation?: DeterministicLaunchContinuation;
      effectiveMemberSpecs: TeamCreateRequest['members'];
      allEffectiveMemberSpecs: TeamCreateRequest['members'];
      launchIdentity: ProviderModelLaunchIdentity;
      preparedLaunchMaterial: PreparedDeterministicLaunchMaterial;
      syntheticRequest: TeamCreateRequest;
      mixedSecondaryLanes: TMixedSecondaryLane[];
      initialLaunchWarnings: string[];
      initialLaunchWarningSource: LaunchRosterSource;
      anthropicApiKeyHelperLease: AnthropicApiKeyHelperSetupLease;
      credentialDigestKey: string;
    };

export async function prepareDeterministicLaunchSetup<TMixedSecondaryLane>(
  request: TeamLaunchRequest,
  ports: DeterministicLaunchSetupPorts<TMixedSecondaryLane>
): Promise<DeterministicLaunchSetupResult<TMixedSecondaryLane>> {
  const configRaw = await ports.readTeamConfigRaw(request.teamName);
  if (!configRaw) {
    throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
  }
  const configProjectPath = parseLaunchConfigProjectPath(configRaw);

  const existingAliveRunId = ports.getExistingAliveRunId(request.teamName);
  const existingRun = existingAliveRunId ? ports.getExistingRun(existingAliveRunId) : null;
  const existingRunReuse = resolveExistingLaunchRunReuse({
    teamName: request.teamName,
    cwd: request.cwd,
    existingAliveRunId,
    existingRun,
    existingRunCwd: ports.getRunTrackedCwd(existingRun),
    configProjectPath,
  });
  if (existingRunReuse.kind === 'blocked') {
    ports.deleteProvisioningRunByTeam(request.teamName);
    throw new Error(existingRunReuse.message);
  }
  if (existingRunReuse.kind === 'reuse') {
    ports.deleteProvisioningRunByTeam(request.teamName);
    return { kind: 'reuse', runId: existingRunReuse.runId };
  }

  const launchContinuationEvidenceRead = await ports.readLaunchContinuationEvidence(
    request.teamName
  );
  const credentialDigestKey = await ports.getCredentialDigestKey(
    launchContinuationEvidenceRead.kind === 'absent'
  );
  const launchCompatibility = await probeLaunchCompatibility(
    {
      teamName: request.teamName,
      configRaw,
      leadProviderId: request.providerId,
    },
    ports.launchExpectedMembersPorts
  );
  if (launchCompatibility.level === 'unsafe') {
    ports.deleteProvisioningRunByTeam(request.teamName);
    throw new Error(launchCompatibility.blockers[0] ?? getMixedLaunchFallbackRecoveryError());
  }
  if (launchCompatibility.repairAction === 'materialize-members-meta') {
    await ports.materializeLaunchCompatibilityRepair(request, launchCompatibility);
  }
  const {
    members: expectedMemberSpecs,
    source,
    warning,
  } = resolveLaunchExpectedMembersFromCompatibility(launchCompatibility);
  assertOpenCodeNotLaunchedThroughLegacyProvisioning({
    providerId: request.providerId,
    members: expectedMemberSpecs,
  });
  if (request.clearContext) {
    ports.logger.info(
      `[${request.teamName}] clearContext requested - starting fresh deterministic bootstrap session`
    );
  } else {
    ports.logger.info(
      `[${request.teamName}] Starting fresh deterministic bootstrap session because ` +
        `--team-bootstrap-spec cannot be combined with --resume`
    );
  }

  try {
    await ports.normalizeTeamConfigForLaunch(request.teamName, configRaw);
    await ports.assertConfigLeadOnlyForLaunch(request.teamName);
    await ports.updateConfigProjectPath(request.teamName, request.cwd);
  } catch (error) {
    await ports.restorePrelaunchConfig(request.teamName);
    throw error;
  }

  let claudePath: string | null;
  try {
    await ensureCwdExists(request.cwd);

    claudePath = await ports.resolveClaudePath();
    if (!claudePath) {
      throw buildMissingCliError();
    }
  } catch (error) {
    await ports.restorePrelaunchConfig(request.teamName);
    throw error;
  }

  const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
  // A roster-authorized launch uses the transaction UUID as its command/run
  // identity so restart recovery can query the existing read-only run ledger.
  const runId = request.rosterTransactionId ?? ports.randomUUID();
  const startedAt = ports.nowIso();
  const anthropicApiKeyHelperLease = createAnthropicApiKeyHelperSetupLease(
    ports.cleanupAnthropicApiKeyHelperMaterial
  );
  const teamRuntimeAuth: TeamRuntimeAuthContext = {
    teamName: request.teamName,
    authMaterialId: runId,
    allowAnthropicApiKeyHelper: true,
    anthropicApiKeyHelperLease,
    credentialIdentityKey: credentialDigestKey,
  };

  try {
    const provisioningEnv = await ports.buildProvisioningEnv(
      request.providerId,
      request.providerBackendId,
      { includeCodexTeammateAuth: teamRequestIncludesCodexMember(request), teamRuntimeAuth }
    );
    anthropicApiKeyHelperLease.coalesce(provisioningEnv.anthropicApiKeyHelper);
    const { env: shellEnv, providerArgs = [], warning: envWarning } = provisioningEnv;
    if (envWarning) {
      throw new Error(envWarning);
    }
    const workspaceTrustFeatureFlags = resolveWorkspaceTrustFeatureFlags();
    const workspaceTrustProviders = workspaceTrustFeatureFlags.enabled
      ? collectWorkspaceTrustProviders({
          leadProviderId: request.providerId,
          members: expectedMemberSpecs,
        })
      : [];
    const workspaceTrustEarlyWorkspaces = workspaceTrustFeatureFlags.enabled
      ? await collectWorkspaceTrustWorkspaces({
          cwd: request.cwd,
          members: [],
          ports: ports.workspaceTrustWorkspaceCollectionPorts,
        })
      : [];
    const workspaceTrustEarlyPlan = workspaceTrustFeatureFlags.enabled
      ? await planWorkspaceTrustArgsOnlySafely({
          coordinator: ports.workspaceTrustCoordinator,
          request: {
            providers: workspaceTrustProviders,
            workspaces: workspaceTrustEarlyWorkspaces,
            targetSurfaces: ['default_model_probe'],
            featureFlags: workspaceTrustFeatureFlags,
          },
        })
      : { launchArgPatches: [] };
    const workspaceTrustProviderArgsResolver =
      createDefaultModelWorkspaceTrustProviderArgsResolver(workspaceTrustEarlyPlan);

    const materializedMemberSpecs = await ports.materializeEffectiveTeamMemberSpecs({
      claudePath,
      cwd: request.cwd,
      members: expectedMemberSpecs,
      defaults: {
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
      },
      primaryProviderId: request.providerId,
      primaryEnv: provisioningEnv,
      teamRuntimeAuth,
      limitContext: request.limitContext,
      providerArgsResolver: workspaceTrustProviderArgsResolver,
    });
    const allEffectiveMemberSpecs = await ports.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: request.teamName,
      baseCwd: request.cwd,
      leadProviderId: request.providerId,
      members: materializedMemberSpecs,
    });
    Object.assign(
      shellEnv,
      await buildRuntimeTurnSettledEnvironmentForMembers(
        {
          primaryProviderId: request.providerId,
          memberSpecs: allEffectiveMemberSpecs,
        },
        {
          environmentProvider: ports.runtimeTurnSettledEnvironmentProvider,
          logger: ports.logger,
        }
      )
    );
    const lanePlan = ports.planRuntimeLanesOrThrow(
      request.providerId,
      allEffectiveMemberSpecs,
      request.cwd
    );
    const primaryMemberNames = new Set(lanePlan.primaryMembers.map((member) => member.name));
    const fullEffectiveMemberSpecs = allEffectiveMemberSpecs.filter((member) =>
      primaryMemberNames.has(member.name)
    );
    assertDeterministicBootstrapPrimaryMemberLimit(fullEffectiveMemberSpecs.length);
    const largeTeamWarning = buildLargeDeterministicBootstrapWarning(
      fullEffectiveMemberSpecs.length
    );
    const initialLaunchWarnings = [warning, largeTeamWarning].filter((value): value is string =>
      Boolean(value)
    );
    const resolvedProviderId = resolveTeamProviderId(request.providerId);
    const crossProviderMemberArgs = await ports.buildCrossProviderMemberArgs(
      resolvedProviderId,
      fullEffectiveMemberSpecs,
      { teamRuntimeAuth }
    );
    anthropicApiKeyHelperLease.coalesce(crossProviderMemberArgs.anthropicApiKeyHelper);
    const workspaceTrustFullWorkspaces = workspaceTrustFeatureFlags.enabled
      ? await collectWorkspaceTrustWorkspaces({
          cwd: request.cwd,
          members: allEffectiveMemberSpecs,
          ports: ports.workspaceTrustWorkspaceCollectionPorts,
        })
      : [];
    const workspaceTrustFullPlan = workspaceTrustFeatureFlags.enabled
      ? await planWorkspaceTrustFullSafely({
          coordinator: ports.workspaceTrustCoordinator,
          request: {
            providers: collectWorkspaceTrustProviders({
              leadProviderId: request.providerId,
              members: allEffectiveMemberSpecs,
            }),
            workspaces: workspaceTrustFullWorkspaces,
            featureFlags: workspaceTrustFeatureFlags,
          },
        })
      : null;
    const workspaceTrustPatches = workspaceTrustFullPlan?.launchArgPatches ?? [];
    const { providerArgsForLaunch, crossProviderMemberArgsForLaunch, providerArgsByProvider } =
      buildWorkspaceTrustLaunchArgs({
        providerArgs,
        resolvedProviderId,
        crossProviderMemberArgs,
        workspaceTrustPatches,
      });
    Object.assign(shellEnv, crossProviderMemberArgs.envPatch);
    if (crossProviderMemberArgs.usesAnthropicApiKeyHelper) {
      for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
        delete shellEnv[key];
      }
    }
    const launchIdentity = await ports.resolveAndValidateLaunchIdentity({
      claudePath,
      cwd: request.cwd,
      env: shellEnv,
      request,
      effectiveMembers: fullEffectiveMemberSpecs,
      providerArgsByProvider,
    });
    const existingTasks = await ports.readTasks(request.teamName);
    const nativeBootstrapBuild = await ports.buildNativeAppManagedBootstrapSpecsWithDiagnostics({
      teamName: request.teamName,
      cwd: request.cwd,
      members: fullEffectiveMemberSpecs,
    });
    const runtimeArgsPlan = await ports.buildTeamRuntimeLaunchArgsPlan({
      teamName: request.teamName,
      providerId: resolvedProviderId,
      launchIdentity,
      envResolution: { ...provisioningEnv, providerArgs: providerArgsForLaunch },
      extraArgs: parseCliArgs(request.extraCliArgs),
      inheritedProviderArgs: crossProviderMemberArgsForLaunch.args,
      includeAnthropicHelper: resolvedProviderId === 'anthropic',
      contextLabel: 'Team launch',
    });
    const teammateModeDecision = await ports.resolveDesktopTeammateModeDecision(
      request.extraCliArgs,
      shellEnv
    );
    applyDesktopTeammateModeDecisionToEnv(shellEnv, teammateModeDecision);
    const leadMcpConfig = await ports.prepareLeadMcpConfig({
      cwd: request.cwd,
      controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
    });
    const memberMcpLaunchConfigs = await ports.prepareRuntimeBootstrapMemberMcpLaunchConfigs({
      cwd: request.cwd,
      members: allEffectiveMemberSpecs,
      controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
    });
    const finalArgvTemplate = buildDeterministicLaunchProcessArgs({
      mcpConfigPath: '<prepared-mcp-config>',
      bootstrapSpecPath: '<prepared-bootstrap-spec>',
      bootstrapUserPromptPath: '<prepared-bootstrap-prompt>',
      skipPermissions: request.skipPermissions,
      worktree: request.worktree,
      providerId: resolvedProviderId,
      model: request.model,
      launchIdentity,
      runtimeArgsPlan,
      teammateModeDecision,
      disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
    });
    const appManagedMaterialPaths = [
      provisioningEnv.anthropicApiKeyHelper?.directory,
      provisioningEnv.anthropicApiKeyHelper?.helperPath,
      provisioningEnv.anthropicApiKeyHelper?.keyPath,
      provisioningEnv.anthropicApiKeyHelper?.settingsPath,
      crossProviderMemberArgsForLaunch.anthropicApiKeyHelper?.directory,
      crossProviderMemberArgsForLaunch.anthropicApiKeyHelper?.helperPath,
      crossProviderMemberArgsForLaunch.anthropicApiKeyHelper?.keyPath,
      crossProviderMemberArgsForLaunch.anthropicApiKeyHelper?.settingsPath,
      runtimeArgsPlan.appManagedSettingsPath,
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length);
    let externalLaunchArgs = [
      ...providerArgsForLaunch,
      ...crossProviderMemberArgsForLaunch.args,
      ...parseCliArgs(request.extraCliArgs),
    ];
    for (const materialPath of appManagedMaterialPaths) {
      externalLaunchArgs = filterOutSettingsPathArgs(externalLaunchArgs, materialPath);
    }
    const sourceSnapshot = await ports.snapshotLaunchMaterialSources({
      cwd: request.cwd,
      members: allEffectiveMemberSpecs,
      shellEnv,
      launchArgs: externalLaunchArgs,
      credentialDigestKey,
    });
    const nativeBootstrapIdentity = [...nativeBootstrapBuild.specs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => ({
        name,
        schemaVersion: spec.schemaVersion,
        mode: spec.mode,
        contextHash: spec.contextHash,
        briefingHash: spec.briefingHash,
      }));
    const normalizedProviderAuthority = replacePreparedMaterialPaths(
      {
        authSource: provisioningEnv.authSource,
        anthropicCredentialIdentity: provisioningEnv.anthropicCredentialIdentity,
        providerArgsForLaunch,
        crossProviderMemberArgsForLaunch: {
          ...crossProviderMemberArgsForLaunch,
          providerArgsByProvider: [
            ...crossProviderMemberArgsForLaunch.providerArgsByProvider.entries(),
          ].sort(([left], [right]) => left.localeCompare(right)),
        },
        launchIdentity,
        allEffectiveMemberSpecs,
      },
      appManagedMaterialPaths
    );
    const finalizedLaunchMaterial = {
      providerPluginProfileAuthorityDigest: buildRedactedLaunchMaterialDigest(
        normalizedProviderAuthority,
        credentialDigestKey
      ),
      settingsAndMcpSourceDigest: sourceSnapshot.digest,
      mcpBootstrapInputDigest: buildRedactedLaunchMaterialDigest(
        {
          leadMcpConfig,
          memberMcpLaunchConfigs: [...memberMcpLaunchConfigs.entries()].sort(([left], [right]) =>
            left.localeCompare(right)
          ),
        },
        credentialDigestKey
      ),
      nativeBootstrapDigest: buildRedactedLaunchMaterialDigest(
        nativeBootstrapIdentity,
        credentialDigestKey
      ),
      workspaceTrustPatchDigest: buildRedactedLaunchMaterialDigest(
        workspaceTrustFullPlan?.launchArgPatches ?? [],
        credentialDigestKey
      ),
      runtimeArgsPlanDigest: buildRedactedLaunchMaterialDigest(
        replacePreparedMaterialPaths(runtimeArgsPlan, appManagedMaterialPaths),
        credentialDigestKey
      ),
      runtimeEnvironmentDigest: buildRedactedLaunchMaterialDigest(
        replacePreparedMaterialPaths(shellEnv, appManagedMaterialPaths),
        credentialDigestKey
      ),
      finalArgvDigest: buildRedactedLaunchMaterialDigest(
        replacePreparedMaterialPaths(finalArgvTemplate, appManagedMaterialPaths),
        credentialDigestKey
      ),
      taskBootstrapDigest: buildRedactedLaunchMaterialDigest(existingTasks, credentialDigestKey),
    };
    const launchRosterFingerprint = buildLaunchContinuationRosterFingerprint({
      request,
      materializedMemberSpecs: allEffectiveMemberSpecs,
      launchIdentity,
      runtimeLanePlan: lanePlan,
      finalizedLaunchMaterial,
      credentialDigestKey,
    });
    const launchContinuationDecision = resolveDeterministicLaunchContinuation({
      teamName: request.teamName,
      expectedMemberNames: expectedMemberSpecs.map((member) => member.name),
      rosterFingerprint: launchRosterFingerprint,
      evidenceRead: launchContinuationEvidenceRead,
    });
    if (launchContinuationDecision.kind === 'complete') {
      await anthropicApiKeyHelperLease.cleanup();
      await ports.restorePrelaunchConfig(request.teamName);
      ports.deleteProvisioningRunByTeam(request.teamName);
      return { kind: 'complete', runId: launchContinuationDecision.sourceRunId };
    }
    const continuationRetryNames =
      launchContinuationDecision.kind === 'continue'
        ? new Set(launchContinuationDecision.continuation.retryMembers.map((member) => member.name))
        : null;
    const effectiveMemberSpecs = continuationRetryNames
      ? fullEffectiveMemberSpecs.filter((member) => continuationRetryNames.has(member.name))
      : fullEffectiveMemberSpecs;
    if (continuationRetryNames && effectiveMemberSpecs.length !== continuationRetryNames.size) {
      throw new Error(
        'Deterministic partial-launch continuation retry roster no longer matches the primary runtime lane'
      );
    }
    const expectedMembers = effectiveMemberSpecs.map((member) => member.name);

    const syntheticRequest = buildLaunchSyntheticRequest({
      request,
      members: allEffectiveMemberSpecs,
      configRaw,
    });

    return {
      kind: 'prepared',
      teamsBasePathsToProbe,
      runId,
      startedAt,
      claudePath,
      shellEnv,
      provisioningEnv,
      workspaceTrustFeatureFlags,
      workspaceTrustFullPlan,
      resolvedProviderId,
      providerArgsForLaunch,
      crossProviderMemberArgsForLaunch,
      expectedMembers,
      launchRosterFingerprint,
      ...(launchContinuationDecision.kind === 'continue'
        ? { launchContinuation: launchContinuationDecision.continuation }
        : {}),
      effectiveMemberSpecs,
      allEffectiveMemberSpecs,
      launchIdentity,
      preparedLaunchMaterial: {
        existingTasks,
        nativeBootstrapBuild,
        runtimeArgsPlan,
        teammateModeDecision,
        sourceSnapshot,
        finalArgvTemplate,
        disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        leadMcpConfig,
        memberMcpLaunchConfigs,
      },
      credentialDigestKey,
      syntheticRequest,
      mixedSecondaryLanes: ports.createMixedSecondaryLaneStates(lanePlan),
      initialLaunchWarnings,
      initialLaunchWarningSource: source,
      anthropicApiKeyHelperLease,
    };
  } catch (error) {
    let cleanupOwnershipError: unknown = null;
    try {
      await anthropicApiKeyHelperLease.cleanup();
    } catch {
      const retention = await ports.anthropicApiKeyHelperCleanupRetryOwner.retainSetupLease(
        anthropicApiKeyHelperLease
      );
      try {
        throwIfAnthropicApiKeyHelperCleanupRemainsSourceOwned(retention, error);
      } catch (ownershipError) {
        cleanupOwnershipError = ownershipError;
      }
    }
    await ports.restorePrelaunchConfig(request.teamName).catch(() => undefined);
    throw cleanupOwnershipError ?? error;
  }
}
