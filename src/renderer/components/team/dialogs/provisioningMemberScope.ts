import { isTeamProviderId } from '@shared/utils/teamProvider';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';
import type { TeamProviderId } from '@shared/types';

export function collectActiveMemberProviderIds(members: readonly MemberDraft[]): TeamProviderId[] {
  return members.flatMap((member) =>
    !member.removedAt && isTeamProviderId(member.providerId) ? [member.providerId] : []
  );
}
