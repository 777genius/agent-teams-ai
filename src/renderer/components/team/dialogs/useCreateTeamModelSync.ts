import { useCallback } from 'react';

import { clearMemberModelOverrides } from '@renderer/components/team/members/MembersEditorSection';
import {
  applyStoredCreateTeamMemberRuntimePreferences,
  getStoredCreateTeamMemberRuntimePreferences,
} from '@renderer/services/createTeamPreferences';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

interface UseCreateTeamModelSyncParams {
  members: MemberDraft[];
  persistCurrentMemberRuntimePreferences(members: readonly MemberDraft[]): void;
  setMembers(members: MemberDraft[]): void;
  setSyncModelsWithLead(value: boolean): void;
}

export function useCreateTeamModelSync({
  members,
  persistCurrentMemberRuntimePreferences,
  setMembers,
  setSyncModelsWithLead,
}: UseCreateTeamModelSyncParams): (checked: boolean) => void {
  return useCallback(
    (checked: boolean): void => {
      setSyncModelsWithLead(checked);
      if (checked) {
        persistCurrentMemberRuntimePreferences(members);
        setMembers(members.map(clearMemberModelOverrides));
        return;
      }
      if (getStoredCreateTeamMemberRuntimePreferences().length === 0) return;

      const nextMembers = applyStoredCreateTeamMemberRuntimePreferences(members);
      const hasRuntimeChanges = nextMembers.some((member, index) => {
        const previousMember = members[index];
        return (
          member.providerId !== previousMember?.providerId ||
          member.model !== previousMember?.model ||
          member.effort !== previousMember?.effort
        );
      });
      if (hasRuntimeChanges) setMembers(nextMembers);
    },
    [members, persistCurrentMemberRuntimePreferences, setMembers, setSyncModelsWithLead]
  );
}
