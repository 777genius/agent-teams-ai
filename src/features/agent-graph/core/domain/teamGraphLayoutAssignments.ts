import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import { buildTeamGraphDefaultLayoutSeed } from './teamGraphDefaultLayout';
import {
  DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS,
  type TeamGraphConfigMemberSeedInput,
  type TeamGraphMemberSeedInput,
  type TeamGraphSlotAssignments,
} from './teamGraphLayoutState';

export function migrateStableSlotAssignmentsForMembers(
  assignments: TeamGraphSlotAssignments | undefined,
  members: readonly TeamGraphMemberSeedInput[]
): { assignments: TeamGraphSlotAssignments; changed: boolean } {
  const nextAssignments: TeamGraphSlotAssignments = { ...(assignments ?? {}) };
  let changed = false;

  for (const member of members) {
    const fallbackKey = member.name.trim();
    const stableOwnerId = getStableTeamOwnerId(member);
    const fallbackAssignment = nextAssignments[fallbackKey];
    const stableAssignment = nextAssignments[stableOwnerId];

    if (stableOwnerId !== fallbackKey && fallbackAssignment && !stableAssignment) {
      nextAssignments[stableOwnerId] = fallbackAssignment;
      delete nextAssignments[fallbackKey];
      changed = true;
      continue;
    }

    if (stableOwnerId !== fallbackKey && fallbackAssignment && stableAssignment) {
      delete nextAssignments[fallbackKey];
      changed = true;
    }
  }

  return { assignments: nextAssignments, changed };
}

export function seedStableSlotAssignmentsForMembers(
  assignments: TeamGraphSlotAssignments,
  members: readonly TeamGraphMemberSeedInput[],
  configMembers: readonly TeamGraphConfigMemberSeedInput[] = []
): { assignments: TeamGraphSlotAssignments; changed: boolean } {
  const defaultSeed = buildTeamGraphDefaultLayoutSeed(members, configMembers);
  if (
    defaultSeed.orderedVisibleOwnerIds.length === 0 ||
    Object.keys(defaultSeed.assignments).length === 0
  ) {
    return { assignments, changed: false };
  }

  const visibleStableOwnerIds = defaultSeed.orderedVisibleOwnerIds;
  const hasAnyVisibleAssignments = visibleStableOwnerIds.some(
    (stableOwnerId) => assignments[stableOwnerId] != null
  );
  if (hasAnyVisibleAssignments) {
    return { assignments, changed: false };
  }

  const nextAssignments: TeamGraphSlotAssignments = { ...assignments };
  visibleStableOwnerIds.forEach((stableOwnerId) => {
    nextAssignments[stableOwnerId] = defaultSeed.assignments[stableOwnerId]!;
  });

  return { assignments: nextAssignments, changed: true };
}

export function areTeamGraphSlotAssignmentsEqual(
  left: TeamGraphSlotAssignments | undefined,
  right: TeamGraphSlotAssignments | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (const [stableOwnerId, leftAssignment] of leftEntries) {
    const rightAssignment = right?.[stableOwnerId];
    if (
      rightAssignment?.ringIndex !== leftAssignment.ringIndex ||
      rightAssignment.sectorIndex !== leftAssignment.sectorIndex
    ) {
      return false;
    }
  }

  return true;
}

export function normalizeTeamGraphSlotAssignmentsForVisibleOwners(
  assignments: TeamGraphSlotAssignments | undefined,
  visibleOwnerIds: readonly string[]
): TeamGraphSlotAssignments {
  if (visibleOwnerIds.length === 0 || !assignments) {
    return {};
  }

  const normalizedAssignments: TeamGraphSlotAssignments = {};
  for (const stableOwnerId of visibleOwnerIds) {
    const assignment = assignments[stableOwnerId];
    if (!assignment) {
      continue;
    }
    normalizedAssignments[stableOwnerId] = assignment;
  }
  return normalizeLegacySixRowOrbitAssignments(normalizedAssignments, visibleOwnerIds);
}

export function normalizeLegacySixRowOrbitAssignments(
  assignments: TeamGraphSlotAssignments,
  visibleOwnerIds: readonly string[]
): TeamGraphSlotAssignments {
  if (visibleOwnerIds.length !== 6) {
    return assignments;
  }

  const visibleAssignments = visibleOwnerIds.flatMap((stableOwnerId) => {
    const assignment = assignments[stableOwnerId];
    return assignment ? [assignment] : [];
  });
  const hasLegacyTwoRowBottomMarker = visibleAssignments.some(
    (assignment) => assignment.ringIndex === 1 && assignment.sectorIndex === 2
  );
  let changed = false;
  const normalizedAssignments: TeamGraphSlotAssignments = { ...assignments };

  for (const stableOwnerId of visibleOwnerIds) {
    const assignment = normalizedAssignments[stableOwnerId];
    if (!assignment) {
      continue;
    }

    if (
      hasLegacyTwoRowBottomMarker &&
      assignment.ringIndex === 1 &&
      assignment.sectorIndex >= 0 &&
      assignment.sectorIndex < 3
    ) {
      normalizedAssignments[stableOwnerId] = {
        ringIndex: 2,
        sectorIndex: assignment.sectorIndex,
      };
      changed = true;
      continue;
    }

    if (assignment.ringIndex === 0 && assignment.sectorIndex >= 3 && assignment.sectorIndex < 6) {
      normalizedAssignments[stableOwnerId] = {
        ringIndex: 2,
        sectorIndex: assignment.sectorIndex - 3,
      };
      changed = true;
    }
  }

  return changed ? normalizedAssignments : assignments;
}

export function pruneTeamGraphSlotAssignmentsForVisibleOwners(
  assignments: TeamGraphSlotAssignments | undefined,
  visibleOwnerIds: readonly string[]
): TeamGraphSlotAssignments | undefined {
  const normalizedAssignments = normalizeTeamGraphSlotAssignmentsForVisibleOwners(
    assignments,
    visibleOwnerIds
  );
  return Object.keys(normalizedAssignments).length > 0 ? normalizedAssignments : undefined;
}

export function normalizeTeamGraphGridOwnerOrder(
  order: readonly string[] | undefined,
  visibleOwnerIds: readonly string[]
): string[] {
  const visibleOwnerIdSet = new Set(visibleOwnerIds);
  const normalizedOrder: string[] = [];
  const seenOwnerIds = new Set<string>();

  for (const stableOwnerId of order ?? []) {
    if (!visibleOwnerIdSet.has(stableOwnerId) || seenOwnerIds.has(stableOwnerId)) {
      continue;
    }
    normalizedOrder.push(stableOwnerId);
    seenOwnerIds.add(stableOwnerId);
  }

  for (const stableOwnerId of visibleOwnerIds) {
    if (seenOwnerIds.has(stableOwnerId)) {
      continue;
    }
    normalizedOrder.push(stableOwnerId);
    seenOwnerIds.add(stableOwnerId);
  }

  return normalizedOrder;
}

export function getDefaultTeamGraphSlotAssignmentsForMembers(
  members: readonly TeamGraphMemberSeedInput[],
  configMembers: readonly TeamGraphConfigMemberSeedInput[] = []
): TeamGraphSlotAssignments {
  return buildTeamGraphDefaultLayoutSeed(members, configMembers).assignments;
}

export function isTeamGraphSlotPersistenceDisabled(): boolean {
  return DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS;
}
