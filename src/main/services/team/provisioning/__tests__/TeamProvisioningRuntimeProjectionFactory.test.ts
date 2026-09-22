import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningRuntimeProjectionDepsFromService,
  type TeamProvisioningRuntimeProjectionServiceHost,
} from '../TeamProvisioningRuntimeProjectionFactory';

import type { TeamRuntimeState } from '@shared/types';

describe('TeamProvisioningRuntimeProjectionFactory', () => {
  it('builds projection deps from service-shaped dependencies', async () => {
    const runs = new Map<string, never>();
    const provisioningRunByTeam = new Map<string, string>();
    const runtimeAdapterRunByTeam = new Map<string, never>();
    const runtimeAdapterProgressByRunId = new Map();
    const retainedProgressByTeam = new Map();
    const runtimeSnapshotCacheBoundary = {} as never;
    const runtimeResourceSampling = {} as never;
    const readBootstrapRuntimeState = vi.fn(async () => null as TeamRuntimeState | null);
    const logDebug = vi.fn();
    const service = {
      runs,
      provisioningRunByTeam,
      runtimeAdapterRunByTeam,
      runtimeAdapterProgressByRunId,
      retainedProvisioningProgressState: {
        getRetainedProvisioningProgressMap: vi.fn(() => retainedProgressByTeam),
      },
      runTracking: {
        getAliveRunId: vi.fn(() => 'run-alive'),
        getTrackedRunId: vi.fn(() => 'run-tracked'),
        getAliveTeamNames: vi.fn(() => ['alpha']),
        getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 123),
      },
      hasSecondaryRuntimeRuns: vi.fn(() => true),
      teamMetaStore: {
        getMeta: vi.fn(async () => null),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      },
      launchStateStore: {
        read: vi.fn(async () => null),
      },
      readConfigSnapshot: vi.fn(async () => null),
      readPersistedRuntimeMembers: vi.fn(() => []),
      getMemberSpawnStatuses: vi.fn(async () => ({})),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      runtimeSnapshotCacheBoundary,
      runtimeResourceSampling,
    } as unknown as TeamProvisioningRuntimeProjectionServiceHost<never, never>;

    const deps = createTeamProvisioningRuntimeProjectionDepsFromService(service, {
      readBootstrapRuntimeState,
      logDebug,
    });

    expect(deps.runs).toBe(runs);
    expect(deps.provisioningRunByTeam).toBe(provisioningRunByTeam);
    expect(deps.runtimeAdapterRunByTeam).toBe(runtimeAdapterRunByTeam);
    expect(deps.runtimeAdapterProgressByRunId).toBe(runtimeAdapterProgressByRunId);
    expect(deps.getRetainedProvisioningProgressMap()).toBe(retainedProgressByTeam);
    expect(deps.runtimeSnapshotCache).toBe(runtimeSnapshotCacheBoundary);
    expect(deps.liveRuntimeMetadataCache).toBe(runtimeSnapshotCacheBoundary);
    expect(deps.runtimeResourceSampling).toBe(runtimeResourceSampling);
    expect(deps.logDebug).toBe(logDebug);
    await expect(deps.readBootstrapRuntimeState('alpha')).resolves.toBeNull();
    await expect(deps.teamMetaStore.getMeta('alpha')).resolves.toBeNull();
    await expect(deps.membersMetaStore.getMembers('alpha')).resolves.toEqual([]);
    await expect(deps.launchStateStore.read('alpha')).resolves.toBeNull();
    await expect(deps.readConfigSnapshot('alpha')).resolves.toBeNull();
    expect(deps.readPersistedRuntimeMembers('alpha')).toEqual([]);
    await expect(deps.getLiveTeamAgentRuntimeMetadata?.('alpha')).resolves.toEqual(new Map());
    expect(deps.hasSecondaryRuntimeRuns('alpha')).toBe(true);

    expect(readBootstrapRuntimeState).toHaveBeenCalledWith('alpha');
    expect(service.teamMetaStore.getMeta).toHaveBeenCalledWith('alpha');
    expect(service.membersMetaStore.getMembers).toHaveBeenCalledWith('alpha');
    expect(service.launchStateStore.read).toHaveBeenCalledWith('alpha');
    expect(service.readConfigSnapshot).toHaveBeenCalledWith('alpha');
    expect(service.readPersistedRuntimeMembers).toHaveBeenCalledWith('alpha');
    expect(service.getLiveTeamAgentRuntimeMetadata).toHaveBeenCalledWith('alpha');
    expect(service.hasSecondaryRuntimeRuns).toHaveBeenCalledWith('alpha');
  });
});
