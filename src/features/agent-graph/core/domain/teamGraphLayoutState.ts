import type { GraphLayoutMode, GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';
import type { TeamMemberSnapshot, TeamViewSnapshot } from '@shared/types';

export const GRAPH_STABLE_SLOT_LAYOUT_VERSION = 'stable-slots-v1' as const;
export const DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS = true;

export type TeamGraphSlotAssignments = Record<string, GraphOwnerSlotAssignment>;
export type TeamGraphMemberSeedInput = Pick<TeamMemberSnapshot, 'name' | 'agentId' | 'removedAt'>;
export type TeamGraphConfigMemberSeedInput = Pick<
  NonNullable<TeamViewSnapshot['config']['members']>[number],
  'name' | 'agentId' | 'removedAt'
>;

export interface TeamGraphLayoutSessionState {
  mode: 'default' | 'manual';
  signature: string | null;
}

export interface TeamGraphLayoutState {
  slotLayoutVersion: string;
  graphLayoutModeByTeam: Record<string, GraphLayoutMode>;
  gridOwnerOrderByTeam: Record<string, string[]>;
  slotAssignmentsByTeam: Record<string, TeamGraphSlotAssignments>;
  graphLayoutSessionByTeam: Record<string, TeamGraphLayoutSessionState>;
}

export interface TeamGraphLayoutActions {
  ensureTeamGraphSlotAssignments: (
    teamName: string,
    members: readonly TeamGraphMemberSeedInput[],
    configMembers?: readonly TeamGraphConfigMemberSeedInput[]
  ) => void;
  setTeamGraphOwnerSlotAssignment: (
    teamName: string,
    stableOwnerId: string,
    assignment: GraphOwnerSlotAssignment
  ) => void;
  commitTeamGraphOwnerSlotDrop: (
    teamName: string,
    stableOwnerId: string,
    assignment: GraphOwnerSlotAssignment,
    displacedStableOwnerId?: string,
    displacedAssignment?: GraphOwnerSlotAssignment
  ) => void;
  setTeamGraphLayoutMode: (teamName: string, mode: GraphLayoutMode) => void;
  swapTeamGraphGridOwners: (
    teamName: string,
    stableOwnerId: string,
    targetStableOwnerId: string
  ) => void;
  swapTeamGraphOwnerSlots: (
    teamName: string,
    stableOwnerId: string,
    otherStableOwnerId: string
  ) => void;
  clearTeamGraphSlotAssignments: (teamName?: string) => void;
  resetTeamGraphSlotAssignmentsToDefaults: (teamName: string) => void;
}

export type TeamGraphLayoutSlice = TeamGraphLayoutState & TeamGraphLayoutActions;
export type TeamGraphLayoutStatePatch = Partial<TeamGraphLayoutState>;

export type TeamGraphLayoutDiagnostic =
  | {
      code: 'duplicate-stable-owner-id';
      teamName: string;
      duplicateStableOwnerIds: string[];
    }
  | {
      code: 'invalid-slot-assignment';
      teamName: string;
      stableOwnerId: string;
      assignment: GraphOwnerSlotAssignment;
      assignmentRole: 'target' | 'displaced';
    }
  | {
      code: 'invalid-team-name';
      teamName: string;
    }
  | {
      code: 'occupied-slot-assignment';
      teamName: string;
      stableOwnerId: string;
      assignment: GraphOwnerSlotAssignment;
      conflictingStableOwnerId: string;
    }
  | {
      code: 'incomplete-slot-drop-displacement';
      teamName: string;
      stableOwnerId: string;
      assignment: GraphOwnerSlotAssignment;
    }
  | {
      code: 'inconsistent-slot-drop-displacement';
      teamName: string;
      stableOwnerId: string;
      assignment: GraphOwnerSlotAssignment;
      displacedStableOwnerId: string;
      reason:
        | 'same-owner'
        | 'same-slot'
        | 'missing-source-owner'
        | 'missing-displaced-owner'
        | 'stale-source-assignment'
        | 'stale-displaced-assignment';
    }
  | {
      code: 'slot-drop-conflict';
      teamName: string;
      stableOwnerId: string;
      assignment: GraphOwnerSlotAssignment;
      conflictingStableOwnerId: string;
    };

export type TeamGraphLayoutTransition =
  | { kind: 'updated'; patch: TeamGraphLayoutStatePatch }
  | { kind: 'unchanged' }
  | { kind: 'refused'; diagnostic: TeamGraphLayoutDiagnostic };

export function createInitialTeamGraphLayoutState(): TeamGraphLayoutState {
  return {
    slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
    graphLayoutModeByTeam: {},
    gridOwnerOrderByTeam: {},
    slotAssignmentsByTeam: {},
    graphLayoutSessionByTeam: {},
  };
}
