import {
  resolveWorkspaceTrustFeatureFlags,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';

import { ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS } from '../../runtime/anthropicTeamApiKeyHelper';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

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
  probeLaunchCompatibility,
  resolveLaunchExpectedMembersFromCompatibility,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from './TeamProvisioningLaunchExpectedMembers';
import {
  buildLaunchSyntheticRequest,
  type ExistingLaunchRunLike,
  type LaunchRosterSource,
  parseLaunchConfigProjectPath,
  resolveExistingLaunchRunReuse,
} from './TeamProvisioningLaunchTeamFlow';
import { teamRequestIncludesCodexMember } from './TeamProvisioningMemberSpecs';
import { buildMissingCliError } from './TeamProvisioningRuntimeFailureLabels';
import {
  getTeamsBasePathsToProbe,
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
} from '@shared/types';

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
  randomUUID(): string;
  nowIso(): string;
  logger: DeterministicLaunchSetupLogger;
  cleanupAnthropicApiKeyHelperMaterial?: AnthropicApiKeyHelperMaterialCleanup;
  anthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner;
}

export type DeterministicLaunchSetupResult<TMixedSecondaryLane> =
  | { kind: 'reuse'; runId: string }
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
      effectiveMemberSpecs: TeamCreateRequest['members'];
      allEffectiveMemberSpecs: TeamCreateRequest['members'];
      launchIdentity: ProviderModelLaunchIdentity;
      syntheticRequest: TeamCreateRequest;
      mixedSecondaryLanes: TMixedSecondaryLane[];
      initialLaunchWarnings: string[];
      initialLaunchWarningSource: LaunchRosterSource;
      anthropicApiKeyHelperLease: AnthropicApiKeyHelperSetupLease;
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
  const runId = ports.randomUUID();
  const startedAt = ports.nowIso();
  const anthropicApiKeyHelperLease = createAnthropicApiKeyHelperSetupLease(
    ports.cleanupAnthropicApiKeyHelperMaterial
  );
  const teamRuntimeAuth: TeamRuntimeAuthContext = {
    teamName: request.teamName,
    authMaterialId: runId,
    allowAnthropicApiKeyHelper: true,
    anthropicApiKeyHelperLease,
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
    const effectiveMemberSpecs = allEffectiveMemberSpecs.filter((member) =>
      primaryMemberNames.has(member.name)
    );
    assertDeterministicBootstrapPrimaryMemberLimit(effectiveMemberSpecs.length);
    const largeTeamWarning = buildLargeDeterministicBootstrapWarning(effectiveMemberSpecs.length);
    const initialLaunchWarnings = [warning, largeTeamWarning].filter((value): value is string =>
      Boolean(value)
    );
    const expectedMembers = effectiveMemberSpecs.map((member) => member.name);
    const resolvedProviderId = resolveTeamProviderId(request.providerId);
    const crossProviderMemberArgs = await ports.buildCrossProviderMemberArgs(
      resolvedProviderId,
      effectiveMemberSpecs,
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
      effectiveMembers: effectiveMemberSpecs,
      providerArgsByProvider,
    });

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
      effectiveMemberSpecs,
      allEffectiveMemberSpecs,
      launchIdentity,
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
