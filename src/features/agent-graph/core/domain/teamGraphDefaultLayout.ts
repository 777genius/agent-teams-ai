import { isLeadMember } from '@shared/utils/leadDetection';
import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import type { GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';

export interface TeamGraphDefaultLayoutMemberInput {
  name: string;
  agentId?: string | null;
  removedAt?: number | null;
}

export interface TeamGraphDefaultLayoutSeed {
  orderedVisibleOwnerIds: string[];
  signature: string | null;
  assignments: Record<string, GraphOwnerSlotAssignment>;
  duplicateStableOwnerIds: string[];
}

const DEFAULT_OWNER_SLOT_PRESETS: readonly (readonly GraphOwnerSlotAssignment[])[] = [
  [],
  [{ ringIndex: 0, sectorIndex: 0 }],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 0, sectorIndex: 3 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 0, sectorIndex: 4 },
    { ringIndex: 0, sectorIndex: 5 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 2 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 2 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 0 },
    { ringIndex: 3, sectorIndex: 1 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 0 },
    { ringIndex: 3, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 2 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 1, sectorIndex: 2 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 0 },
    { ringIndex: 3, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 2 },
  ],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 1, sectorIndex: 2 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 2, sectorIndex: 2 },
    { ringIndex: 3, sectorIndex: 0 },
    { ringIndex: 3, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 2 },
  ],
  [],
  [
    { ringIndex: 0, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: 1 },
    { ringIndex: 0, sectorIndex: 2 },
    { ringIndex: 1, sectorIndex: 0 },
    { ringIndex: 1, sectorIndex: 1 },
    { ringIndex: 1, sectorIndex: 2 },
    { ringIndex: 2, sectorIndex: 0 },
    { ringIndex: 2, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 0 },
    { ringIndex: 3, sectorIndex: 1 },
    { ringIndex: 3, sectorIndex: 2 },
    { ringIndex: 4, sectorIndex: 0 },
    { ringIndex: 4, sectorIndex: 1 },
    { ringIndex: 4, sectorIndex: 2 },
  ],
];

function resolveOrderedVisibleTeamGraphOwnerIds(
  members: readonly TeamGraphDefaultLayoutMemberInput[],
  configMembers: readonly TeamGraphDefaultLayoutMemberInput[] = []
): { orderedVisibleOwnerIds: string[]; duplicateStableOwnerIds: string[] } {
  const visibleMembers = members.filter((member) => !member.removedAt && !isLeadMember(member));
  if (visibleMembers.length === 0) {
    return { orderedVisibleOwnerIds: [], duplicateStableOwnerIds: [] };
  }

  const visibleMemberByStableOwnerId = new Map<string, TeamGraphDefaultLayoutMemberInput>();
  const duplicateStableOwnerIds = new Set<string>();
  for (const member of visibleMembers) {
    const stableOwnerId = getStableTeamOwnerId(member);
    if (visibleMemberByStableOwnerId.has(stableOwnerId)) {
      duplicateStableOwnerIds.add(stableOwnerId);
      continue;
    }
    visibleMemberByStableOwnerId.set(stableOwnerId, member);
  }
  if (duplicateStableOwnerIds.size > 0) {
    return {
      orderedVisibleOwnerIds: [],
      duplicateStableOwnerIds: [...duplicateStableOwnerIds].toSorted((left, right) =>
        left.localeCompare(right)
      ),
    };
  }

  const orderedVisibleOwnerIds: string[] = [];
  const seenVisibleOwnerIds = new Set<string>();

  for (const configMember of configMembers) {
    if (configMember.removedAt || isLeadMember(configMember)) {
      continue;
    }
    const stableOwnerId = getStableTeamOwnerId(configMember);
    if (
      !visibleMemberByStableOwnerId.has(stableOwnerId) ||
      seenVisibleOwnerIds.has(stableOwnerId)
    ) {
      continue;
    }
    orderedVisibleOwnerIds.push(stableOwnerId);
    seenVisibleOwnerIds.add(stableOwnerId);
  }

  const remainingVisibleOwnerIds = [...visibleMemberByStableOwnerId.keys()]
    .filter((stableOwnerId) => !seenVisibleOwnerIds.has(stableOwnerId))
    .toSorted((left, right) => left.localeCompare(right));

  orderedVisibleOwnerIds.push(...remainingVisibleOwnerIds);
  return { orderedVisibleOwnerIds, duplicateStableOwnerIds: [] };
}

export function buildOrderedVisibleTeamGraphOwnerIds(
  members: readonly TeamGraphDefaultLayoutMemberInput[],
  configMembers: readonly TeamGraphDefaultLayoutMemberInput[] = []
): string[] {
  return resolveOrderedVisibleTeamGraphOwnerIds(members, configMembers).orderedVisibleOwnerIds;
}

export function buildTeamGraphDefaultLayoutSeed(
  members: readonly TeamGraphDefaultLayoutMemberInput[],
  configMembers: readonly TeamGraphDefaultLayoutMemberInput[] = []
): TeamGraphDefaultLayoutSeed {
  const { orderedVisibleOwnerIds, duplicateStableOwnerIds } =
    resolveOrderedVisibleTeamGraphOwnerIds(members, configMembers);
  const signature = orderedVisibleOwnerIds.length > 0 ? orderedVisibleOwnerIds.join('|') : null;
  const preset = DEFAULT_OWNER_SLOT_PRESETS[orderedVisibleOwnerIds.length];
  const assignments: Record<string, GraphOwnerSlotAssignment> = {};

  if (preset?.length === orderedVisibleOwnerIds.length) {
    orderedVisibleOwnerIds.forEach((stableOwnerId, index) => {
      assignments[stableOwnerId] = preset[index]!;
    });
  }

  return {
    orderedVisibleOwnerIds,
    signature,
    assignments,
    duplicateStableOwnerIds,
  };
}
