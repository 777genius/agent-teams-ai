import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import {
  resolveWorkspaceTrustFeatureFlags,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';

import { ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS } from '../../runtime/anthropicTeamApiKeyHelper';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import { ensureCwdExists } from './TeamProvisioningAsyncUtils';
import { assertCreateTeamDoesNotExist } from './TeamProvisioningCreateTeamFlow';
import {
  type CrossProviderMemberArgsResult,
  type ProvisioningEnvResolution,
  type TeamRuntimeAuthContext,
} from './TeamProvisioningEnvBuilder';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  buildLargeDeterministicBootstrapWarning,
} from './TeamProvisioningLaunchCompatibility';
import { teamRequestIncludesCodexMember } from './TeamProvisioningMemberSpecs';
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
  type WorkspaceTrustPlanningLogger,
  type WorkspaceTrustProviderArgsResolver,
  type WorkspaceTrustWorkspaceCollectionPorts,
} from './TeamProvisioningWorkspaceTrust';
import { buildWorkspaceTrustLaunchArgs } from './TeamProvisioningWorkspaceTrustLaunchArgs';

import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamProviderId,
} from '@shared/types';

export interface DeterministicCreateSetupFlowPorts<TMixedSecondaryLane> {
  pathExists(filePath: string): Promise<boolean>;
  resolveClaudePath(): Promise<string | null>;
  buildMissingCliError(): Error;
  buildProvisioningEnv(
    providerId: TeamProviderId | undefined,
    providerBackendId: TeamCreateRequest['providerBackendId'],
    options: {
      includeCodexTeammateAuth: boolean;
      teamRuntimeAuth: TeamRuntimeAuthContext;
    }
  ): Promise<ProvisioningEnvResolution>;
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
    providerArgsResolver?: WorkspaceTrustProviderArgsResolver;
  }): Promise<TeamCreateRequest['members']>;
  resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']>;
  planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    cwd: string
  ): TeamRuntimeLanePlan;
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
  }): Promise<ProviderModelLaunchIdentity | null>;
  createMixedSecondaryLaneStates(plan: TeamRuntimeLanePlan): TMixedSecondaryLane[];
  workspaceTrustCoordinator: WorkspaceTrustCoordinator | null;
  workspaceTrustWorkspaceCollectionPorts: WorkspaceTrustWorkspaceCollectionPorts;
  runtimeTurnSettledEnvironmentProvider?: RuntimeTurnSettledEnvironmentProvider | null;
  logger: WorkspaceTrustPlanningLogger;
  getTeamsBasePathsToProbe?(): { location: TeamsBaseLocation; basePath: string }[];
  ensureCwdExists?(cwd: string): Promise<void>;
  resolveWorkspaceTrustFeatureFlags?(): WorkspaceTrustFeatureFlags;
}

export interface DeterministicCreateSetupFlowInput<TMixedSecondaryLane> {
  request: TeamCreateRequest;
  runtimeAuthMaterialId: string;
  ports: DeterministicCreateSetupFlowPorts<TMixedSecondaryLane>;
}

export interface DeterministicCreateSetupFlowResult<TMixedSecondaryLane> {
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  claudePath: string;
  provisioningEnv: ProvisioningEnvResolution;
  shellEnv: NodeJS.ProcessEnv;
  geminiRuntimeAuth: ProvisioningEnvResolution['geminiRuntimeAuth'];
  resolvedProviderId: TeamProviderId;
  providerArgsForLaunch: string[];
  inheritedProviderArgsForLaunch: string[];
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  mixedSecondaryLanes: TMixedSecondaryLane[];
  workspaceTrustFeatureFlags: WorkspaceTrustFeatureFlags;
  workspaceTrustFullPlan: WorkspaceTrustFullPlanResult | null;
  largeTeamWarning: string | null;
}

export async function prepareDeterministicCreateSetupFlow<TMixedSecondaryLane>({
  request,
  runtimeAuthMaterialId,
  ports,
}: DeterministicCreateSetupFlowInput<TMixedSecondaryLane>): Promise<
  DeterministicCreateSetupFlowResult<TMixedSecondaryLane>
> {
  const teamsBasePathsToProbe = (ports.getTeamsBasePathsToProbe ?? getTeamsBasePathsToProbe)();
  await assertCreateTeamDoesNotExist(request.teamName, teamsBasePathsToProbe, (filePath) =>
    ports.pathExists(filePath)
  );

  await (ports.ensureCwdExists ?? ensureCwdExists)(request.cwd);

  const claudePath = await ports.resolveClaudePath();
  if (!claudePath) {
    throw ports.buildMissingCliError();
  }

  const teamRuntimeAuth: TeamRuntimeAuthContext = {
    teamName: request.teamName,
    authMaterialId: runtimeAuthMaterialId,
    allowAnthropicApiKeyHelper: true,
  };
  const provisioningEnv = await ports.buildProvisioningEnv(
    request.providerId,
    request.providerBackendId,
    { includeCodexTeammateAuth: teamRequestIncludesCodexMember(request), teamRuntimeAuth }
  );
  const {
    env: shellEnv,
    geminiRuntimeAuth,
    providerArgs = [],
    warning: envWarning,
  } = provisioningEnv;
  if (envWarning) {
    throw new Error(envWarning);
  }

  const workspaceTrustFeatureFlags =
    ports.resolveWorkspaceTrustFeatureFlags?.() ?? resolveWorkspaceTrustFeatureFlags();
  const workspaceTrustProviders = workspaceTrustFeatureFlags.enabled
    ? collectWorkspaceTrustProviders({
        leadProviderId: request.providerId,
        members: request.members,
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
        logger: ports.logger,
      })
    : { launchArgPatches: [] };
  const workspaceTrustProviderArgsResolver =
    createDefaultModelWorkspaceTrustProviderArgsResolver(workspaceTrustEarlyPlan);
  const materializedMemberSpecs = await ports.materializeEffectiveTeamMemberSpecs({
    claudePath,
    cwd: request.cwd,
    members: request.members,
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
  const resolvedProviderId = resolveTeamProviderId(request.providerId);
  const crossProviderMemberArgs = await ports.buildCrossProviderMemberArgs(
    resolvedProviderId,
    effectiveMemberSpecs,
    { teamRuntimeAuth }
  );
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
        logger: ports.logger,
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

  return {
    teamsBasePathsToProbe,
    claudePath,
    provisioningEnv,
    shellEnv,
    geminiRuntimeAuth,
    resolvedProviderId,
    providerArgsForLaunch,
    inheritedProviderArgsForLaunch: crossProviderMemberArgsForLaunch.args,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    mixedSecondaryLanes: ports.createMixedSecondaryLaneStates(lanePlan),
    workspaceTrustFeatureFlags,
    workspaceTrustFullPlan,
    largeTeamWarning,
  };
}
