import type { ReplaceMembersRequest, TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

export interface TeamRelaunchContinuation {
  originalRunId: string | null | undefined;
  stopConfirmed: boolean;
  replaceAttempted: boolean;
  replaceConfirmed: boolean;
}

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
  rosterMetadata?: Pick<ReplaceMembersRequest, 'command' | 'configuration'> & {
    relaunch?: TeamRelaunchContinuation;
  };
  validateBeforeReplace?: () => Promise<void>;
  stopTeam: (teamName: string) => Promise<void>;
  stopRun?: (runId: string) => Promise<void>;
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
  rosterMetadata,
  validateBeforeReplace,
  stopTeam,
  stopRun,
  replaceMembers,
  launchTeam,
  onMembersSaved,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  const { relaunch, ...persistedMetadata } = rosterMetadata ?? {};
  if (relaunch && rosterReadOnly) {
    await validateBeforeReplace?.();
    if (!relaunch.stopConfirmed) {
      if (isTeamAlive) {
        if (!relaunch.originalRunId || !stopRun)
          throw new Error('Original team run unavailable. Close and reopen relaunch.');
        await stopRun(relaunch.originalRunId);
      }
      relaunch.stopConfirmed = true;
    }
    await validateBeforeReplace?.();
    await launchTeam(request);
    return;
  }
  if (relaunch) {
    if (!relaunch.replaceConfirmed) {
      if (!relaunch.replaceAttempted) {
        await validateBeforeReplace?.();
        if (!relaunch.stopConfirmed) {
          if (isTeamAlive) {
            if (!relaunch.originalRunId || !stopRun)
              throw new Error('Original team run unavailable. Close and reopen relaunch.');
            await stopRun(relaunch.originalRunId);
          }
          relaunch.stopConfirmed = true;
        }
        await validateBeforeReplace?.();
      }
      relaunch.replaceAttempted = true;
      await replaceMembers(teamName, {
        members,
        ...persistedMetadata,
        ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
      });
      relaunch.replaceConfirmed = true;
      onMembersSaved?.();
    }
    await launchTeam(request);
    return;
  }
  await validateBeforeReplace?.();
  if (isTeamAlive) {
    await stopTeam(teamName);
    await validateBeforeReplace?.();
  }
  if (!rosterReadOnly) {
    await replaceMembers(teamName, {
      members,
      ...persistedMetadata,
      ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
    });
    onMembersSaved?.();
  }
  await launchTeam(request);
}
