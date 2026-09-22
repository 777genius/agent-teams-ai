import type { MemberWorkSyncUseCaseDeps } from './ports';

export interface MemberWorkSyncRuntimeActivity {
  teamActive: boolean;
  memberActive: boolean;
  inactive: boolean;
  diagnostics: string[];
}

export async function resolveMemberWorkSyncRuntimeActivity(
  deps: Pick<MemberWorkSyncUseCaseDeps, 'lifecycle'>,
  input: { teamName: string; memberName: string }
): Promise<MemberWorkSyncRuntimeActivity> {
  if (!deps.lifecycle) {
    return { teamActive: true, memberActive: true, inactive: false, diagnostics: [] };
  }

  const teamActive = await deps.lifecycle.isTeamActive(input.teamName);
  if (!teamActive) {
    return {
      teamActive: false,
      memberActive: false,
      inactive: true,
      diagnostics: ['team_runtime_inactive'],
    };
  }

  const memberActive = deps.lifecycle.isMemberActive
    ? await deps.lifecycle.isMemberActive(input)
    : true;
  if (!memberActive) {
    return {
      teamActive: true,
      memberActive: false,
      inactive: true,
      diagnostics: ['member_runtime_inactive'],
    };
  }

  return { teamActive: true, memberActive: true, inactive: false, diagnostics: [] };
}
