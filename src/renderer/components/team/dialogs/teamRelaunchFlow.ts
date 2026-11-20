import type { ReplaceMembersRequest, TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

interface ExecuteTeamRelaunchOptions {
  teamName: string;
  isTeamAlive: boolean;
  request: TeamLaunchRequest;
  members: TeamCreateRequest['members'];
  /**
   * The roster belongs to a team definition that the team edit flow owns (a
   * per-project team). Required so no caller can forget it: such a relaunch
   * never saves the roster shown in the dialog.
   */
  rosterReadOnly: boolean;
  memberSettingsRelaunch?: ReplaceMembersRequest['memberSettingsRelaunch'];
  validateBeforeReplace?: () => Promise<void>;
  stopTeam: (teamName: string) => Promise<void>;
  replaceMembers: (teamName: string, request: ReplaceMembersRequest) => Promise<void>;
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>;
  onMembersSaved?: () => void;
}

export async function executeTeamRelaunch({
  teamName,
  isTeamAlive,
  request,
  members,
  rosterReadOnly,
  memberSettingsRelaunch,
  validateBeforeReplace,
  stopTeam,
  replaceMembers,
  launchTeam,
  onMembersSaved,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  await validateBeforeReplace?.();
  if (isTeamAlive) {
    await stopTeam(teamName);
    await validateBeforeReplace?.();
  }
  if (!rosterReadOnly) {
    await replaceMembers(teamName, {
      members,
      ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
    });
    onMembersSaved?.();
  }
  await launchTeam(request);
}
