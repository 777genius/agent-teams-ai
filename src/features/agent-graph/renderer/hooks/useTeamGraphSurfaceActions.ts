import { useCallback } from 'react';

import { useStore } from '@renderer/store';
import { isTeamGraphSlotPersistenceDisabled } from '@renderer/store/slices/teamSlice';

import { parseGraphMemberNodeId } from '../../core/domain/graphOwnerIdentity';

import type { GraphLayoutMode, GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';

export function useTeamGraphSurfaceActions(teamName: string): {
  openTeamPage: () => void;
  resetOwnerSlotAssignmentsToDefaults: () => void;
  commitOwnerSlotDrop: (payload: {
    nodeId: string;
    assignment: GraphOwnerSlotAssignment;
    displacedNodeId?: string;
    displacedAssignment?: GraphOwnerSlotAssignment;
  }) => void;
  commitOwnerGridOrderDrop: (payload: { nodeId: string; targetNodeId: string }) => void;
  setLayoutMode: (mode: GraphLayoutMode) => void;
} {
  const openTeamPage = useCallback(() => {
    useStore.getState().openTeamTab(teamName);
  }, [teamName]);

  const resetOwnerSlotAssignmentsToDefaults = useCallback(() => {
    if (!isTeamGraphSlotPersistenceDisabled()) {
      return;
    }
    useStore.getState().resetTeamGraphSlotAssignmentsToDefaults(teamName);
  }, [teamName]);

  const commitOwnerSlotDrop = useCallback(
    (payload: {
      nodeId: string;
      assignment: GraphOwnerSlotAssignment;
      displacedNodeId?: string;
      displacedAssignment?: GraphOwnerSlotAssignment;
    }) => {
      const stableOwnerId = parseGraphMemberNodeId(payload.nodeId, teamName);
      if (!stableOwnerId) {
        return;
      }
      const displacedStableOwnerId = payload.displacedNodeId
        ? parseGraphMemberNodeId(payload.displacedNodeId, teamName)
        : null;
      const store = useStore.getState();
      if ((store.graphLayoutModeByTeam[teamName] ?? 'radial') !== 'radial') {
        return;
      }
      if (displacedStableOwnerId && payload.displacedAssignment) {
        store.commitTeamGraphOwnerSlotDrop(
          teamName,
          stableOwnerId,
          payload.assignment,
          displacedStableOwnerId,
          payload.displacedAssignment
        );
        return;
      }
      store.setTeamGraphOwnerSlotAssignment(teamName, stableOwnerId, payload.assignment);
    },
    [teamName]
  );

  const commitOwnerGridOrderDrop = useCallback(
    (payload: { nodeId: string; targetNodeId: string }) => {
      const stableOwnerId = parseGraphMemberNodeId(payload.nodeId, teamName);
      const targetStableOwnerId = parseGraphMemberNodeId(payload.targetNodeId, teamName);
      if (!stableOwnerId || !targetStableOwnerId || stableOwnerId === targetStableOwnerId) {
        return;
      }

      const store = useStore.getState();
      if ((store.graphLayoutModeByTeam[teamName] ?? 'radial') !== 'grid-under-lead') {
        return;
      }

      store.swapTeamGraphGridOwners(teamName, stableOwnerId, targetStableOwnerId);
    },
    [teamName]
  );

  const setLayoutMode = useCallback(
    (mode: GraphLayoutMode) => {
      useStore.getState().setTeamGraphLayoutMode(teamName, mode);
    },
    [teamName]
  );

  return {
    openTeamPage,
    resetOwnerSlotAssignmentsToDefaults,
    commitOwnerSlotDrop,
    commitOwnerGridOrderDrop,
    setLayoutMode,
  };
}
