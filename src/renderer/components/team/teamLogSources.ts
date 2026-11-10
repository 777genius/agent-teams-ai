import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { ResolvedTeamMember } from '@shared/types';

export const LEAD_LOG_SOURCE_KEY = 'lead';

const FALLBACK_LEAD_LOG_MEMBER: ResolvedTeamMember = {
  name: 'team-lead',
  agentType: 'team-lead',
  status: 'active',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
};

export type TeamLogSourceKey = typeof LEAD_LOG_SOURCE_KEY | `member:${string}`;

export function memberLogSourceKey(memberName: string): TeamLogSourceKey {
  return `member:${memberName}`;
}

export function getMemberNameFromLogSourceKey(sourceKey: TeamLogSourceKey): string | null {
  if (sourceKey === LEAD_LOG_SOURCE_KEY) return null;
  return sourceKey.slice('member:'.length);
}

export function formatMemberLogSourceLabel(member: ResolvedTeamMember, removedLabel = 'removed'): string {
  return member.removedAt ? `${member.name} (${removedLabel})` : member.name;
}

export function formatMemberLogSourceDescription(
  member: ResolvedTeamMember,
  labels?: {
    lead?: string;
    removed?: string;
  }
): string | null {
  if (isLeadMember(member)) return labels?.lead ?? 'Team Lead';
  if (member.removedAt) return labels?.removed ?? 'Removed';
  return formatAgentRole(member.role) ?? formatAgentRole(member.agentType) ?? null;
}

export function normalizeMemberLogSourceName(memberName: string): string {
  return memberName.trim().toLowerCase();
}

export function buildSelectableLogMembers(
  members: readonly ResolvedTeamMember[]
): ResolvedTeamMember[] {
  const sourceByName = new Map<
    string,
    {
      member: ResolvedTeamMember;
      index: number;
    }
  >();

  members.forEach((member, index) => {
    const sourceName = normalizeMemberLogSourceName(member.name);
    if (!sourceName || sourceName === 'user' || isLeadMember(member)) return;

    const existing = sourceByName.get(sourceName);
    if (!existing || (existing.member.removedAt && !member.removedAt)) {
      sourceByName.set(sourceName, { member, index: existing?.index ?? index });
    }
  });

  return [...sourceByName.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.member);
}

export function resolveLeadLogMember(members: readonly ResolvedTeamMember[]): ResolvedTeamMember {
  const leadMembers = members.filter((member) => isLeadMember(member));
  return (
    leadMembers.find((member) => !member.removedAt) ?? leadMembers[0] ?? FALLBACK_LEAD_LOG_MEMBER
  );
}
