import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningRuntimeResourceCacheBoundary } from '../TeamProvisioningRuntimeResourceCacheBoundary';

import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type {
  RuntimeResourceSamplingCacheAccess,
  RuntimeResourceSamplingLogPorts,
  TeamProvisioningRuntimeResourceSampling,
} from '../TeamProvisioningRuntimeResourceSampling';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

describe('TeamProvisioningRuntimeResourceCacheBoundary', () => {
  it('wires runtime resource sampling to shared cache generation and run tracking', () => {
    let capturedCacheAccess: RuntimeResourceSamplingCacheAccess | null = null;
    let capturedLogPorts: RuntimeResourceSamplingLogPorts | null = null;
    const getTrackedRunId = vi.fn(() => 'run-1');
    const logDebug = vi.fn();
    const runtimeResourceSampling = {
      clearRuntimeProcessRowsForTeam: vi.fn(),
    } as unknown as TeamProvisioningRuntimeResourceSampling;
    const createRuntimeResourceSampling = vi.fn(
      (
        cacheAccess: RuntimeResourceSamplingCacheAccess,
        logPorts: RuntimeResourceSamplingLogPorts
      ): TeamProvisioningRuntimeResourceSampling => {
        capturedCacheAccess = cacheAccess;
        capturedLogPorts = logPorts;
        return runtimeResourceSampling;
      }
    );

    const boundary = createTeamProvisioningRuntimeResourceCacheBoundary({
      getTrackedRunId,
      logDebug,
      createRuntimeResourceSampling,
    });

    expect(boundary.runtimeResourceSampling).toBe(runtimeResourceSampling);
    expect(createRuntimeResourceSampling).toHaveBeenCalledTimes(1);
    expect(capturedCacheAccess!.getRuntimeSnapshotCacheGeneration('alpha')).toBe(0);

    boundary.runtimeSnapshotCacheBoundary.invalidateRuntimeSnapshotCaches('alpha');

    expect(capturedCacheAccess!.getRuntimeSnapshotCacheGeneration('alpha')).toBe(1);
    expect(capturedCacheAccess!.getTrackedRunId('alpha')).toBe('run-1');
    expect(getTrackedRunId).toHaveBeenCalledWith('alpha');

    capturedLogPorts!.logDebug('sample debug');

    expect(logDebug).toHaveBeenCalledWith('sample debug');
  });

  it('owns runtime snapshot caches while preserving member spawn status cache scope', () => {
    const boundary = createTeamProvisioningRuntimeResourceCacheBoundary({
      getTrackedRunId: () => 'run-1',
      logDebug: vi.fn(),
    });
    const metadata = new Map<string, LiveTeamAgentRuntimeMetadata>([['lead', { alive: true }]]);

    boundary.runtimeSnapshotCacheBoundary.rememberAgentRuntimeSnapshot({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      snapshot: { runId: 'run-1' } as TeamAgentRuntimeSnapshot,
      ttlMs: 500,
      nowMs: 1_000,
    });
    boundary.runtimeSnapshotCacheBoundary.rememberLiveTeamAgentRuntimeMetadata({
      teamName: 'alpha',
      runId: 'run-1',
      generationAtStart: 0,
      metadata,
      ttlMs: 500,
      nowMs: 1_000,
    });
    boundary.persistedTeamConfigCache.set('alpha', {} as never);
    boundary.memberSpawnStatusesSnapshotCache.set('alpha', {
      expiresAtMs: 1_500,
      generation: 0,
      runId: 'run-1',
      snapshot: { runId: 'run-1' } as MemberSpawnStatusesSnapshot,
    });
    boundary.memberSpawnStatusesInFlightByTeam.set('alpha', {
      generationAtStart: 0,
      runIdAtStart: 'run-1',
      promise: Promise.resolve({ runId: 'run-1' } as MemberSpawnStatusesSnapshot),
    });

    boundary.invalidateRuntimeSnapshotCaches('alpha');

    expect(
      boundary.runtimeSnapshotCacheBoundary.getCachedAgentRuntimeSnapshot('alpha', 'run-1', 1_001)
    ).toBeNull();
    expect(
      boundary.runtimeSnapshotCacheBoundary.getCachedLiveTeamAgentRuntimeMetadata(
        'alpha',
        'run-1',
        1_001
      )
    ).toBeNull();
    expect(boundary.persistedTeamConfigCache.has('alpha')).toBe(false);
    expect(boundary.memberSpawnStatusesSnapshotCache.has('alpha')).toBe(true);
    expect(boundary.memberSpawnStatusesInFlightByTeam.has('alpha')).toBe(true);
    expect(boundary.runtimeSnapshotCacheBoundary.getRuntimeSnapshotCacheGeneration('alpha')).toBe(
      1
    );
    expect(
      boundary.runtimeSnapshotCacheBoundary.getMemberSpawnStatusesCacheGeneration('alpha')
    ).toBe(0);
  });
});
