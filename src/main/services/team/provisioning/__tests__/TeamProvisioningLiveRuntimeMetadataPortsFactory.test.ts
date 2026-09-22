import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLiveRuntimeMetadataPorts,
  type TeamProvisioningLiveRuntimeMetadataInFlightEntry,
  type TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps,
} from '../TeamProvisioningLiveRuntimeMetadataPortsFactory';

import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningLiveRuntimeMetadataCachePort } from '../TeamProvisioningRuntimeSnapshotCache';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createLiveRuntimeMetadataCachePort(
  cache: Map<
    string,
    {
      expiresAtMs: number;
      metadata: Map<string, LiveTeamAgentRuntimeMetadata>;
      runId: string | null;
    }
  >
): TeamProvisioningLiveRuntimeMetadataCachePort<Map<string, LiveTeamAgentRuntimeMetadata>> {
  return {
    getCachedLiveTeamAgentRuntimeMetadata(teamName, runId, nowMs = Date.now()) {
      const cached = cache.get(teamName);
      if (!cached || cached.expiresAtMs <= nowMs || cached.runId !== runId) {
        return null;
      }
      return cached.metadata;
    },
    rememberLiveTeamAgentRuntimeMetadata(params) {
      cache.set(params.teamName, {
        expiresAtMs: (params.nowMs ?? Date.now()) + params.ttlMs,
        metadata: params.metadata,
        runId: params.runId,
      });
    },
  };
}

function makeDeps(
  overrides: Partial<TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps> = {}
): TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps {
  return {
    runs: new Map(),
    runtimeAdapterRunByTeam: new Map(),
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
    liveRuntimeMetadataCache: createLiveRuntimeMetadataCachePort(new Map()),
    readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: [],
      processTableAvailable: true,
    })),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: [],
      processTableAvailable: true,
    })),
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
    getTrackedRunId: vi.fn(() => 'run-1'),
    getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
    logDebug: vi.fn(),
    ...overrides,
  };
}

