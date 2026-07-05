import {
  type LaunchIdentityResolutionPorts,
  readRuntimeProviderLaunchFacts,
  type ReadRuntimeProviderLaunchFactsInput,
  type ReadRuntimeProviderLaunchFactsPorts,
  resolveAndValidateLaunchIdentity,
  type ResolveAndValidateLaunchIdentityInput,
  resolveDirectMemberLaunchIdentity,
  type ResolveDirectMemberLaunchIdentityInput,
} from './TeamProvisioningLaunchIdentity';
import {
  buildProviderModelLaunchIdentity,
  type RuntimeProviderLaunchFacts,
  validateRuntimeLaunchSelection,
} from './TeamProvisioningRuntimeLaunchSelection';

import type {
  CliProviderModelCatalog,
  ProviderModelLaunchIdentity,
  TeamProviderId,
} from '@shared/types';

export interface TeamProvisioningLaunchIdentityBoundaryDeps {
  execCli: ReadRuntimeProviderLaunchFactsPorts['execCli'];
  providerConnectionService: {
    getCodexModelCatalog(params: { cwd: string }): Promise<CliProviderModelCatalog | null>;
  };
  getAnthropicFastModeDefault(): boolean;
  getProviderLabel(providerId: TeamProviderId): string;
  logger: {
    warn(message: string): void;
  };
}

export interface TeamProvisioningLaunchIdentityBoundary {
  readRuntimeProviderLaunchFacts(
    params: ReadRuntimeProviderLaunchFactsInput
  ): Promise<RuntimeProviderLaunchFacts>;
  resolveAndValidateLaunchIdentity(
    params: ResolveAndValidateLaunchIdentityInput
  ): Promise<ProviderModelLaunchIdentity>;
  resolveDirectMemberLaunchIdentity(
    input: ResolveDirectMemberLaunchIdentityInput
  ): Promise<ProviderModelLaunchIdentity>;
}

export function createTeamProvisioningLaunchIdentityBoundary(
  deps: TeamProvisioningLaunchIdentityBoundaryDeps
): TeamProvisioningLaunchIdentityBoundary {
  const readLaunchFacts = (
    params: ReadRuntimeProviderLaunchFactsInput
  ): Promise<RuntimeProviderLaunchFacts> =>
    readRuntimeProviderLaunchFacts(params, {
      execCli: deps.execCli,
      getCodexModelCatalog: (input) => deps.providerConnectionService.getCodexModelCatalog(input),
      warn: (message) => deps.logger.warn(message),
    });

  const ports: LaunchIdentityResolutionPorts = {
    readRuntimeProviderLaunchFacts: readLaunchFacts,
    buildProviderModelLaunchIdentity: (params) =>
      buildProviderModelLaunchIdentity({
        ...params,
        anthropicFastModeDefault: deps.getAnthropicFastModeDefault(),
      }),
    validateRuntimeLaunchSelection: (params) =>
      validateRuntimeLaunchSelection({
        ...params,
        anthropicFastModeDefault: deps.getAnthropicFastModeDefault(),
        getProviderLabel: deps.getProviderLabel,
      }),
  };

  const boundary: TeamProvisioningLaunchIdentityBoundary = {
    readRuntimeProviderLaunchFacts: readLaunchFacts,
    resolveAndValidateLaunchIdentity(params) {
      return resolveAndValidateLaunchIdentity(params, ports);
    },
    resolveDirectMemberLaunchIdentity(input) {
      return resolveDirectMemberLaunchIdentity(input, ports);
    },
  };

  return boundary;
}
