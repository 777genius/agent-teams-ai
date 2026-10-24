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
  memberSettingsRelaunch?: ReplaceMembersRequest['memberSettingsRelaunch'];
  rosterMetadata?: Pick<ReplaceMembersRequest, 'command' | 'configuration'> & {
    relaunch?: TeamRelaunchContinuation;
  };
  validateBeforeReplace?: () => Promise<void>;
  stopTeam: (teamName: string) => Promise<void>;
  stopRun?: (runId: string) => Promise<void>;
  replaceMembers: (teamName: string, request: ReplaceMembersRequest) => Promise<void>;
  launchTeam: (request: TeamLaunchRequest) => Promise<unknown>;
}

export async function executeTeamRelaunch({
  teamName,
  isTeamAlive,
  request,
  members,
  memberSettingsRelaunch,
  rosterMetadata,
  validateBeforeReplace,
  stopTeam,
  stopRun,
  replaceMembers,
  launchTeam,
}: ExecuteTeamRelaunchOptions): Promise<void> {
  const { relaunch, ...persistedMetadata } = rosterMetadata ?? {};
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
    }
    await launchTeam(request);
    return;
  }
  await validateBeforeReplace?.();
  if (isTeamAlive) {
    await stopTeam(teamName);
    await validateBeforeReplace?.();
  }
  await replaceMembers(teamName, {
    members,
    ...persistedMetadata,
    ...(memberSettingsRelaunch ? { memberSettingsRelaunch } : {}),
  });
  await launchTeam(request);
}
