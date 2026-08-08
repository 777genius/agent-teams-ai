export type TeamLeadActivityState = 'active' | 'idle' | 'offline';

export interface TeamMemberSpawnStatus {
  status: 'offline' | 'waiting' | 'spawning' | 'online' | 'error' | 'skipped';
  launchState:
    | 'starting'
    | 'runtime_pending_bootstrap'
    | 'runtime_pending_permission'
    | 'confirmed_alive'
    | 'failed_to_start'
    | 'skipped_for_launch';
  updatedAt: string;
}

export interface TeamMemberSpawnSnapshot {
  statuses: Record<string, TeamMemberSpawnStatus>;
  runId: string | null;
}

export interface TeamAgentRuntimeEntry {
  memberName: string;
  alive: boolean;
  restartable: boolean;
  updatedAt: string;
}

export interface TeamAgentRuntimeObservation {
  teamName: string;
  updatedAt: string;
  runId: string | null;
  members: Record<string, TeamAgentRuntimeEntry>;
}

export interface TeamRuntimeObservationState {
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  ignoredRuntimeRunIds: Record<string, string>;
  leadActivityByTeam: Record<string, TeamLeadActivityState>;
  memberSpawnSnapshotsByTeam: Record<string, TeamMemberSpawnSnapshot>;
  memberSpawnStatusesByTeam: Record<string, Record<string, TeamMemberSpawnStatus>>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeObservation>;
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
  snapshot: TeamMemberSpawnSnapshot,
  areSnapshotsEqual: (
    previous: TeamMemberSpawnSnapshot | undefined,
    incoming: TeamMemberSpawnSnapshot
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
  snapshot: TeamAgentRuntimeObservation,
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
