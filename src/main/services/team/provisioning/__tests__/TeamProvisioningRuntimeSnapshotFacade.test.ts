import { TeamAgentRuntimeResourceHistory } from '@main/services/team/TeamAgentRuntimeResourceHistory';
import { describe, expect, it } from 'vitest';

import { TeamProvisioningRuntimeSnapshotFacade } from '../TeamProvisioningRuntimeSnapshotFacade';

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

function createFacadeHarness(options: { ttlMs?: number; getMeta?: () => Promise<null> } = {}) {
  let runId: string | null = null;
  const generation = 0;
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
    logDebug: () => undefined,
  });

  return {
    facade,
    agentRuntimeSnapshotCache,
    getBuildCount: () => buildCount,
    setRunId: (nextRunId: string | null) => {
      runId = nextRunId;
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
