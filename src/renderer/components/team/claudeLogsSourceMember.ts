import { isLeadMember } from '@shared/utils/leadDetection';

import type { ResolvedTeamMember } from '@shared/types';

export function isLeadLogSourceMember(member: ResolvedTeamMember): boolean {
  if (isLeadMember(member)) return true;
  const normalizedName = member.name.trim().toLowerCase();
  if (normalizedName === 'lead') return true;
  const normalizedRole = member.role?.trim().toLowerCase();
  return normalizedRole === 'lead' || normalizedRole === 'team lead';
}
