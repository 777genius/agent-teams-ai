import {
  materializeOpenCodeRuntimeAdapterDefaults,
  type OpenCodeRuntimeDefaultsPorts,
} from './TeamProvisioningOpenCodeRuntimeDefaults';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamLaunchRequest, TeamProviderId } from '@shared/types';

export interface OpenCodeRuntimeAdapterPreparationPorts extends OpenCodeRuntimeDefaultsPorts {
  resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']>;
  planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan;
  buildOpenCodeRuntimeAdapterLaunchMembers(
    request: TeamCreateRequest | TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    lanePlan?: TeamRuntimeLanePlan
  ): TeamCreateRequest['members'];
}

export interface PreparedOpenCodeRuntimeAdapterLaunch<
  TRequest extends TeamCreateRequest | TeamLaunchRequest,
> {
  launchRequest: TRequest;
  effectiveMembers: TeamCreateRequest['members'];
  lanePlan: TeamRuntimeLanePlan;
  runtimeLaunchMembers: TeamCreateRequest['members'];
}

export async function prepareOpenCodeRuntimeAdapterLaunch<
  TRequest extends TeamCreateRequest | TeamLaunchRequest,
>(
  params: {
    request: TRequest;
    members: TeamCreateRequest['members'];
  },
  ports: OpenCodeRuntimeAdapterPreparationPorts
): Promise<PreparedOpenCodeRuntimeAdapterLaunch<TRequest>> {
  const materialized = await materializeOpenCodeRuntimeAdapterDefaults(params, ports);
  const launchRequest = materialized.request;
  const effectiveMembers = await ports.resolveOpenCodeMemberWorkspacesForRuntime({
    teamName: launchRequest.teamName,
    baseCwd: launchRequest.cwd,
    leadProviderId: launchRequest.providerId,
    members: materialized.members,
  });
  const lanePlan = ports.planRuntimeLanesOrThrow(
    launchRequest.providerId,
    effectiveMembers,
    launchRequest.cwd
  );
  const runtimeLaunchMembers = ports.buildOpenCodeRuntimeAdapterLaunchMembers(
    launchRequest,
    effectiveMembers,
    lanePlan
  );

  return {
    launchRequest,
    effectiveMembers,
    lanePlan,
    runtimeLaunchMembers,
  };
}
