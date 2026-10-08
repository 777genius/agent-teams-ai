import { DEFAULT_TEAM_GRAPH_LAYOUT_MODE } from '@shared/constants/teamGraphLayoutMode';

import {
  buildTeamGraphDefaultLayoutSeed,
  type TeamGraphDefaultLayoutSeed,
} from './teamGraphDefaultLayout';
import {
  areTeamGraphSlotAssignmentsEqual,
  migrateStableSlotAssignmentsForMembers,
  normalizeTeamGraphGridOwnerOrder,
  pruneTeamGraphSlotAssignmentsForVisibleOwners,
  seedStableSlotAssignmentsForMembers,
} from './teamGraphLayoutAssignments';
import {
  DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS,
  GRAPH_STABLE_SLOT_LAYOUT_VERSION,
  type TeamGraphConfigMemberSeedInput,
  type TeamGraphLayoutState,
  type TeamGraphLayoutStatePatch,
  type TeamGraphLayoutTransition,
  type TeamGraphMemberSeedInput,
  type TeamGraphSlotAssignments,
} from './teamGraphLayoutState';

import type { GraphLayoutMode, GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';

const UNCHANGED: TeamGraphLayoutTransition = { kind: 'unchanged' };

function updated(patch: TeamGraphLayoutStatePatch): TeamGraphLayoutTransition {
  return { kind: 'updated', patch };
}

function areSlotAssignmentsEqual(
  left: GraphOwnerSlotAssignment | undefined,
  right: GraphOwnerSlotAssignment
): boolean {
  return left?.ringIndex === right.ringIndex && left?.sectorIndex === right.sectorIndex;
}

export function ensureTeamGraphLayoutState(
  state: TeamGraphLayoutState,
  teamName: string,
  members: readonly TeamGraphMemberSeedInput[],
  configMembers: readonly TeamGraphConfigMemberSeedInput[] = []
): TeamGraphLayoutTransition {
  const defaultSeed = buildTeamGraphDefaultLayoutSeed(members, configMembers);
  const nextState: TeamGraphLayoutStatePatch = {};
  let changed = false;

  let nextSlotAssignmentsByTeam = state.slotAssignmentsByTeam;
  let nextGraphLayoutSessionByTeam = state.graphLayoutSessionByTeam;
  if (state.slotLayoutVersion !== GRAPH_STABLE_SLOT_LAYOUT_VERSION) {
    nextState.slotLayoutVersion = GRAPH_STABLE_SLOT_LAYOUT_VERSION;
    nextSlotAssignmentsByTeam = {};
    nextGraphLayoutSessionByTeam = {};
    changed = true;
  }

  const visibleAssignments = pruneTeamGraphSlotAssignmentsForVisibleOwners(
    nextSlotAssignmentsByTeam[teamName],
    defaultSeed.orderedVisibleOwnerIds
  );
  const currentSession = nextGraphLayoutSessionByTeam[teamName];

  if (DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS) {
    if (currentSession?.mode === 'manual') {
      if (
        !areTeamGraphSlotAssignmentsEqual(nextSlotAssignmentsByTeam[teamName], visibleAssignments)
      ) {
        nextSlotAssignmentsByTeam = { ...nextSlotAssignmentsByTeam };
        if (visibleAssignments) {
          nextSlotAssignmentsByTeam[teamName] = visibleAssignments;
        } else {
          delete nextSlotAssignmentsByTeam[teamName];
        }
        changed = true;
      }
    } else {
      if (
        !areTeamGraphSlotAssignmentsEqual(
          nextSlotAssignmentsByTeam[teamName],
          visibleAssignments
        ) ||
        !areTeamGraphSlotAssignmentsEqual(visibleAssignments, defaultSeed.assignments)
      ) {
        nextSlotAssignmentsByTeam = { ...nextSlotAssignmentsByTeam };
        if (Object.keys(defaultSeed.assignments).length === 0) {
          delete nextSlotAssignmentsByTeam[teamName];
        } else {
          nextSlotAssignmentsByTeam[teamName] = defaultSeed.assignments;
        }
        changed = true;
      }
      if (
        currentSession?.mode !== 'default' ||
        currentSession?.signature !== defaultSeed.signature
      ) {
        nextGraphLayoutSessionByTeam = {
          ...nextGraphLayoutSessionByTeam,
          [teamName]: {
            mode: 'default',
            signature: defaultSeed.signature,
          },
        };
        changed = true;
      }
    }

    if (!changed) {
      return UNCHANGED;
    }

    nextState.slotAssignmentsByTeam = nextSlotAssignmentsByTeam;
    nextState.graphLayoutSessionByTeam = nextGraphLayoutSessionByTeam;
    return updated(nextState);
  }

  const currentAssignments = nextSlotAssignmentsByTeam[teamName];
  const migrated = migrateStableSlotAssignmentsForMembers(currentAssignments, members);
  const seeded = seedStableSlotAssignmentsForMembers(migrated.assignments, members, configMembers);
  if (migrated.changed || seeded.changed) {
    nextSlotAssignmentsByTeam = {
      ...nextSlotAssignmentsByTeam,
      [teamName]: seeded.assignments,
    };
    changed = true;
  }

  if (!changed) {
    return UNCHANGED;
  }

  nextState.slotAssignmentsByTeam = nextSlotAssignmentsByTeam;
  if (nextGraphLayoutSessionByTeam !== state.graphLayoutSessionByTeam) {
    nextState.graphLayoutSessionByTeam = nextGraphLayoutSessionByTeam;
  }
  return updated(nextState);
}

export function assignTeamGraphOwnerSlot(
  state: TeamGraphLayoutState,
  teamName: string,
  stableOwnerId: string,
  assignment: GraphOwnerSlotAssignment
): TeamGraphLayoutTransition {
  const writable = state;
  const currentAssignments = writable.slotAssignmentsByTeam[teamName] ?? {};
  const existing = currentAssignments[stableOwnerId];
  const occupiedByOther = Object.entries(currentAssignments).find(
    ([otherStableOwnerId, otherAssignment]) =>
      otherStableOwnerId !== stableOwnerId &&
      otherAssignment.ringIndex === assignment.ringIndex &&
      otherAssignment.sectorIndex === assignment.sectorIndex
  );

  if (
    areSlotAssignmentsEqual(existing, assignment) &&
    state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION
  ) {
    return UNCHANGED;
  }

  if (occupiedByOther) {
    return {
      kind: 'refused',
      diagnostic: {
        code: 'occupied-slot-assignment',
        teamName,
        stableOwnerId,
        assignment,
        conflictingStableOwnerId: occupiedByOther[0],
      },
    };
  }

  return updated({
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    slotAssignmentsByTeam: {
      ...writable.slotAssignmentsByTeam,
      [teamName]: {
        ...currentAssignments,
        [stableOwnerId]: assignment,
      },
    },
    graphLayoutSessionByTeam: {
      ...writable.graphLayoutSessionByTeam,
      [teamName]: {
        mode: 'manual',
        signature: writable.graphLayoutSessionByTeam[teamName]?.signature ?? null,
      },
    },
  });
}

export function commitTeamGraphOwnerSlotDrop(
  state: TeamGraphLayoutState,
  teamName: string,
  stableOwnerId: string,
  assignment: GraphOwnerSlotAssignment,
  displacedStableOwnerId?: string,
  displacedAssignment?: GraphOwnerSlotAssignment
): TeamGraphLayoutTransition {
  const writable = state;
  const currentAssignments = writable.slotAssignmentsByTeam[teamName] ?? {};
  const existing = currentAssignments[stableOwnerId];

  if (
    areSlotAssignmentsEqual(existing, assignment) &&
    !displacedStableOwnerId &&
    state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION
  ) {
    return UNCHANGED;
  }

  const occupiedByConflict = Object.entries(currentAssignments).find(
    ([ownerId, nextAssignment]) => {
      if (ownerId === stableOwnerId || ownerId === displacedStableOwnerId) {
        return false;
      }
      return (
        areSlotAssignmentsEqual(nextAssignment, assignment) ||
        (displacedAssignment != null &&
          areSlotAssignmentsEqual(nextAssignment, displacedAssignment))
      );
    }
  );

  if (occupiedByConflict) {
    return {
      kind: 'refused',
      diagnostic: {
        code: 'slot-drop-conflict',
        teamName,
        stableOwnerId,
        assignment,
        conflictingStableOwnerId: occupiedByConflict[0],
      },
    };
  }

  const nextAssignments: TeamGraphSlotAssignments = {
    ...currentAssignments,
    [stableOwnerId]: assignment,
  };
  if (displacedStableOwnerId && displacedAssignment) {
    nextAssignments[displacedStableOwnerId] = displacedAssignment;
  }

  return updated({
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    slotAssignmentsByTeam: {
      ...writable.slotAssignmentsByTeam,
      [teamName]: nextAssignments,
    },
    graphLayoutSessionByTeam: {
      ...writable.graphLayoutSessionByTeam,
      [teamName]: {
        mode: 'manual',
        signature: writable.graphLayoutSessionByTeam[teamName]?.signature ?? null,
      },
    },
  });
}

export function changeTeamGraphLayoutMode(
  state: TeamGraphLayoutState,
  teamName: string,
  mode: GraphLayoutMode
): TeamGraphLayoutTransition {
  if ((state.graphLayoutModeByTeam[teamName] ?? DEFAULT_TEAM_GRAPH_LAYOUT_MODE) === mode) {
    return UNCHANGED;
  }

  return updated({
    graphLayoutModeByTeam: {
      ...state.graphLayoutModeByTeam,
      [teamName]: mode,
    },
  });
}

export function swapTeamGraphGridOwners(
  state: TeamGraphLayoutState,
  teamName: string,
  stableOwnerId: string,
  targetStableOwnerId: string,
  visibleOwnerIds: readonly string[]
): TeamGraphLayoutTransition {
  if (stableOwnerId === targetStableOwnerId) {
    return UNCHANGED;
  }

  const normalizedOrder = normalizeTeamGraphGridOwnerOrder(
    state.gridOwnerOrderByTeam[teamName],
    visibleOwnerIds
  );
  const stableOwnerIndex = normalizedOrder.indexOf(stableOwnerId);
  const targetOwnerIndex = normalizedOrder.indexOf(targetStableOwnerId);

  if (stableOwnerIndex < 0 || targetOwnerIndex < 0) {
    return UNCHANGED;
  }

  const nextOrder = [...normalizedOrder];
  nextOrder[stableOwnerIndex] = targetStableOwnerId;
  nextOrder[targetOwnerIndex] = stableOwnerId;

  return updated({
    gridOwnerOrderByTeam: {
      ...state.gridOwnerOrderByTeam,
      [teamName]: nextOrder,
    },
  });
}

export function swapTeamGraphOwnerSlots(
  state: TeamGraphLayoutState,
  teamName: string,
  stableOwnerId: string,
  otherStableOwnerId: string
): TeamGraphLayoutTransition {
  if (stableOwnerId === otherStableOwnerId) {
    return UNCHANGED;
  }

  const writable = state;
  const currentAssignments = writable.slotAssignmentsByTeam[teamName] ?? {};
  const left = currentAssignments[stableOwnerId];
  const right = currentAssignments[otherStableOwnerId];
  if (!left || !right) {
    return UNCHANGED;
  }

  return updated({
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    slotAssignmentsByTeam: {
      ...writable.slotAssignmentsByTeam,
      [teamName]: {
        ...currentAssignments,
        [stableOwnerId]: right,
        [otherStableOwnerId]: left,
      },
    },
    graphLayoutSessionByTeam: {
      ...writable.graphLayoutSessionByTeam,
      [teamName]: {
        mode: 'manual',
        signature: writable.graphLayoutSessionByTeam[teamName]?.signature ?? null,
      },
    },
  });
}

export function clearTeamGraphLayout(
  state: TeamGraphLayoutState,
  teamName?: string
): TeamGraphLayoutTransition {
  if (!teamName) {
    if (
      Object.keys(state.slotAssignmentsByTeam).length === 0 &&
      state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION &&
      Object.keys(state.graphLayoutSessionByTeam).length === 0
    ) {
      return UNCHANGED;
    }
    return updated({
      slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
      slotAssignmentsByTeam: {},
      graphLayoutSessionByTeam: {},
    });
  }

  if (!(teamName in state.slotAssignmentsByTeam) && !(teamName in state.graphLayoutSessionByTeam)) {
    return UNCHANGED;
  }

  const nextAssignmentsByTeam = { ...state.slotAssignmentsByTeam };
  const nextGraphLayoutSessionByTeam = { ...state.graphLayoutSessionByTeam };
  delete nextAssignmentsByTeam[teamName];
  delete nextGraphLayoutSessionByTeam[teamName];
  return updated({
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    slotAssignmentsByTeam: nextAssignmentsByTeam,
    graphLayoutSessionByTeam: nextGraphLayoutSessionByTeam,
  });
}

export function resetTeamGraphLayoutToDefaults(
  state: TeamGraphLayoutState,
  teamName: string,
  defaultSeed: TeamGraphDefaultLayoutSeed
): TeamGraphLayoutTransition {
  const writable = state;

  if (!DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS) {
    const currentAssignments = writable.slotAssignmentsByTeam[teamName];
    if (!currentAssignments || Object.keys(currentAssignments).length === 0) {
      return UNCHANGED;
    }

    const nextAssignmentsByTeam = { ...writable.slotAssignmentsByTeam };
    delete nextAssignmentsByTeam[teamName];
    return updated({
      slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
      slotAssignmentsByTeam: nextAssignmentsByTeam,
    });
  }

  const currentAssignments = writable.slotAssignmentsByTeam[teamName];
  const currentSession = writable.graphLayoutSessionByTeam[teamName];

  if (
    areTeamGraphSlotAssignmentsEqual(currentAssignments, defaultSeed.assignments) &&
    currentSession?.mode === 'default' &&
    currentSession.signature === defaultSeed.signature
  ) {
    return UNCHANGED;
  }

  const nextAssignmentsByTeam = { ...writable.slotAssignmentsByTeam };
  if (Object.keys(defaultSeed.assignments).length === 0) {
    delete nextAssignmentsByTeam[teamName];
  } else {
    nextAssignmentsByTeam[teamName] = defaultSeed.assignments;
  }

  return updated({
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    slotAssignmentsByTeam: nextAssignmentsByTeam,
    graphLayoutSessionByTeam: {
      ...writable.graphLayoutSessionByTeam,
      [teamName]: {
        mode: 'default',
        signature: defaultSeed.signature,
      },
    },
  });
}
