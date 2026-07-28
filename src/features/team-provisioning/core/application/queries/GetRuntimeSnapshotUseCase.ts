export interface RuntimeSnapshotReaderPort<TSnapshot> {
  readByTeamName(teamName: string): Promise<TSnapshot>;
}

export interface GetRuntimeSnapshotQuery {
  teamName: string;
}

export class GetRuntimeSnapshotUseCase<TSnapshot> {
  constructor(private readonly runtimeSnapshotReader: RuntimeSnapshotReaderPort<TSnapshot>) {}

  execute(query: GetRuntimeSnapshotQuery): Promise<TSnapshot> {
    return this.runtimeSnapshotReader.readByTeamName(query.teamName);
  }
}
