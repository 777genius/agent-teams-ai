import type { TeamLaunchDialogMode } from '../dialogs/LaunchTeamDialog';
import type { MemberSettingsRelaunchDraft } from '@features/team-provisioning/renderer';
import type { ResolvedTeamMember } from '@shared/types';

export interface ChangeRuntimeLaunchState {
  open: true;
  mode: TeamLaunchDialogMode;
  memberSettingsDraft?: MemberSettingsRelaunchDraft;
  baselineMembers: ResolvedTeamMember[];
}

/**
 * Launch-dialog state for "change the lead runtime".
 *
 * A per-project team keeps its roster in the team definition, which only the
 * team edit flow writes. Launch mode saves the roster of the open project
 * copy before launching, so it must not be used for such a team, and a member
 * settings draft is a relaunch of one project's roster that the definition
 * does not support. A per-project team therefore always opens relaunch mode
 * without a draft.
 */
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
    memberSettingsDraft: perProject ? undefined : input.memberSettingsDraft,
    baselineMembers: input.baselineMembers,
  };
}
