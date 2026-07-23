import type {
  LeadActivityState,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

export interface TeamRuntimeObservationState {
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  ignoredRuntimeRunIds: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
}

export type TeamRuntimeObservationUpdatePlan =
  | { kind: 'ignored' }
  | {
      kind: 'member-spawn-equal';
      stateUpdate: Partial<TeamRuntimeObservationState>;
    }
  | {
      kind: 'updated';
      stateUpdate: Partial<TeamRuntimeObservationState>;
    };

export function isTeamRuntimeObservationCanonical(
  state: TeamRuntimeObservationState,
  teamName: string,
  runId: string | null
): boolean {
  if (runId == null) return true;
  if (state.ignoredRuntimeRunIds[runId] === teamName) return false;
  const currentRunId = state.currentRuntimeRunIdByTeam[teamName];
  return currentRunId == null || currentRunId === runId;
}

export function planMemberSpawnObservationUpdate(
  state: TeamRuntimeObservationState,
  teamName: string,
  snapshot: MemberSpawnStatusesSnapshot,
  areSnapshotsEqual: (
    previous: MemberSpawnStatusesSnapshot | undefined,
    incoming: MemberSpawnStatusesSnapshot
  ) => boolean
): TeamRuntimeObservationUpdatePlan {
  if (!isTeamRuntimeObservationCanonical(state, teamName, snapshot.runId)) {
    return { kind: 'ignored' };
  }
  if (
    snapshot.runId != null &&
    state.currentRuntimeRunIdByTeam[teamName] == null &&
    state.leadActivityByTeam[teamName] === 'offline'
  ) {
    return { kind: 'ignored' };
  }

  const currentRuntimeRunIdByTeam =
    snapshot.runId == null || state.currentRuntimeRunIdByTeam[teamName] != null
      ? state.currentRuntimeRunIdByTeam
      : {
          ...state.currentRuntimeRunIdByTeam,
          [teamName]: snapshot.runId,
        };

  if (areSnapshotsEqual(state.memberSpawnSnapshotsByTeam[teamName], snapshot)) {
    return {
      kind: 'member-spawn-equal',
      stateUpdate:
        currentRuntimeRunIdByTeam === state.currentRuntimeRunIdByTeam
          ? {}
          : { currentRuntimeRunIdByTeam },
    };
  }

  return {
    kind: 'updated',
    stateUpdate: {
      currentRuntimeRunIdByTeam,
      memberSpawnStatusesByTeam: {
        ...state.memberSpawnStatusesByTeam,
        [teamName]: snapshot.statuses,
      },
      memberSpawnSnapshotsByTeam: {
        ...state.memberSpawnSnapshotsByTeam,
        [teamName]: snapshot,
      },
    },
  };
}

export function planTeamAgentRuntimeObservationUpdate(
  state: TeamRuntimeObservationState,
  teamName: string,
  snapshot: TeamAgentRuntimeSnapshot,
  visibleSnapshotEqual: boolean
): TeamRuntimeObservationUpdatePlan {
  if (!isTeamRuntimeObservationCanonical(state, teamName, snapshot.runId) || visibleSnapshotEqual) {
    return { kind: 'ignored' };
  }

  return {
    kind: 'updated',
    stateUpdate: {
      teamAgentRuntimeByTeam: {
        ...state.teamAgentRuntimeByTeam,
        [teamName]: snapshot,
      },
    },
  };
}
