import { type TeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { TeamLaunchValidationError } from './TeamLaunchValidationError';
import { isPureOpenCodeProvisioningRequest } from './TeamProvisioningLaunchCompatibility';
import {
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesFromPlan,
  type MixedSecondaryRuntimeLaneState,
} from './TeamProvisioningSecondaryRuntimeRuns';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
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
    // Lane-plan rejections (e.g. an OpenCode-led mixed roster) are user-facing
    // launch blockers; retype them so HTTP surfaces the message instead of 500.
    throw new TeamLaunchValidationError(getErrorMessage(error));
  }
}

export function createMixedSecondaryLaneStates(
  plan: TeamRuntimeLanePlan
): MixedSecondaryRuntimeLaneState[] {
  return createMixedSecondaryLaneStatesFromPlan(plan);
}
