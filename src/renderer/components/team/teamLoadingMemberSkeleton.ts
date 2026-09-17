import { isLeadMember } from '@shared/utils/leadDetection';

const MEMBER_SKELETON_ACCENTS = ['#46d93b', '#3b82f6', '#facc15', '#14b8a6', '#ef4444'] as const;
const MAX_MEMBER_SKELETON_ROWS = 24;

export interface TeamLoadingMemberSummary {
  memberCount?: number;
  expectedMemberCount?: number;
  members?: readonly { name?: string }[];
  leadName?: string | null;
}

function countListedTeammates(
  members: readonly { name?: string }[] | undefined,
  leadName: string | null | undefined
): number {
  if (!members?.length) {
    return 0;
  }

  const normalizedLeadName = leadName?.trim().toLowerCase();
  const names = new Set<string>();
  for (const member of members) {
    const name = member.name?.trim();
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === 'user' ||
      isLeadMember({ name }) ||
      (normalizedLeadName && normalizedName === normalizedLeadName)
    ) {
      continue;
    }
    names.add(normalizedName);
  }
  return names.size;
}

function nonNegativeCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}

export function getTeamLoadingMemberSkeletonCount(
  summary: TeamLoadingMemberSummary | undefined
): number {
  if (!summary) {
    return 0;
  }

  const teammates = Math.max(
    nonNegativeCount(summary.memberCount),
    countListedTeammates(summary.members, summary.leadName),
    nonNegativeCount(summary.expectedMemberCount)
  );
  const hasLead = Boolean(summary.leadName?.trim());
  if (teammates === 0 && !hasLead) {
    return 0;
  }

  return Math.min(MAX_MEMBER_SKELETON_ROWS, teammates + 1);
}

export function teamLoadingMemberSkeletonAccents(count: number): string[] {
  const n = Math.max(0, Math.floor(count));
  return Array.from(
    { length: n },
    (_, index) => MEMBER_SKELETON_ACCENTS[index % MEMBER_SKELETON_ACCENTS.length]!
  );
}
