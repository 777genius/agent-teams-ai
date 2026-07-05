import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLiveRuntimeMetadataPorts,
  type TeamProvisioningLiveRuntimeMetadataInFlightEntry,
  type TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps,
} from '../TeamProvisioningLiveRuntimeMetadataPortsFactory';

import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';

function cloneLiveTeamAgentRuntimeMetadata(
  metadata: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>
): Map<string, LiveTeamAgentRuntimeMetadata> {
  return new Map(
    [...metadata.entries()].map(([memberName, entry]) => [
      memberName,
      {
        ...entry,
        ...(entry.diagnostics ? { diagnostics: [...entry.diagnostics] } : {}),
      },
    ])
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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
    liveTeamAgentRuntimeMetadataCache: new Map(),
    cloneLiveTeamAgentRuntimeMetadata,
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
    const cachedMetadata = new Map<string, LiveTeamAgentRuntimeMetadata>([
      ['Worker', { alive: true, diagnostics: ['cached'] }],
    ]);
    const deps = makeDeps();
    deps.liveTeamAgentRuntimeMetadataCache.set('alpha', {
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
    const deps = makeDeps({
      liveTeamAgentRuntimeMetadataInFlightByTeam: inFlightByTeam,
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
    expect(deps.liveTeamAgentRuntimeMetadataCache.get('alpha')?.runId).toBe('run-1');
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
