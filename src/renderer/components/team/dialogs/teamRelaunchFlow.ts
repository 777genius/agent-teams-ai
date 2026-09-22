import type { ReplaceMembersRequest, TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

interface ExecuteTeamRelaunchOptions {
  teamName: string;
  isTeamAlive: boolean;
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  memberSettingsRelaunch?: ReplaceMembersRequest['memberSettingsRelaunch'];
  validateBeforeReplace?: () => Promise<void>;
  stopTeam: (teamName: string) => Promise<void>;
  replaceMembers: (teamName: string, request: ReplaceMembersRequest) => Promise<void>;
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>;
}

export async function executeTeamRelaunch({
  teamName,
  isTeamAlive,
  request,
  members,
  memberSettingsRelaunch,
  validateBeforeReplace,
  stopTeam,
  replaceMembers,
  launchTeam,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  await validateBeforeReplace?.();
  if (isTeamAlive) {
    await stopTeam(teamName);
    await validateBeforeReplace?.();
  }
  await replaceMembers(teamName, {
    members,
    ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
  });
  await launchTeam(request);
}
