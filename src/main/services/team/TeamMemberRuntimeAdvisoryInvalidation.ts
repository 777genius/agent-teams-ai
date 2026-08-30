import { getTeamDataWorkerClient } from './TeamDataWorkerClient';

import type { TeamProvisioningMemberRuntimeAdvisoryInvalidator } from './provisioning/TeamProvisioningAppShellBoundary';
import type { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';

/**
 * Fan-out for member runtime advisory invalidation.
 *
 * Two advisory-service instances exist: one inside the team data worker, which
 * backs the snapshots the UI renders, and one on this thread. A per-member
 * invalidation and a launch-start reset both have to reach both of them, or the
 * instance that missed the reset keeps serving the dead run's advisory.
 */
export function createMemberRuntimeAdvisoryInvalidator(
  advisoryService: TeamMemberRuntimeAdvisoryService
): TeamProvisioningMemberRuntimeAdvisoryInvalidator {
  return (teamName, memberName, options) => {
    if (memberName) {
      advisoryService.invalidateMemberAdvisory(teamName, memberName);
      getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName, memberName);
      return;
    }
    const runStartedAtMs = options?.runStartedAtMs ?? Date.now();
    advisoryService.invalidateTeamAdvisories(teamName, runStartedAtMs);
    getTeamDataWorkerClient().resetMemberRuntimeAdvisoriesForNewRun(teamName, runStartedAtMs);
  };
}
