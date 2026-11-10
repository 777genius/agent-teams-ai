import { describe, expect, it } from 'vitest';

import { TeamProvisioningRuntimeSnapshotCacheBoundary } from '../TeamProvisioningRuntimeSnapshotCache';

interface TestAgentRuntimeSnapshot {
  runId: string | null;
}

interface TestMemberSpawnStatusesSnapshot {
  runId: string | null;
}

interface TestPersistedConfigEntry {
  value: string;
}

function createCacheBoundary() {
  const agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TestAgentRuntimeSnapshot }
  >();
  const liveTeamAgentRuntimeMetadataCache = new Map<
    string,
    { expiresAtMs: number; metadata: Map<string, string>; runId: string | null }
  >();
  const persistedTeamConfigCache = new Map<string, TestPersistedConfigEntry>();
  const memberSpawnStatusesSnapshotCache = new Map<
    string,
    {
      expiresAtMs: number;
      generation: number;
      runId: string | null;
      snapshot: TestMemberSpawnStatusesSnapshot;
    }
  >();
  const memberSpawnStatusesInFlightByTeam = new Map<
    string,
    {
      generationAtStart: number;
      runIdAtStart: string;
      promise: Promise<TestMemberSpawnStatusesSnapshot>;
    }
  >();
  const boundary = new TeamProvisioningRuntimeSnapshotCacheBoundary<
    TestAgentRuntimeSnapshot,
    Map<string, string>,
    TestMemberSpawnStatusesSnapshot,
    TestPersistedConfigEntry
  >({
    agentRuntimeSnapshotCache,
    liveTeamAgentRuntimeMetadataCache,
    persistedTeamConfigCache,
    memberSpawnStatusesSnapshotCache,
    memberSpawnStatusesInFlightByTeam,
  });

  return {
    boundary,
    agentRuntimeSnapshotCache,
    liveTeamAgentRuntimeMetadataCache,
    persistedTeamConfigCache,
    memberSpawnStatusesSnapshotCache,
    memberSpawnStatusesInFlightByTeam,
  };
}

