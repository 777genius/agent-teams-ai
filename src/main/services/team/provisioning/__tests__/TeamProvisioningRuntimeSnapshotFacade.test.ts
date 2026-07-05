import { TeamAgentRuntimeResourceHistory } from '@main/services/team/TeamAgentRuntimeResourceHistory';
import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningRuntimeSnapshotFacade,
  type TeamProvisioningRuntimeSnapshotFacadePorts,
} from '../TeamProvisioningRuntimeSnapshotFacade';

import type {
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
} from '@shared/types';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

type BuildTeamAgentRuntimeSnapshotPort = NonNullable<
  TeamProvisioningRuntimeSnapshotFacadePorts['buildTeamAgentRuntimeSnapshot']
>;

function createFacadeHarness(
  options: {
    ttlMs?: number;
    getMeta?: () => Promise<null>;
    buildTeamAgentRuntimeSnapshot?: BuildTeamAgentRuntimeSnapshotPort;
  } = {}
) {
  let runId: string | null = null;
  let generation = 0;
  let buildCount = 0;
  const agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >();
  const resourceHistory = new TeamAgentRuntimeResourceHistory({
    historyLimit: 10,
    minSampleIntervalMs: 0,
  });
  const facade = new TeamProvisioningRuntimeSnapshotFacade({
    runs: new Map(),
    runtimeAdapterRunByTeam: new Map(),
    teamMetaStore: {
      getMeta: async () => {
        buildCount += 1;
        return options.getMeta ? options.getMeta() : null;
      },
    },
    membersMetaStore: {
      getMembers: async () => [],
    },
    launchStateStore: {
      read: async () => null,
    },
    readConfigSnapshot: async (teamName): Promise<TeamConfig> => ({
      name: teamName,
      members: [],
    }),
    readPersistedRuntimeMembers: () => [],
    getMemberSpawnStatuses: async (): Promise<MemberSpawnStatusesSnapshot> => ({
      statuses: {},
      runId,
    }),
    getLiveTeamAgentRuntimeMetadata: async () => new Map(),
    createRuntimeSnapshotResourceSamplingPorts: () => ({
      readRuntimeProcessRowsForUsageSnapshot: async () => null,
      readProcessUsageStatsByPid: async () => new Map(),
      buildRuntimeUsageProcessTrees: () => new Map(),
      buildRuntimeProcessLoadStats: () => undefined,
      agentRuntimeResourceHistory: resourceHistory,
    }),
    agentRuntimeSnapshotCache,
    getRuntimeSnapshotCacheGeneration: () => generation,
    getTrackedRunId: () => runId,
    getAgentRuntimeSnapshotCacheTtlMs: () => options.ttlMs ?? 60_000,
    ...(options.buildTeamAgentRuntimeSnapshot
      ? { buildTeamAgentRuntimeSnapshot: options.buildTeamAgentRuntimeSnapshot }
      : {}),
    logDebug: () => undefined,
  });

  return {
    facade,
    agentRuntimeSnapshotCache,
    getBuildCount: () => buildCount,
    setRunId: (nextRunId: string | null) => {
      runId = nextRunId;
    },
    incrementGeneration: () => {
      generation += 1;
    },
  };
}

describe('TeamProvisioningRuntimeSnapshotFacade', () => {
  it('returns a fresh cached snapshot for the same tracked run', async () => {
    const harness = createFacadeHarness();

    const first = await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    const second = await harness.facade.getTeamAgentRuntimeSnapshot('alpha');

    expect(second).toBe(first);
    expect(harness.getBuildCount()).toBe(1);
    expect(harness.agentRuntimeSnapshotCache.get('alpha')?.snapshot).toBe(first);
  });

  it('coalesces concurrent snapshot builds for the same tracked run', async () => {
    const deferred = createDeferred<null>();
    const harness = createFacadeHarness({
      ttlMs: 0,
      getMeta: () => deferred.promise,
    });

    const first = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    const second = harness.facade.getTeamAgentRuntimeSnapshot('alpha');

    expect(harness.getBuildCount()).toBe(1);

    deferred.resolve(null);
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(secondSnapshot).toBe(firstSnapshot);

    await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    expect(harness.getBuildCount()).toBe(2);
  });

  it('keeps in-flight snapshot builds single-flight across cache invalidation for the same tracked run', async () => {
    const firstProbe = createDeferred<TeamAgentRuntimeSnapshot>();
    const secondProbe = createDeferred<TeamAgentRuntimeSnapshot>();
    const firstSnapshot: TeamAgentRuntimeSnapshot = {
      teamName: 'alpha',
      updatedAt: '2026-06-20T17:19:11.000Z',
      runId: null,
      members: {},
    };
    const secondSnapshot: TeamAgentRuntimeSnapshot = {
      ...firstSnapshot,
      updatedAt: '2026-06-20T17:20:11.000Z',
    };
    const buildTeamAgentRuntimeSnapshot = vi.fn<BuildTeamAgentRuntimeSnapshotPort>();
    buildTeamAgentRuntimeSnapshot
      .mockReturnValueOnce(firstProbe.promise)
      .mockReturnValueOnce(secondProbe.promise);
    const harness = createFacadeHarness({ buildTeamAgentRuntimeSnapshot });

    const first = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    harness.incrementGeneration();
    const second = harness.facade.getTeamAgentRuntimeSnapshot('alpha');

    expect(buildTeamAgentRuntimeSnapshot).toHaveBeenCalledTimes(1);
    expect(buildTeamAgentRuntimeSnapshot.mock.calls[0]?.[0]).toMatchObject({
      teamName: 'alpha',
      runId: null,
      generationAtStart: 0,
    });
    firstProbe.resolve(firstSnapshot);
    await expect(first).resolves.toBe(firstSnapshot);
    await expect(second).resolves.toBe(firstSnapshot);

    const fresh = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    expect(buildTeamAgentRuntimeSnapshot).toHaveBeenCalledTimes(2);
    expect(buildTeamAgentRuntimeSnapshot.mock.calls[1]?.[0]).toMatchObject({
      teamName: 'alpha',
      runId: null,
      generationAtStart: 1,
    });
    secondProbe.resolve(secondSnapshot);
    await expect(fresh).resolves.toBe(secondSnapshot);
  });

  it('starts a separate in-flight snapshot when the tracked run changes', async () => {
    const firstDeferred = createDeferred<null>();
    const secondDeferred = createDeferred<null>();
    const gates = [firstDeferred, secondDeferred];
    let gateIndex = 0;
    const harness = createFacadeHarness({
      getMeta: () => gates[gateIndex++]?.promise ?? Promise.resolve(null),
    });

    harness.setRunId('run-1');
    const first = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
    harness.setRunId('run-2');
    const second = harness.facade.getTeamAgentRuntimeSnapshot('alpha');

    expect(harness.getBuildCount()).toBe(2);

    firstDeferred.resolve(null);
    secondDeferred.resolve(null);
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(firstSnapshot.runId).toBe('run-1');
    expect(secondSnapshot.runId).toBe('run-2');
  });
});
