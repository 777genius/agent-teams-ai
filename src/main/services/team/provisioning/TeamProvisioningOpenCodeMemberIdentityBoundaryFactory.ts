import {
  type OpenCodeSecondaryRuntimeRunIdentity,
  resolveOpenCodeMemberIdentityFromDirectory,
} from './TeamProvisioningOpenCodeMemberIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamProviderId } from '@shared/types';

export interface TeamProvisioningOpenCodeMemberIdentityBoundaryDeps {
  getSecondaryRuntimeRuns(teamName: string): readonly OpenCodeSecondaryRuntimeRunIdentity[];
  getRuntimeAdapterProviderId(teamName: string): TeamProviderId | null;
}

export interface TeamProvisioningOpenCodeMemberIdentityBoundary {
  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution;
}

export function createTeamProvisioningOpenCodeMemberIdentityBoundary(
  deps: TeamProvisioningOpenCodeMemberIdentityBoundaryDeps
): TeamProvisioningOpenCodeMemberIdentityBoundary {
  return {
    resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory) {
      return resolveOpenCodeMemberIdentityFromDirectory({
        memberName,
        directory,
        secondaryRuntimeRuns: deps.getSecondaryRuntimeRuns(teamName),
        runtimeAdapterProviderId: deps.getRuntimeAdapterProviderId(teamName),
      });
    },
  };
}
