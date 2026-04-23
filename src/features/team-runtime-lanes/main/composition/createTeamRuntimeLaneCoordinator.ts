import { buildMixedPersistedLaunchSnapshot } from '@features/team-runtime-lanes/core/domain/buildMixedPersistedLaunchSnapshot';
import {
  fromProvisioningMembers,
  isMixedOpenCodeSideLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes/core/domain/planTeamRuntimeLanes';

import type { PersistedTeamLaunchSnapshot, TeamCreateRequest, TeamProviderId } from '@shared/types';

export interface TeamRuntimeLaneCoordinator {
  planProvisioningMembers(params: {
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
    hasOpenCodeRuntimeAdapter: boolean;
  }): TeamRuntimeLanePlan;
  buildAggregateLaunchSnapshot(
    params: Parameters<typeof buildMixedPersistedLaunchSnapshot>[0]
  ): PersistedTeamLaunchSnapshot;
  isMixedSideLanePlan(plan: TeamRuntimeLanePlan): boolean;
}

export function createTeamRuntimeLaneCoordinator(): TeamRuntimeLaneCoordinator {
  return {
    planProvisioningMembers(params) {
      const lanePlan = fromProvisioningMembers(params.leadProviderId, params.members);
      if (!lanePlan.ok) {
        throw new Error(lanePlan.message);
      }
      if (isMixedOpenCodeSideLanePlan(lanePlan.plan) && !params.hasOpenCodeRuntimeAdapter) {
        throw new Error(
          'Mixed teams with OpenCode side lanes require the OpenCode runtime adapter to be registered.'
        );
      }
      return lanePlan.plan;
    },
    buildAggregateLaunchSnapshot(params) {
      return buildMixedPersistedLaunchSnapshot(params);
    },
    isMixedSideLanePlan(plan) {
      return isMixedOpenCodeSideLanePlan(plan);
    },
  };
}