describe('TeamProvisioningRuntimeSnapshotCacheBoundary', () => {
  it('tracks runtime snapshot generations independently by team', () => {
    const { boundary } = createCacheBoundary();

    expect(boundary.getRuntimeSnapshotCacheGeneration('alpha')).toBe(0);
    expect(boundary.getRuntimeSnapshotCacheGeneration('beta')).toBe(0);

    boundary.invalidateRuntimeSnapshotCaches('alpha');
    boundary.invalidateRuntimeSnapshotCaches('alpha');

    expect(boundary.getRuntimeSnapshotCacheGeneration('alpha')).toBe(2);
    expect(boundary.getRuntimeSnapshotCacheGeneration('beta')).toBe(0);
    expect(boundary.getMemberSpawnStatusesCacheGeneration('alpha')).toBe(0);
  });

  it('reads and writes agent runtime snapshots through the boundary', () => {
    const { boundary, agentRuntimeSnapshotCache } = createCacheBoundary();

    boundary.rememberAgentRuntimeSnapshot({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      snapshot: { runId: 'run-1' },
      ttlMs: 500,
      nowMs: 1_000,
    });

    expect(boundary.getCachedAgentRuntimeSnapshot('alpha', 'run-1', 1_499)).toEqual({
      runId: 'run-1',
    });
    expect(boundary.getCachedAgentRuntimeSnapshot('alpha', 'run-2', 1_499)).toBeNull();
    expect(boundary.getCachedAgentRuntimeSnapshot('alpha', 'run-1', 1_500)).toBeNull();
    expect(agentRuntimeSnapshotCache.get('alpha')).toMatchObject({
      expiresAtMs: 1_500,
      snapshot: { runId: 'run-1' },
    });
  });

  it('does not cache an agent runtime snapshot for a mismatched tracked run', () => {
    const { boundary, agentRuntimeSnapshotCache } = createCacheBoundary();

    boundary.rememberAgentRuntimeSnapshot({
      teamName: 'alpha',
      runId: 'run-2',
      generationAtStart: 0,
      snapshot: { runId: 'run-1' },
      ttlMs: 500,
      nowMs: 1_000,
    });

    expect(agentRuntimeSnapshotCache.has('alpha')).toBe(false);
    expect(boundary.getCachedAgentRuntimeSnapshot('alpha', 'run-1', 1_001)).toBeNull();
  });

  it('does not cache an agent runtime snapshot after the generation changes', () => {
    const { boundary, agentRuntimeSnapshotCache } = createCacheBoundary();
    boundary.invalidateRuntimeSnapshotCaches('alpha');

    boundary.rememberAgentRuntimeSnapshot({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      snapshot: { runId: 'run-1' },
      ttlMs: 500,
      nowMs: 1_000,
    });

    expect(agentRuntimeSnapshotCache.has('alpha')).toBe(false);
  });

  it('reads and writes live runtime metadata through the boundary', () => {
    const { boundary, liveTeamAgentRuntimeMetadataCache } = createCacheBoundary();
    const metadata = new Map([['worker', 'ready']]);

    boundary.rememberLiveTeamAgentRuntimeMetadata({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      metadata,
      ttlMs: 500,
      nowMs: 1_000,
    });

    expect(boundary.getCachedLiveTeamAgentRuntimeMetadata('alpha', 'run-1', 1_499)).toBe(metadata);
    expect(boundary.getCachedLiveTeamAgentRuntimeMetadata('alpha', 'run-2', 1_499)).toBeNull();
    expect(boundary.getCachedLiveTeamAgentRuntimeMetadata('alpha', 'run-1', 1_500)).toBeNull();
    expect(liveTeamAgentRuntimeMetadataCache.get('alpha')).toMatchObject({
      expiresAtMs: 1_500,
      metadata,
      runId: 'run-1',
    });
  });

  it('does not cache live runtime metadata after the generation changes', () => {
    const { boundary, liveTeamAgentRuntimeMetadataCache } = createCacheBoundary();
    boundary.invalidateRuntimeSnapshotCaches('alpha');

    boundary.rememberLiveTeamAgentRuntimeMetadata({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      metadata: new Map([['worker', 'stale']]),
      ttlMs: 500,
      nowMs: 1_000,
    });

    expect(liveTeamAgentRuntimeMetadataCache.has('alpha')).toBe(false);
    expect(boundary.getCachedLiveTeamAgentRuntimeMetadata('alpha', 'run-1', 1_001)).toBeNull();
  });

  it('clears runtime snapshot caches without clearing member spawn status caches', () => {
    const {
      boundary,
      agentRuntimeSnapshotCache,
      liveTeamAgentRuntimeMetadataCache,
      persistedTeamConfigCache,
      memberSpawnStatusesSnapshotCache,
      memberSpawnStatusesInFlightByTeam,
    } = createCacheBoundary();
    agentRuntimeSnapshotCache.set('alpha', {
      expiresAtMs: Date.now() + 1000,
      snapshot: { runId: 'run-1' },
    });
    liveTeamAgentRuntimeMetadataCache.set('alpha', {
      expiresAtMs: Date.now() + 1000,
      metadata: new Map([['lead', 'ready']]),
      runId: 'run-1',
    });
    persistedTeamConfigCache.set('alpha', { value: 'cached' });
    memberSpawnStatusesSnapshotCache.set('alpha', {
      expiresAtMs: Date.now() + 1000,
      generation: 0,
      runId: 'run-1',
      snapshot: { runId: 'run-1' },
    });
    memberSpawnStatusesInFlightByTeam.set('alpha', {
      generationAtStart: 0,
      runIdAtStart: 'run-1',
      promise: Promise.resolve({ runId: 'run-1' }),
    });

    boundary.invalidateRuntimeSnapshotCaches('alpha');

    expect(agentRuntimeSnapshotCache.has('alpha')).toBe(false);
    expect(liveTeamAgentRuntimeMetadataCache.has('alpha')).toBe(false);
    expect(persistedTeamConfigCache.has('alpha')).toBe(false);
    expect(memberSpawnStatusesSnapshotCache.has('alpha')).toBe(true);
    expect(memberSpawnStatusesInFlightByTeam.has('alpha')).toBe(true);
    expect(boundary.getRuntimeSnapshotCacheGeneration('alpha')).toBe(1);
    expect(boundary.getMemberSpawnStatusesCacheGeneration('alpha')).toBe(0);
  });

  it('increments and clears member spawn status snapshot caches independently', () => {
    const {
      boundary,
      agentRuntimeSnapshotCache,
      memberSpawnStatusesSnapshotCache,
      memberSpawnStatusesInFlightByTeam,
    } = createCacheBoundary();
    agentRuntimeSnapshotCache.set('alpha', {
      expiresAtMs: Date.now() + 1000,
      snapshot: { runId: 'run-1' },
    });
    memberSpawnStatusesSnapshotCache.set('alpha', {
      expiresAtMs: Date.now() + 1000,
      generation: 0,
      runId: 'run-1',
      snapshot: { runId: 'run-1' },
    });
    memberSpawnStatusesInFlightByTeam.set('alpha', {
      generationAtStart: 0,
      runIdAtStart: 'run-1',
      promise: Promise.resolve({ runId: 'run-1' }),
    });

    boundary.invalidateMemberSpawnStatusesCache('alpha');

    expect(memberSpawnStatusesSnapshotCache.has('alpha')).toBe(false);
    expect(memberSpawnStatusesInFlightByTeam.has('alpha')).toBe(false);
    expect(agentRuntimeSnapshotCache.has('alpha')).toBe(true);
    expect(boundary.getMemberSpawnStatusesCacheGeneration('alpha')).toBe(1);
    expect(boundary.getRuntimeSnapshotCacheGeneration('alpha')).toBe(0);
  });
});
