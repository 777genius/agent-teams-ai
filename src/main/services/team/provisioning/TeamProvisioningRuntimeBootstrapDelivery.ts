import {
  type TeamRuntimeLanePlan,
  TeamRuntimeLanePlanningError,
} from '@features/team-runtime-lanes';
import { type TeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';

import { TeamLaunchValidationError } from './TeamLaunchValidationError';
import { isPureOpenCodeProvisioningRequest } from './TeamProvisioningLaunchCompatibility';
import {
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesFromPlan,
  type MixedSecondaryRuntimeLaneState,
} from './TeamProvisioningSecondaryRuntimeRuns';

import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

export function shouldRouteOpenCodeToRuntimeAdapter(
  request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  },
  hasOpenCodeRuntimeAdapter: boolean
): boolean {
  return isPureOpenCodeProvisioningRequest(request) && hasOpenCodeRuntimeAdapter;
}

export function planRuntimeLanesOrThrow(
  runtimeLaneCoordinator: Pick<TeamRuntimeLaneCoordinator, 'planProvisioningMembers'>,
  input: {
    leadProviderId: TeamProviderId | undefined;
    members: TeamCreateRequest['members'];
    baseCwd?: string;
    hasOpenCodeRuntimeAdapter: boolean;
  }
): TeamRuntimeLanePlan {
  try {
    return runtimeLaneCoordinator.planProvisioningMembers(input);
  } catch (error) {
    // Only the coordinator's typed lane-plan rejections are user-facing launch
    // blockers. Unknown failures must retain their original type for 500 handling.
    if (error instanceof TeamRuntimeLanePlanningError) {
      throw new TeamLaunchValidationError(error.message);
    }
    throw error;
  }
}

export function createMixedSecondaryLaneStates(
  plan: TeamRuntimeLanePlan
): MixedSecondaryRuntimeLaneState[] {
  return createMixedSecondaryLaneStatesFromPlan(plan);
}
