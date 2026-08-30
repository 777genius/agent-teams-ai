import {
  createMemberDraft,
  normalizeMemberDraftForProviderMode,
} from '@renderer/components/team/members/membersEditorUtils';
import { CUSTOM_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamProvisioningMemberInput } from '@shared/types';

interface BuildInitialRosterMemberDraftsOptions {
  /** Members copied from an existing team. Absent when creating a brand-new team. */
  copiedMembers?: readonly TeamProvisioningMemberInput[];
  multimodelEnabled: boolean;
}

/**
 * Initial teammate roster shown when the Create Team dialog opens.
 *
 * A brand-new team starts with the lead only — teammates are added explicitly
 * via "Add member". Copying an existing team preserves that team's members.
 */
export function buildInitialRosterMemberDrafts({
  copiedMembers,
  multimodelEnabled,
}: BuildInitialRosterMemberDraftsOptions): MemberDraft[] {
  if (!copiedMembers) {
    return [];
  }
  return copiedMembers.map((member) => {
    const presetRoles: readonly string[] = PRESET_ROLES;
    const isPreset = member.role != null && presetRoles.includes(member.role);
    const isCustom = member.role != null && member.role.length > 0 && !isPreset;
    return normalizeMemberDraftForProviderMode(
      createMemberDraft({
        name: member.name,
        roleSelection: isCustom ? CUSTOM_ROLE : (member.role ?? ''),
        customRole: isCustom ? member.role : '',
        workflow: member.workflow,
        isolation: member.isolation === 'worktree' ? 'worktree' : undefined,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
        providerBackendId: member.providerBackendId,
        model: member.model ?? '',
        effort: member.effort,
        fastMode: member.fastMode,
        mcpPolicy: member.mcpPolicy,
      }),
      multimodelEnabled
    );
  });
}
