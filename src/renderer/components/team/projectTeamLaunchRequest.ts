import type { TeamLaunchRequest } from '@shared/types';

/**
 * Preserve the launch form's explicit provider/permission choices while
 * routing native execution through the logical team's project admission.
 */
export function toLogicalProjectLaunchRequest(
  request: TeamLaunchRequest,
  logicalTeamName: string,
  physicalProjectPath?: string
): TeamLaunchRequest {
  return {
    ...request,
    teamName: logicalTeamName,
    cwd: physicalProjectPath?.trim() || request.cwd,
  };
}
