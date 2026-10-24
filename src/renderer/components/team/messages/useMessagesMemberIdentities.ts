import { useMemo } from 'react';

import { leadNamesFromMembers } from './messagesPanelConversations';
import { memberConversationParticipants } from './messagesPanelDerivedData';

import type { ResolvedTeamMember } from '@shared/types';

/** One captured roster supplies the reply route, canonical feed and draft participant identities. */
export function useMessagesMemberIdentities(members: readonly ResolvedTeamMember[]) {
  return useMemo(
    () => ({
      leadNames: leadNamesFromMembers(members),
      memberNames: new Set(members.map((member) => member.name)),
      normalizedMemberNames: memberConversationParticipants(members),
    }),
    [members]
  );
}
