export enum TeamProvisioningRuntimeSnapshotCacheScope {
  RuntimeSnapshot = 'runtimeSnapshot',
  MemberSpawnStatuses = 'memberSpawnStatuses',
}

export interface TeamProvisioningExpiringRuntimeSnapshotCacheEntry<TSnapshot> {
  expiresAtMs: number;
  snapshot: TSnapshot;
}

export interface TeamProvisioningAgentRuntimeSnapshotLike {
  runId: string | null;
}

export interface TeamProvisioningAgentRuntimeSnapshotCachePort<
  TAgentRuntimeSnapshot extends TeamProvisioningAgentRuntimeSnapshotLike,
> {
  getCachedAgentRuntimeSnapshot(
    teamName: string,
    runId: string | null,
    nowMs?: number
  ): TAgentRuntimeSnapshot | null;
  rememberAgentRuntimeSnapshot(params: {
    teamName: string;
    runId: string | null;
    generationAtStart: number;
    snapshot: TAgentRuntimeSnapshot;
    ttlMs: number;
    nowMs?: number;
  }): void;
  getRuntimeSnapshotCacheGeneration(teamName: string): number;
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
  TAgentRuntimeSnapshot extends TeamProvisioningAgentRuntimeSnapshotLike,
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
  TAgentRuntimeSnapshot extends TeamProvisioningAgentRuntimeSnapshotLike,
  TLiveRuntimeMetadata,
  TMemberSpawnStatusesSnapshot,
  TPersistedTeamConfigCacheEntry,
> implements TeamProvisioningAgentRuntimeSnapshotCachePort<TAgentRuntimeSnapshot> {
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

  getCachedAgentRuntimeSnapshot(
    teamName: string,
    runId: string | null,
    nowMs = Date.now()
  ): TAgentRuntimeSnapshot | null {
    const cached = this.ports.agentRuntimeSnapshotCache.get(teamName);
    if (!cached || cached.expiresAtMs <= nowMs || cached.snapshot.runId !== runId) {
      return null;
    }
    return cached.snapshot;
  }

  rememberAgentRuntimeSnapshot(params: {
    teamName: string;
    runId: string | null;
    generationAtStart: number;
    snapshot: TAgentRuntimeSnapshot;
    ttlMs: number;
    nowMs?: number;
  }): void {
    if (
      this.getRuntimeSnapshotCacheGeneration(params.teamName) !== params.generationAtStart ||
      params.snapshot.runId !== params.runId
    ) {
      return;
    }
    this.ports.agentRuntimeSnapshotCache.set(params.teamName, {
      expiresAtMs: (params.nowMs ?? Date.now()) + params.ttlMs,
      snapshot: params.snapshot,
    });
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
