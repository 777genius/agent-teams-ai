import { useLayoutEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTeamGraphSlotPersistenceDisabled } from '@renderer/store/slices/teamSlice';

export function useTeamGraphSlotReset(teamName: string, enabled = true): void {
  const resetTeamGraphSlotAssignmentsToDefaults = useStore(
    (s) => s.resetTeamGraphSlotAssignmentsToDefaults
  );

  useLayoutEffect(() => {
    if (!enabled || !isTeamGraphSlotPersistenceDisabled()) {
      return;
    }

    resetTeamGraphSlotAssignmentsToDefaults(teamName);
  }, [enabled, resetTeamGraphSlotAssignmentsToDefaults, teamName]);
}
