import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

interface ExecuteTeamRelaunchOptions {
  teamName: string;
  isTeamAlive: boolean;
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  stopTeam: (teamName: string) => Promise<void>;
  replaceMembers: (
    teamName: string,
    request: { members: TeamCreateRequest['members'] }
  ) => Promise<void>;
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>;
}

export async function executeTeamRelaunch({
  teamName,
  isTeamAlive,
  request,
  members,
  stopTeam,
  replaceMembers,
  launchTeam,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  if (isTeamAlive) {
    await stopTeam(teamName);
  }
  await replaceMembers(teamName, { members });
  await launchTeam(request);
}
