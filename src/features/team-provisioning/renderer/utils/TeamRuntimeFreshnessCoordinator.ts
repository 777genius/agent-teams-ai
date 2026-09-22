import { doesRuntimeFreshnessSnapshotExtendVisible } from '../../core/domain/teamRuntimeFreshnessPolicy';

import type { TeamRuntimeSnapshotEquality } from '../../core/domain/teamRuntimeFreshnessPolicy';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';

export class TeamRuntimeFreshnessCoordinator {
  private readonly snapshotsByTeamAndRun = new Map<
    string,
    Map<string | null, TeamAgentRuntimeSnapshot>
  >();

  constructor(private readonly areSnapshotsEqual: TeamRuntimeSnapshotEquality) {}

  getSnapshot(
    teamName: string,
    visibleSnapshot: TeamAgentRuntimeSnapshot | undefined,
    incomingSnapshot: TeamAgentRuntimeSnapshot
  ): TeamAgentRuntimeSnapshot | undefined {
    if (
      visibleSnapshot?.teamName !== incomingSnapshot.teamName ||
      visibleSnapshot.runId !== incomingSnapshot.runId
    ) {
      return visibleSnapshot;
    }

    const cachedSnapshot = this.snapshotsByTeamAndRun.get(teamName)?.get(incomingSnapshot.runId);
    // Freshness memory may extend visible timestamps, but must never seed a reset scope.
    if (
      cachedSnapshot?.teamName !== incomingSnapshot.teamName ||
      cachedSnapshot.runId !== incomingSnapshot.runId ||
      !doesRuntimeFreshnessSnapshotExtendVisible(
        visibleSnapshot,
        cachedSnapshot,
        this.areSnapshotsEqual
      )
    ) {
      return visibleSnapshot;
    }
    return cachedSnapshot;
  }

  remember(teamName: string, snapshot: TeamAgentRuntimeSnapshot): void {
    let snapshotsByRun = this.snapshotsByTeamAndRun.get(teamName);
    if (!snapshotsByRun) {
      snapshotsByRun = new Map<string | null, TeamAgentRuntimeSnapshot>();
      this.snapshotsByTeamAndRun.set(teamName, snapshotsByRun);
    }
    snapshotsByRun.set(snapshot.runId, snapshot);
  }

  clearTeam(teamName: string): void {
    this.snapshotsByTeamAndRun.delete(teamName);
  }

  reset(): void {
    this.snapshotsByTeamAndRun.clear();
  }
}
