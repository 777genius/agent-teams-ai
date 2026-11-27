import type { TeamLaunchDialogMode } from '../dialogs/LaunchTeamDialog';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ResolvedTeamMember } from '@shared/types';

export interface ChangeRuntimeLaunchState {
  open: true;
  mode: TeamLaunchDialogMode;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers: ResolvedTeamMember[];
  memberSettingsCommandId?: string;
  memberSettingsCommitted?: boolean;
}

/** Preserve a member-settings intent across a project team's confirmed relaunch. */
export function buildChangeRuntimeLaunchState(input: {
  logicalTeamName: string | undefined;
  isAlive: boolean;
  isProvisioning: boolean;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers: ResolvedTeamMember[];
}): ChangeRuntimeLaunchState {
  const perProject = Boolean(input.logicalTeamName);
  return {
    open: true,
    mode: perProject || (input.isAlive && !input.isProvisioning) ? 'relaunch' : 'launch',
    memberSettingsDraft: input.memberSettingsDraft,
    baselineMembers: input.baselineMembers,
    ...(perProject && input.memberSettingsDraft
      ? { memberSettingsCommandId: crypto.randomUUID() }
      : {}),
  };
}
