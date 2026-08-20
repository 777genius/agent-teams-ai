import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamConfig, TeamMember } from '@shared/types';

export interface TeamMemberRestorePlan {
  normalizedMemberName: string;
  restoredMember: TeamMember;
  nextMembers: TeamMember[];
  nextConfig?: TeamConfig;
}

export function planTeamMemberRestore(input: {
  memberName: string;
  members: readonly TeamMember[];
  config: TeamConfig | null;
}): TeamMemberRestorePlan {
  const normalizedMemberName = input.memberName.trim().toLowerCase();
  const memberIndex = input.members.findIndex(
    (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
  );
  const metaMember = memberIndex >= 0 ? input.members[memberIndex] : undefined;
  const configMemberIndex =
    input.config?.members?.findIndex(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    ) ?? -1;
  const configMember =
    configMemberIndex >= 0 ? input.config?.members?.[configMemberIndex] : undefined;
  const member = metaMember ?? configMember;

  if (!member) {
    throw new Error(`Member "${input.memberName}" not found`);
  }
  if (metaMember?.removedAt == null && configMember?.removedAt == null) {
    throw new Error(`Member "${input.memberName}" is not removed`);
  }
  if (isLeadMember(member) || (configMember ? isLeadMember(configMember) : false)) {
    throw new Error('Cannot restore team lead');
  }

  const restoredMember: TeamMember = {
    ...member,
    agentId: undefined,
    removedAt: undefined,
  };
  const nextMembers =
    memberIndex >= 0
      ? input.members.map((candidate, index) =>
          index === memberIndex ? restoredMember : candidate
        )
      : [...input.members, restoredMember];

  let nextConfig: TeamConfig | undefined;
  if (input.config && configMemberIndex >= 0 && configMember?.removedAt != null) {
    nextConfig = {
      ...input.config,
      members: input.config.members?.map((candidate, index) => {
        if (index !== configMemberIndex) return candidate;
        const restoredConfigMember = { ...candidate };
        delete restoredConfigMember.removedAt;
        return restoredConfigMember;
      }),
    };
  }

  return {
    normalizedMemberName,
    restoredMember,
    nextMembers,
    ...(nextConfig ? { nextConfig } : {}),
  };
}
