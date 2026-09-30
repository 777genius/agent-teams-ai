import { useEffect, useRef } from 'react';

import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';
import type { TeamId } from '@shared/contracts/hosted';

/** Reconciles a selected team only against causally current, complete directory evidence. */
export function useHostedTeamSelectionReconciliation(
  state: HostedTeamDirectoryReadState,
  selectedTeamId: TeamId | null,
  selectedTeamReady: boolean,
  clearSelection: () => void
): Readonly<{ recordCreated: (teamId: TeamId) => void; recordDeleted: (teamId: TeamId) => void }> {
  const pendingCreatedTeam = useRef<TeamId | null>(null);
  const confirmedSelectedTeam = useRef<TeamId | null>(null);
  const minimumReconcileReadEpoch = useRef(0);
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;

  useEffect(() => {
    const snapshot = state.snapshot;
    if (
      selectedTeamId === null ||
      snapshot === null ||
      state.freshness !== 'fresh' ||
      snapshot.readStartedAtWatermark !== state.watermark
    )
      return;
    if (snapshot.items.some((item) => item.teamId === selectedTeamId)) {
      confirmedSelectedTeam.current = selectedTeamId;
      minimumReconcileReadEpoch.current = snapshot.readEpoch;
      if (pendingCreatedTeam.current === selectedTeamId) pendingCreatedTeam.current = null;
    } else if (
      confirmedSelectedTeam.current === selectedTeamId &&
      pendingCreatedTeam.current !== selectedTeamId &&
      snapshot.readEpoch > minimumReconcileReadEpoch.current
    ) {
      confirmedSelectedTeam.current = null;
      clearSelectionRef.current();
    }
  }, [state, selectedTeamId]);

  useEffect(() => {
    if (
      !selectedTeamReady ||
      selectedTeamId === null ||
      pendingCreatedTeam.current !== selectedTeamId
    )
      return;
    // A scoped bootstrap proves presence; skip the first later list, which may have started earlier.
    confirmedSelectedTeam.current = selectedTeamId;
    minimumReconcileReadEpoch.current = (state.snapshot?.readEpoch ?? 0) + 1;
    pendingCreatedTeam.current = null;
  }, [state.snapshot?.readEpoch, selectedTeamId, selectedTeamReady]);

  return {
    recordCreated(teamId) {
      pendingCreatedTeam.current = teamId;
      confirmedSelectedTeam.current = null;
      minimumReconcileReadEpoch.current = 0;
    },
    recordDeleted(teamId) {
      if (pendingCreatedTeam.current === teamId) pendingCreatedTeam.current = null;
      if (confirmedSelectedTeam.current === teamId) confirmedSelectedTeam.current = null;
    },
  };
}
