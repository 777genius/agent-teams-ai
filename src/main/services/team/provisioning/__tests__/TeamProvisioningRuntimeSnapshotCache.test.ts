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
