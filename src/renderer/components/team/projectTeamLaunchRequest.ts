import type { TeamLaunchRequest } from '@shared/types';

/**
 * Preserve the launch form's explicit provider/permission choices while
 * routing native execution through the logical team's project admission.
 * Preserve the submitted, preflight-validated cwd: replacing B with the
 * current physical context A would silently start agents in the wrong project.
 */
export function toLogicalProjectLaunchRequest(
  request: TeamLaunchRequest,
  logicalTeamName: string
): TeamLaunchRequest {
  return {
    ...request,
    teamName: logicalTeamName,
  };
}