describe('TeamProvisioningLiveRuntimeMetadataPortsFactory', () => {
  it('returns a cloned cached hit without rebuilding metadata', async () => {
    const liveRuntimeMetadataCache = new Map<
      string,
      {
        expiresAtMs: number;
        metadata: Map<string, LiveTeamAgentRuntimeMetadata>;
        runId: string | null;
      }
    >();
    const cachedMetadata = new Map<string, LiveTeamAgentRuntimeMetadata>([
      ['Worker', { alive: true, diagnostics: ['cached'] }],
    ]);
    const deps = makeDeps({
      liveRuntimeMetadataCache: createLiveRuntimeMetadataCachePort(liveRuntimeMetadataCache),
    });
    liveRuntimeMetadataCache.set('alpha', {
      expiresAtMs: Date.now() + 10_000,
      metadata: cachedMetadata,
      runId: 'run-1',
    });
    const ports = createTeamProvisioningLiveRuntimeMetadataPorts(deps);

    const first = await ports.getLiveTeamAgentRuntimeMetadata('alpha');
    first.get('Worker')!.alive = false;
    first.get('Worker')!.diagnostics!.push('mutated');
    const second = await ports.getLiveTeamAgentRuntimeMetadata('alpha');

    expect(first).not.toBe(cachedMetadata);
    expect(first.get('Worker')).not.toBe(cachedMetadata.get('Worker'));
    expect(second.get('Worker')).toEqual({ alive: true, diagnostics: ['cached'] });
    expect(deps.readConfigSnapshot).not.toHaveBeenCalled();
  });

  it('dedupes in-flight metadata builds and clones each caller result', async () => {
    const configDeferred = createDeferred<null>();
    const inFlightByTeam = new Map<string, TeamProvisioningLiveRuntimeMetadataInFlightEntry>();
    const liveRuntimeMetadataCache = new Map<
      string,
      {
        expiresAtMs: number;
        metadata: Map<string, LiveTeamAgentRuntimeMetadata>;
        runId: string | null;
      }
    >();
    const deps = makeDeps({
      liveTeamAgentRuntimeMetadataInFlightByTeam: inFlightByTeam,
      liveRuntimeMetadataCache: createLiveRuntimeMetadataCachePort(liveRuntimeMetadataCache),
      readConfigSnapshot: vi.fn(() => configDeferred.promise),
      readPersistedRuntimeMembers: vi.fn(() => [
        {
          name: 'Worker',
          providerId: 'anthropic',
          agentId: 'agent-worker',
          cwd: '/repo/team-alpha',
        },
      ]),
    });
    const ports = createTeamProvisioningLiveRuntimeMetadataPorts(deps);

    const first = ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(inFlightByTeam.has('alpha')).toBe(true);
    const second = ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(deps.readConfigSnapshot).toHaveBeenCalledTimes(1);

    configDeferred.resolve(null);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).not.toBe(secondResult);
    expect(firstResult.get('Worker')).not.toBe(secondResult.get('Worker'));
    expect(firstResult.get('Worker')).toMatchObject({
      agentId: 'agent-worker',
      cwd: '/repo/team-alpha',
      providerId: 'anthropic',
    });
    expect(secondResult.get('Worker')).toMatchObject({
      agentId: 'agent-worker',
      cwd: '/repo/team-alpha',
      providerId: 'anthropic',
    });
    expect(inFlightByTeam.has('alpha')).toBe(false);
    expect(deps.getAgentRuntimeSnapshotCacheTtlMs).toHaveBeenCalledWith('alpha', 'run-1');
    expect(liveRuntimeMetadataCache.get('alpha')?.runId).toBe('run-1');

    firstResult.get('Worker')!.cwd = '/mutated-caller-copy';
    const cachedResult = await ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(cachedResult).not.toBe(liveRuntimeMetadataCache.get('alpha')?.metadata);
    expect(cachedResult.get('Worker')?.cwd).toBe('/repo/team-alpha');
  });

  it('does not reuse an older in-flight metadata build after cache generation advances', async () => {
    const firstConfigDeferred = createDeferred<null>();
    const secondConfigDeferred = createDeferred<null>();
    const inFlightByTeam = new Map<string, TeamProvisioningLiveRuntimeMetadataInFlightEntry>();
    let generation = 0;
    let configReadCount = 0;
    const deps = makeDeps({
      liveTeamAgentRuntimeMetadataInFlightByTeam: inFlightByTeam,
      getRuntimeSnapshotCacheGeneration: vi.fn(() => generation),
      readConfigSnapshot: vi.fn(() => {
        configReadCount += 1;
        return configReadCount === 1 ? firstConfigDeferred.promise : secondConfigDeferred.promise;
      }),
      readPersistedRuntimeMembers: vi.fn(() => [
        {
          name: 'Worker',
          providerId: 'anthropic',
          agentId: 'agent-worker',
          cwd: '/repo/team-alpha',
        },
      ]),
    });
    const ports = createTeamProvisioningLiveRuntimeMetadataPorts(deps);

    const first = ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(inFlightByTeam.get('alpha')?.generationAtStart).toBe(0);

    generation = 1;
    const second = ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(inFlightByTeam.get('alpha')?.generationAtStart).toBe(1);
    expect(deps.readConfigSnapshot).toHaveBeenCalledTimes(2);

    secondConfigDeferred.resolve(null);
    const secondResult = await second;
    expect(secondResult.get('Worker')).toMatchObject({ agentId: 'agent-worker' });

    firstConfigDeferred.resolve(null);
    await first;
    expect(inFlightByTeam.has('alpha')).toBe(false);
  });

  it('stamps verified live process observations with a last-seen time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:20.000Z'));
    try {
      const deps = makeDeps({
        readPersistedRuntimeMembers: vi.fn(() => [
          {
            name: 'Worker',
            providerId: 'anthropic',
            agentId: 'agent-worker',
          },
        ]),
        readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
          rows: [
            {
              pid: 4242,
              ppid: 1,
              command: 'node runtime.js --team-name alpha --agent-id agent-worker',
            },
          ],
          processTableAvailable: true,
        })),
      });
      const ports = createTeamProvisioningLiveRuntimeMetadataPorts(deps);

      const metadata = await ports.getLiveTeamAgentRuntimeMetadata('alpha');

      expect(metadata.get('Worker')).toMatchObject({
        alive: true,
        livenessKind: 'runtime_process',
        pid: 4242,
        runtimeLastSeenAt: '2026-01-01T00:00:20.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the in-flight entry when a metadata build fails', async () => {
    const inFlightByTeam = new Map<string, TeamProvisioningLiveRuntimeMetadataInFlightEntry>();
    const deps = makeDeps({
      liveTeamAgentRuntimeMetadataInFlightByTeam: inFlightByTeam,
      readPersistedRuntimeMembers: vi.fn(() => {
        throw new Error('persisted runtime members unavailable');
      }),
    });
    const ports = createTeamProvisioningLiveRuntimeMetadataPorts(deps);

    const request = ports.getLiveTeamAgentRuntimeMetadata('alpha');
    expect(inFlightByTeam.has('alpha')).toBe(true);

    await expect(request).rejects.toThrow('persisted runtime members unavailable');
    expect(inFlightByTeam.has('alpha')).toBe(false);
  });
});
