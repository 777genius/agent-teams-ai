import { isConversationLeadAlias, isLeadMember } from '@shared/utils/leadDetection';

import type { ResolvedTeamMember } from '@shared/types';

export function isLeadLogSourceMember(member: ResolvedTeamMember): boolean {
  if (isLeadMember(member)) return true;
  return isConversationLeadAlias(member.name);
}
