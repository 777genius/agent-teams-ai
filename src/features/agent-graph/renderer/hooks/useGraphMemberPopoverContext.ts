import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

import type { AppState } from '@renderer/store/types';

interface GraphMemberPopoverContext {
  teamData:
    | (NonNullable<ReturnType<typeof selectTeamDataForName>> & {
        members: ReturnType<typeof selectResolvedMembersForTeamName>;
        messageFeed: [];
      })
    | null;
  teamMembers: ReturnType<typeof selectResolvedMembersForTeamName>;
  spawnEntry: AppState['memberSpawnStatusesByTeam'][string][string] | undefined;
  runtimeEntry: AppState['teamAgentRuntimeByTeam'][string]['members'][string] | undefined;
  leadActivity: AppState['leadActivityByTeam'][string] | undefined;
  progress: ReturnType<typeof getCurrentProvisioningProgressForTeam> | null;
  memberSpawnSnapshot: AppState['memberSpawnSnapshotsByTeam'][string] | undefined;
  memberSpawnStatuses: AppState['memberSpawnStatusesByTeam'][string] | undefined;
}

function selectGraphMemberPopoverContext(
  state: AppState,
  teamName: string,
  memberName: string
): GraphMemberPopoverContext {
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
    runtimeEntry: teamName
      ? state.teamAgentRuntimeByTeam[teamName]?.members[memberName]
      : undefined,
    leadActivity: teamName ? state.leadActivityByTeam[teamName] : undefined,
    progress: teamName ? getCurrentProvisioningProgressForTeam(state, teamName) : null,
    memberSpawnSnapshot: teamName ? state.memberSpawnSnapshotsByTeam[teamName] : undefined,
    memberSpawnStatuses: teamName ? state.memberSpawnStatusesByTeam[teamName] : undefined,
  };
}

export function useGraphMemberPopoverContext(
  teamName: string,
  memberName: string
): ReturnType<typeof selectGraphMemberPopoverContext> {
  return useStore(
    useShallow((state) => selectGraphMemberPopoverContext(state, teamName, memberName))
  );
}
