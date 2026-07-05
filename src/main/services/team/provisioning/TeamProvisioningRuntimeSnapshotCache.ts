export enum TeamProvisioningRuntimeSnapshotCacheScope {
  RuntimeSnapshot = 'runtimeSnapshot',
  MemberSpawnStatuses = 'memberSpawnStatuses',
}

export interface TeamProvisioningExpiringRuntimeSnapshotCacheEntry<TSnapshot> {
  expiresAtMs: number;
  snapshot: TSnapshot;
}

export interface TeamProvisioningLiveRuntimeMetadataCacheEntry<TMetadata> {
  expiresAtMs: number;
  metadata: TMetadata;
  runId: string | null;
}

export interface TeamProvisioningMemberSpawnStatusesSnapshotCacheEntry<TSnapshot> {
  expiresAtMs: number;
  generation: number;
  runId: string | null;
  snapshot: TSnapshot;
}

export interface TeamProvisioningMemberSpawnStatusesInFlightEntry<TSnapshot> {
  generationAtStart: number;
  runIdAtStart: string;
  promise: Promise<TSnapshot>;
}

export interface TeamProvisioningRuntimeSnapshotCachePorts<
  TAgentRuntimeSnapshot,
  TLiveRuntimeMetadata,
  TMemberSpawnStatusesSnapshot,
  TPersistedTeamConfigCacheEntry,
> {
  agentRuntimeSnapshotCache: Map<
    string,
    TeamProvisioningExpiringRuntimeSnapshotCacheEntry<TAgentRuntimeSnapshot>
  >;
  liveTeamAgentRuntimeMetadataCache: Map<
    string,
    TeamProvisioningLiveRuntimeMetadataCacheEntry<TLiveRuntimeMetadata>
  >;
  persistedTeamConfigCache: Map<string, TPersistedTeamConfigCacheEntry>;
  memberSpawnStatusesSnapshotCache: Map<
    string,
    TeamProvisioningMemberSpawnStatusesSnapshotCacheEntry<TMemberSpawnStatusesSnapshot>
  >;
  memberSpawnStatusesInFlightByTeam: Map<
    string,
    TeamProvisioningMemberSpawnStatusesInFlightEntry<TMemberSpawnStatusesSnapshot>
  >;
}

export class TeamProvisioningRuntimeSnapshotCacheBoundary<
  TAgentRuntimeSnapshot,
  TLiveRuntimeMetadata,
  TMemberSpawnStatusesSnapshot,
  TPersistedTeamConfigCacheEntry,
> {
  private readonly generationByScope = new Map<
    TeamProvisioningRuntimeSnapshotCacheScope,
    Map<string, number>
  >([
    [TeamProvisioningRuntimeSnapshotCacheScope.RuntimeSnapshot, new Map<string, number>()],
    [TeamProvisioningRuntimeSnapshotCacheScope.MemberSpawnStatuses, new Map<string, number>()],
  ]);

  constructor(
    private readonly ports: TeamProvisioningRuntimeSnapshotCachePorts<
      TAgentRuntimeSnapshot,
      TLiveRuntimeMetadata,
      TMemberSpawnStatusesSnapshot,
      TPersistedTeamConfigCacheEntry
    >
  ) {}

  getRuntimeSnapshotCacheGeneration(teamName: string): number {
    return this.getGeneration(TeamProvisioningRuntimeSnapshotCacheScope.RuntimeSnapshot, teamName);
  }

  getMemberSpawnStatusesCacheGeneration(teamName: string): number {
    return this.getGeneration(
      TeamProvisioningRuntimeSnapshotCacheScope.MemberSpawnStatuses,
      teamName
    );
  }

  invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.incrementGeneration(TeamProvisioningRuntimeSnapshotCacheScope.RuntimeSnapshot, teamName);
    this.ports.agentRuntimeSnapshotCache.delete(teamName);
    this.ports.liveTeamAgentRuntimeMetadataCache.delete(teamName);
    this.ports.persistedTeamConfigCache.delete(teamName);
    // Keep in-flight runtime probes alive. Active teams can invalidate runtime
    // caches faster than expensive process-table/snapshot probes complete; the
    // generation guard in each builder prevents stale results from being cached.
    // Process table rows are TTL-bound. Resource telemetry can use the longer
    // TTL, while liveness only reuses rows through a short age gate.
  }

  invalidateMemberSpawnStatusesCache(teamName: string): void {
    this.incrementGeneration(
      TeamProvisioningRuntimeSnapshotCacheScope.MemberSpawnStatuses,
      teamName
    );
    this.ports.memberSpawnStatusesSnapshotCache.delete(teamName);
    this.ports.memberSpawnStatusesInFlightByTeam.delete(teamName);
  }

  private getGeneration(
    scope: TeamProvisioningRuntimeSnapshotCacheScope,
    teamName: string
  ): number {
    return this.getGenerationMap(scope).get(teamName) ?? 0;
  }

  private incrementGeneration(
    scope: TeamProvisioningRuntimeSnapshotCacheScope,
    teamName: string
  ): void {
    this.getGenerationMap(scope).set(teamName, this.getGeneration(scope, teamName) + 1);
  }

  private getGenerationMap(scope: TeamProvisioningRuntimeSnapshotCacheScope): Map<string, number> {
    const generations = this.generationByScope.get(scope);
    if (!generations) {
      throw new Error(`Missing runtime snapshot cache generation scope: ${scope}`);
    }
    return generations;
  }
}
