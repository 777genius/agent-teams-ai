import type { RuntimeSnapshotReaderPort } from '../../../core/application/queries/GetRuntimeSnapshotUseCase';
import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

export interface LegacyRuntimeSnapshotSource {
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export interface LegacyRuntimeSnapshotReaderDeps {
  snapshotSource: LegacyRuntimeSnapshotSource;
}

export class LegacyRuntimeSnapshotReaderAdapter implements RuntimeSnapshotReaderPort<TeamAgentRuntimeSnapshot> {
  constructor(private readonly deps: LegacyRuntimeSnapshotReaderDeps) {}

  readByTeamName(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.deps.snapshotSource.getTeamAgentRuntimeSnapshot(teamName);
  }
}
