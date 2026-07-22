import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';

import { type DeterministicCreateSetupFlowPorts } from './TeamProvisioningCreateDeterministicSetupFlow';
import { buildMissingCliError } from './TeamProvisioningRuntimeFailureLabels';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

import type { WorkspaceTrustPlanningLogger } from './TeamProvisioningWorkspaceTrust';

type CreateSetupPorts = DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState>;

export interface TeamProvisioningCreateDeterministicSetupFlowServiceHost {
  anthropicApiKeyHelperCleanupRetryOwner: CreateSetupPorts['anthropicApiKeyHelperCleanupRetryOwner'];
  pathExists: CreateSetupPorts['pathExists'];
  buildProvisioningEnv: CreateSetupPorts['buildProvisioningEnv'];
  materializeEffectiveTeamMemberSpecs: CreateSetupPorts['materializeEffectiveTeamMemberSpecs'];
  resolveOpenCodeMemberWorkspacesForRuntime: CreateSetupPorts['resolveOpenCodeMemberWorkspacesForRuntime'];
  planRuntimeLanesOrThrow: CreateSetupPorts['planRuntimeLanesOrThrow'];
  buildCrossProviderMemberArgs: CreateSetupPorts['buildCrossProviderMemberArgs'];
  resolveAndValidateLaunchIdentity: CreateSetupPorts['resolveAndValidateLaunchIdentity'];
  createMixedSecondaryLaneStates: CreateSetupPorts['createMixedSecondaryLaneStates'];
  workspaceTrustPreSpawnBoundary: {
    getWorkspaceTrustCoordinator(): CreateSetupPorts['workspaceTrustCoordinator'];
    workspaceTrustWorkspaceCollectionPorts: CreateSetupPorts['workspaceTrustWorkspaceCollectionPorts'];
  };
  runtimeTurnSettledEnvironmentProvider: CreateSetupPorts['runtimeTurnSettledEnvironmentProvider'];
}

export interface TeamProvisioningCreateDeterministicSetupFlowFactoryDeps {
  logger: WorkspaceTrustPlanningLogger;
  resolveClaudePath?: CreateSetupPorts['resolveClaudePath'];
  buildMissingCliError?: CreateSetupPorts['buildMissingCliError'];
}

export function createTeamProvisioningCreateDeterministicSetupFlowPortsFromService(
  service: TeamProvisioningCreateDeterministicSetupFlowServiceHost,
  deps: TeamProvisioningCreateDeterministicSetupFlowFactoryDeps
): CreateSetupPorts {
  return {
    anthropicApiKeyHelperCleanupRetryOwner: service.anthropicApiKeyHelperCleanupRetryOwner,
    pathExists: (filePath) => service.pathExists(filePath),
    resolveClaudePath: deps.resolveClaudePath ?? (() => ClaudeBinaryResolver.resolve()),
    buildMissingCliError: deps.buildMissingCliError ?? buildMissingCliError,
    buildProvisioningEnv: (providerId, providerBackendId, options) =>
      service.buildProvisioningEnv(providerId, providerBackendId, options),
    materializeEffectiveTeamMemberSpecs: (params) =>
      service.materializeEffectiveTeamMemberSpecs(params),
    resolveOpenCodeMemberWorkspacesForRuntime: (params) =>
      service.resolveOpenCodeMemberWorkspacesForRuntime(params),
    planRuntimeLanesOrThrow: (leadProviderId, members, cwd) =>
      service.planRuntimeLanesOrThrow(leadProviderId, members, cwd),
    buildCrossProviderMemberArgs: (primaryProviderId, memberSpecs, options) =>
      service.buildCrossProviderMemberArgs(primaryProviderId, memberSpecs, options),
    resolveAndValidateLaunchIdentity: (params) => service.resolveAndValidateLaunchIdentity(params),
    createMixedSecondaryLaneStates: (lanePlan) => service.createMixedSecondaryLaneStates(lanePlan),
    workspaceTrustCoordinator:
      service.workspaceTrustPreSpawnBoundary.getWorkspaceTrustCoordinator(),
    workspaceTrustWorkspaceCollectionPorts:
      service.workspaceTrustPreSpawnBoundary.workspaceTrustWorkspaceCollectionPorts,
    runtimeTurnSettledEnvironmentProvider: service.runtimeTurnSettledEnvironmentProvider,
    logger: deps.logger,
  };
}
