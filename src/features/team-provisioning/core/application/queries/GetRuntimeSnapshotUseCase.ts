import type { TeamAgentRuntimeSnapshot } from '../../../contracts/runtime-snapshot';

export interface RuntimeSnapshotReaderPort {
  readByTeamName(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export interface GetRuntimeSnapshotQuery {
  teamName: string;
}

export class GetRuntimeSnapshotUseCase {
  constructor(private readonly runtimeSnapshotReader: RuntimeSnapshotReaderPort) {}

  execute(query: GetRuntimeSnapshotQuery): Promise<TeamAgentRuntimeSnapshot> {
    return this.runtimeSnapshotReader.readByTeamName(query.teamName);
  }
}
