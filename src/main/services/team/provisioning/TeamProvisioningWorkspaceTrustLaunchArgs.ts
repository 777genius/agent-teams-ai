import { applyWorkspaceTrustArgPatches } from './TeamProvisioningWorkspaceTrust';

import type { CrossProviderMemberArgsResult } from './TeamProvisioningEnvBuilder';
import type { WorkspaceTrustLaunchArgPatch } from '@features/workspace-trust/main';
import type { TeamProviderId } from '@shared/types';
export interface TeamProvisioningWorkspaceTrustLaunchArgsInput {
  providerArgs: string[];
  resolvedProviderId: TeamProviderId;
  crossProviderMemberArgs: CrossProviderMemberArgsResult;
  workspaceTrustPatches: WorkspaceTrustLaunchArgPatch[];
}

export interface TeamProvisioningWorkspaceTrustLaunchArgsResult {
  providerArgsForLaunch: string[];
  crossProviderMemberArgsForLaunch: CrossProviderMemberArgsResult;
  providerArgsByProvider: Map<TeamProviderId, string[]>;
}

export function buildWorkspaceTrustLaunchArgs(
  input: TeamProvisioningWorkspaceTrustLaunchArgsInput
): TeamProvisioningWorkspaceTrustLaunchArgsResult {
  const providerArgsForLaunch = applyWorkspaceTrustArgPatches({
    args: input.providerArgs,
    patches: input.workspaceTrustPatches,
    targetProvider: input.resolvedProviderId,
    targetSurface: 'primary_provider_args',
  });
  const crossProviderArgsForLaunch = input.crossProviderMemberArgs.providerArgsByProvider.has(
    'codex'
  )
    ? applyWorkspaceTrustArgPatches({
        args: input.crossProviderMemberArgs.args,
        patches: input.workspaceTrustPatches,
        targetProvider: 'codex',
        targetSurface: 'cross_provider_member_args',
      })
    : input.crossProviderMemberArgs.args;
  const crossProviderMemberArgsForLaunch = {
    ...input.crossProviderMemberArgs,
    args: crossProviderArgsForLaunch,
  };

  const providerArgsByProvider = new Map<TeamProviderId, string[]>();
  for (const [providerId, args] of new Map<TeamProviderId, string[]>([
    [input.resolvedProviderId, providerArgsForLaunch],
    ...input.crossProviderMemberArgs.providerArgsByProvider,
  ])) {
    providerArgsByProvider.set(
      providerId,
      applyWorkspaceTrustArgPatches({
        args,
        patches: input.workspaceTrustPatches,
        targetProvider: providerId,
        targetSurface: 'provider_facts_probe',
      })
    );
  }

  return {
    providerArgsForLaunch,
    crossProviderMemberArgsForLaunch,
    providerArgsByProvider,
  };
}
