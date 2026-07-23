import type { TeamRuntimeObservationState } from '../../core/application';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

export interface TeamRuntimeObservationTransportPort {
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot | null>;
  getTeamAgentRuntime(teamName: string): Promise<TeamAgentRuntimeSnapshot | null>;
}

export interface TeamRuntimeObservationStatePort {
  getState(): TeamRuntimeObservationState;
  setState(
    update:
      | Partial<TeamRuntimeObservationState>
      | ((state: TeamRuntimeObservationState) => Partial<TeamRuntimeObservationState>)
  ): void;
}

export interface TeamRuntimeObservationBackoffPort {
  clearMemberSpawnBackoff(teamName: string): void;
  isMemberSpawnBackoffActive(teamName: string): boolean;
  recordMissingMemberSpawnHandler(teamName: string): void;
}

export interface TeamRuntimeObservationMemberSpawnPolicyPort {
  areSnapshotsEqual(
    previous: MemberSpawnStatusesSnapshot | undefined,
    incoming: MemberSpawnStatusesSnapshot
  ): boolean;
  recordEquivalentSnapshot(teamName: string, runId: string | null | undefined): void;
}

export interface TeamRuntimeObservationSnapshotPolicyPort {
  areVisibleSnapshotsEqual(
    visible: TeamAgentRuntimeSnapshot | undefined,
    incoming: TeamAgentRuntimeSnapshot
  ): boolean;
  getFreshnessSnapshot(
    teamName: string,
    visible: TeamAgentRuntimeSnapshot | undefined,
    incoming: TeamAgentRuntimeSnapshot
  ): TeamAgentRuntimeSnapshot | undefined;
  rememberFreshnessSnapshot(teamName: string, snapshot: TeamAgentRuntimeSnapshot): void;
  stabilizeSnapshot(
    previous: TeamAgentRuntimeSnapshot | undefined,
    incoming: TeamAgentRuntimeSnapshot
  ): TeamAgentRuntimeSnapshot;
}

export interface TeamRuntimeObservationRequestScopePort<TScope> {
  capture(teamName: string): TScope;
  isCurrent(teamName: string, scope: TScope): boolean;
}
