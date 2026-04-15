import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { TeamGraphData } from '../adapters/TeamGraphAdapter';

export function useGraphMemberPopoverContext(teamName: string, memberName: string) {
  return useStore(
    useShallow((state) => {
      const snapshot = teamName ? selectTeamDataForName(state, teamName) : null;
      const teamMembers = teamName ? selectResolvedMembersForTeamName(state, teamName) : [];

      return {
        teamData: snapshot
          ? {
              ...snapshot,
              members: teamMembers,
              messageFeed: [],
            }
          : null,
        teamMembers,
        spawnEntry: teamName ? state.memberSpawnStatusesByTeam[teamName]?.[memberName] : undefined,
        leadActivity: teamName ? state.leadActivityByTeam[teamName] : undefined,
        progress: teamName ? getCurrentProvisioningProgressForTeam(state, teamName) : null,
        memberSpawnSnapshot: teamName ? state.memberSpawnSnapshotsByTeam[teamName] : undefined,
        memberSpawnStatuses: teamName ? state.memberSpawnStatusesByTeam[teamName] : undefined,
      };
    })
  );
}
