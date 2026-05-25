import type { TeamViewSnapshot } from '@shared/types';

export interface TeamDataSelectorState {
  teamDataCacheByName: Record<string, TeamViewSnapshot>;
  selectedTeamName: string | null;
  selectedTeamData: TeamViewSnapshot | null;
}

const EMPTY_TEAM_MEMBER_SNAPSHOTS: TeamViewSnapshot['members'] = [];
const EMPTY_TEAM_TASKS: TeamViewSnapshot['tasks'] = [];

export function selectTeamDataForName(
  state: TeamDataSelectorState,
  teamName: string | null | undefined
): TeamViewSnapshot | null {
  if (!teamName) {
    return null;
  }
  if (state.selectedTeamName === teamName && state.selectedTeamData) {
    return state.selectedTeamData;
  }
  return (
    state.teamDataCacheByName[teamName] ??
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)
  );
}

export function selectTeamMemberSnapshotsForName(
  state: TeamDataSelectorState,
  teamName: string | null | undefined
): TeamViewSnapshot['members'] {
  return selectTeamDataForName(state, teamName)?.members ?? EMPTY_TEAM_MEMBER_SNAPSHOTS;
}

export function selectTeamTasksForName(
  state: TeamDataSelectorState,
  teamName: string | null | undefined
): TeamViewSnapshot['tasks'] {
  return selectTeamDataForName(state, teamName)?.tasks ?? EMPTY_TEAM_TASKS;
}

export function selectTeamIsAliveForName(
  state: TeamDataSelectorState,
  teamName: string | null | undefined
): boolean | undefined {
  return selectTeamDataForName(state, teamName)?.isAlive;
}
