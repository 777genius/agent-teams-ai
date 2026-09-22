import {
  type TeamGraphLayoutActions,
  type TeamGraphLayoutDiagnostic,
  type TeamGraphLayoutState,
  type TeamGraphLayoutStatePatch,
  type TeamGraphLayoutTransition,
} from '../domain/teamGraphLayoutState';
import {
  assignTeamGraphOwnerSlot,
  changeTeamGraphLayoutMode,
  clearTeamGraphLayout,
  commitTeamGraphOwnerSlotDrop,
  ensureTeamGraphLayoutState,
  resetTeamGraphLayoutToDefaults,
  swapTeamGraphGridOwners,
  swapTeamGraphOwnerSlots,
} from '../domain/teamGraphLayoutTransitions';

import type { TeamGraphDefaultLayoutSeed } from '../domain/teamGraphDefaultLayout';

interface TeamGraphLayoutActionPorts<TState extends TeamGraphLayoutState> {
  setState: (updater: (state: TState) => TeamGraphLayoutStatePatch | null) => void;
  selectDefaultLayoutSeed: (state: TState, teamName: string) => TeamGraphDefaultLayoutSeed | null;
  warn: (message: string) => void;
}

function formatDiagnostic(diagnostic: TeamGraphLayoutDiagnostic): string {
  switch (diagnostic.code) {
    case 'duplicate-stable-owner-id':
      return (
        `[graph-layout] refusing duplicate owner identities team=${diagnostic.teamName} ` +
        `owners=${diagnostic.duplicateStableOwnerIds.join(',')}`
      );
    case 'invalid-team-name':
      return '[graph-layout] refusing blank team name';
    case 'invalid-slot-assignment':
      return (
        `[graph-layout] refusing invalid ${diagnostic.assignmentRole} slot assignment ` +
        `team=${diagnostic.teamName} owner=${diagnostic.stableOwnerId} ` +
        `target=${diagnostic.assignment.ringIndex}:${diagnostic.assignment.sectorIndex}`
      );
    case 'incomplete-slot-drop-displacement':
      return (
        `[graph-layout] refusing incomplete slot drop team=${diagnostic.teamName} ` +
        `owner=${diagnostic.stableOwnerId} ` +
        `target=${diagnostic.assignment.ringIndex}:${diagnostic.assignment.sectorIndex}`
      );
    case 'inconsistent-slot-drop-displacement':
      return (
        `[graph-layout] refusing inconsistent slot drop team=${diagnostic.teamName} ` +
        `owner=${diagnostic.stableOwnerId} displaced=${diagnostic.displacedStableOwnerId} ` +
        `target=${diagnostic.assignment.ringIndex}:${diagnostic.assignment.sectorIndex} ` +
        `reason=${diagnostic.reason}`
      );
    case 'occupied-slot-assignment':
      return (
        `[graph-layout] refusing occupied slot assignment team=${diagnostic.teamName} ` +
        `owner=${diagnostic.stableOwnerId} ` +
        `target=${diagnostic.assignment.ringIndex}:${diagnostic.assignment.sectorIndex} ` +
        `occupiedBy=${diagnostic.conflictingStableOwnerId}`
      );
    case 'slot-drop-conflict':
      return (
        `[graph-layout] refusing slot drop team=${diagnostic.teamName} ` +
        `owner=${diagnostic.stableOwnerId} ` +
        `target=${diagnostic.assignment.ringIndex}:${diagnostic.assignment.sectorIndex} ` +
        `conflict=${diagnostic.conflictingStableOwnerId}`
      );
  }
}

function resolveTransition(
  transition: TeamGraphLayoutTransition,
  warn: (message: string) => void
): TeamGraphLayoutStatePatch | null {
  if (transition.kind === 'updated') {
    return transition.patch;
  }
  if (transition.kind === 'refused') {
    warn(formatDiagnostic(transition.diagnostic));
  }
  return null;
}

export function createTeamGraphLayoutActions<TState extends TeamGraphLayoutState>(
  ports: TeamGraphLayoutActionPorts<TState>
): TeamGraphLayoutActions {
  const apply = (transition: (state: TState) => TeamGraphLayoutTransition): void => {
    ports.setState((state) => resolveTransition(transition(state), ports.warn));
  };

  return {
    ensureTeamGraphSlotAssignments: (teamName, members, configMembers = []) => {
      apply((state) => ensureTeamGraphLayoutState(state, teamName, members, configMembers));
    },
    setTeamGraphOwnerSlotAssignment: (teamName, stableOwnerId, assignment) => {
      apply((state) => assignTeamGraphOwnerSlot(state, teamName, stableOwnerId, assignment));
    },
    commitTeamGraphOwnerSlotDrop: (
      teamName,
      stableOwnerId,
      assignment,
      displacedStableOwnerId,
      displacedAssignment
    ) => {
      apply((state) => {
        const visibleOwnerIds =
          ports.selectDefaultLayoutSeed(state, teamName)?.orderedVisibleOwnerIds ?? [];
        return commitTeamGraphOwnerSlotDrop(
          state,
          teamName,
          stableOwnerId,
          assignment,
          displacedStableOwnerId,
          displacedAssignment,
          visibleOwnerIds
        );
      });
    },
    setTeamGraphLayoutMode: (teamName, mode) => {
      apply((state) => changeTeamGraphLayoutMode(state, teamName, mode));
    },
    swapTeamGraphGridOwners: (teamName, stableOwnerId, targetStableOwnerId) => {
      if (stableOwnerId === targetStableOwnerId) {
        return;
      }
      apply((state) => {
        const defaultSeed = ports.selectDefaultLayoutSeed(state, teamName);
        const fallbackVisibleOwnerIds = [...(state.gridOwnerOrderByTeam[teamName] ?? [])];
        for (const ownerId of [stableOwnerId, targetStableOwnerId]) {
          if (!fallbackVisibleOwnerIds.includes(ownerId)) {
            fallbackVisibleOwnerIds.push(ownerId);
          }
        }
        const visibleOwnerIds = defaultSeed?.orderedVisibleOwnerIds ?? fallbackVisibleOwnerIds;
        return swapTeamGraphGridOwners(
          state,
          teamName,
          stableOwnerId,
          targetStableOwnerId,
          visibleOwnerIds
        );
      });
    },
    swapTeamGraphOwnerSlots: (teamName, stableOwnerId, otherStableOwnerId) => {
      if (stableOwnerId === otherStableOwnerId) {
        return;
      }
      apply((state) => swapTeamGraphOwnerSlots(state, teamName, stableOwnerId, otherStableOwnerId));
    },
    clearTeamGraphSlotAssignments: (teamName) => {
      apply((state) => clearTeamGraphLayout(state, teamName));
    },
    resetTeamGraphSlotAssignmentsToDefaults: (teamName) => {
      apply((state) => {
        const defaultSeed = ports.selectDefaultLayoutSeed(state, teamName) ?? {
          orderedVisibleOwnerIds: [],
          signature: null,
          assignments: {},
          duplicateStableOwnerIds: [],
        };
        return resetTeamGraphLayoutToDefaults(state, teamName, defaultSeed);
      });
    },
  };
}
