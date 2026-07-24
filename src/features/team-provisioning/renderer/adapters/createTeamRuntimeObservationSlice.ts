import {
  isTeamRuntimeObservationCanonical,
  planMemberSpawnObservationUpdate,
  planTeamAgentRuntimeObservationUpdate,
} from '../../core/application';

import { createTeamRuntimeObservationTransport } from './createTeamRuntimeObservationTransport';

import type {
  TeamRuntimeObservationBackoffPort,
  TeamRuntimeObservationMemberSpawnPolicyPort,
  TeamRuntimeObservationRequestScopePort,
  TeamRuntimeObservationSnapshotPolicyPort,
  TeamRuntimeObservationStatePort,
  TeamRuntimeObservationTransportPort,
} from '../ports/TeamRuntimeObservationPorts';

export interface TeamRuntimeObservationSlice {
  fetchMemberSpawnStatuses(teamName: string): Promise<void>;
  fetchTeamAgentRuntime(teamName: string): Promise<void>;
}

export interface TeamRuntimeObservationSliceDependencies<TScope> {
  backoff: TeamRuntimeObservationBackoffPort;
  memberSpawnPolicy: TeamRuntimeObservationMemberSpawnPolicyPort;
  requestScope: TeamRuntimeObservationRequestScopePort<TScope>;
  runtimeSnapshotPolicy: TeamRuntimeObservationSnapshotPolicyPort;
  state: TeamRuntimeObservationStatePort;
  transport?: TeamRuntimeObservationTransportPort;
}

function isMissingMemberSpawnHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No handler registered for 'team:memberSpawnStatuses'");
}

export function createTeamRuntimeObservationSlice<TScope>(
  dependencies: TeamRuntimeObservationSliceDependencies<TScope>
): TeamRuntimeObservationSlice {
  const transport = dependencies.transport ?? createTeamRuntimeObservationTransport();

  return {
    fetchMemberSpawnStatuses: async (teamName) => {
      if (dependencies.backoff.isMemberSpawnBackoffActive(teamName)) return;
      const requestScope = dependencies.requestScope.capture(teamName);
      try {
        const snapshot = await transport.getMemberSpawnStatuses(teamName);
        if (snapshot == null || !dependencies.requestScope.isCurrent(teamName, requestScope)) {
          return;
        }
        dependencies.backoff.clearMemberSpawnBackoff(teamName);
        dependencies.state.setState((state) => {
          const plan = planMemberSpawnObservationUpdate(
            state,
            teamName,
            snapshot,
            dependencies.memberSpawnPolicy.areSnapshotsEqual
          );
          if (plan.kind === 'ignored') return {};
          if (plan.kind === 'member-spawn-equal') {
            dependencies.memberSpawnPolicy.recordEquivalentSnapshot(teamName, snapshot.runId);
          }
          return plan.stateUpdate;
        });
      } catch (error) {
        if (!dependencies.requestScope.isCurrent(teamName, requestScope)) return;
        if (isMissingMemberSpawnHandler(error)) {
          dependencies.backoff.recordMissingMemberSpawnHandler(teamName);
        }
      }
    },

    fetchTeamAgentRuntime: async (teamName) => {
      const requestScope = dependencies.requestScope.capture(teamName);
      try {
        const snapshot = await transport.getTeamAgentRuntime(teamName);
        if (snapshot == null || !dependencies.requestScope.isCurrent(teamName, requestScope)) {
          return;
        }
        dependencies.state.setState((state) => {
          if (!isTeamRuntimeObservationCanonical(state, teamName, snapshot.runId)) {
            return {};
          }
          const visibleSnapshot = state.teamAgentRuntimeByTeam[teamName];
          const previousSnapshot = dependencies.runtimeSnapshotPolicy.getFreshnessSnapshot(
            teamName,
            visibleSnapshot,
            snapshot
          );
          const stabilizedSnapshot = dependencies.runtimeSnapshotPolicy.stabilizeSnapshot(
            previousSnapshot,
            snapshot
          );
          dependencies.runtimeSnapshotPolicy.rememberFreshnessSnapshot(
            teamName,
            stabilizedSnapshot
          );
          const plan = planTeamAgentRuntimeObservationUpdate(
            state,
            teamName,
            stabilizedSnapshot,
            dependencies.runtimeSnapshotPolicy.areVisibleSnapshotsEqual(
              visibleSnapshot,
              stabilizedSnapshot
            )
          );
          return plan.kind === 'ignored' ? {} : plan.stateUpdate;
        });
      } catch {
        // Runtime observations are best-effort.
      }
    },
  };
}
