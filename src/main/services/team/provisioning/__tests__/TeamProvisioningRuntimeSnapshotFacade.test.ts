import { TeamAgentRuntimeResourceHistory } from '@main/services/team/TeamAgentRuntimeResourceHistory';
import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningRuntimeSnapshotCacheBoundary } from '../TeamProvisioningRuntimeSnapshotCache';
import {
  TeamProvisioningRuntimeSnapshotFacade,
  type TeamProvisioningRuntimeSnapshotFacadePorts,
} from '../TeamProvisioningRuntimeSnapshotFacade';
import { type TeamProvisioningRuntimeStateProjectionRun } from '../TeamProvisioningRuntimeStateProjection';

import type {
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamProvisioningProgress,
  TeamRuntimeState,
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
type RuntimeSnapshotFacadeRun =
  TeamProvisioningRuntimeSnapshotFacadePorts['runs'] extends ReadonlyMap<string, infer T>
    ? T
    : never;
type RuntimeSnapshotFacadeProjectionRun = RuntimeSnapshotFacadeRun &
  TeamProvisioningRuntimeStateProjectionRun;

function progress(
  runId: string,
  teamName: string,
  state: TeamProvisioningProgress['state'] = 'ready'
): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state,
    message: `${state} message`,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

function runtimeRun(
  runId: string,
  teamName: string,
  options: Partial<
    Pick<RuntimeSnapshotFacadeProjectionRun, 'child' | 'processKilled' | 'cancelRequested'>
  > = {}
): RuntimeSnapshotFacadeProjectionRun {
  return {
    runId,
    child: {},
    processKilled: false,
    cancelRequested: false,
    progress: progress(runId, teamName),
    request: {
      teamName,
      members: [],
      cwd: '/safe-test-workspace/test-team',
    },
    ...options,
  };
}

function createFacadeHarness(
  options: {
    ttlMs?: number;
    getMeta?: () => Promise<null>;
    buildTeamAgentRuntimeSnapshot?: BuildTeamAgentRuntimeSnapshotPort;
  } = {}
) {
  let runId: string | null = null;
  let buildCount = 0;
  const agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >();
  const runs = new Map<string, RuntimeSnapshotFacadeProjectionRun>();
  const provisioningRunByTeam = new Map<string, string>();
  const aliveRunByTeam = new Map<string, string>();
  const runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  const retainedProgressByRunId = new Map<string, TeamProvisioningProgress>();
  const bootstrapStateByTeam = new Map<string, TeamRuntimeState>();
  const readBootstrapRuntimeState = vi.fn(async (teamName: string) => {
    return bootstrapStateByTeam.get(teamName) ?? null;
  });
  const runtimeSnapshotCache = new TeamProvisioningRuntimeSnapshotCacheBoundary<
    TeamAgentRuntimeSnapshot,
    Map<string, unknown>,
    MemberSpawnStatusesSnapshot,
    TeamConfig
  >({
    agentRuntimeSnapshotCache,
    liveTeamAgentRuntimeMetadataCache: new Map(),
    persistedTeamConfigCache: new Map(),
    memberSpawnStatusesSnapshotCache: new Map(),
    memberSpawnStatusesInFlightByTeam: new Map(),
  });
  const resourceHistory = new TeamAgentRuntimeResourceHistory({
    historyLimit: 10,
    minSampleIntervalMs: 0,
  });
  const facade = new TeamProvisioningRuntimeSnapshotFacade({
    runs,
    runtimeAdapterRunByTeam: new Map(),
    runtimeState: {
      provisioningRunByTeam,
      runs,
      runtimeAdapterRunByTeam: new Map(),
      runtimeAdapterProgressByRunId,
      getRetainedProvisioningProgressMap: () => retainedProgressByRunId,
    },
    runtimeStatePorts: {
      getAliveRunId: (teamName) => aliveRunByTeam.get(teamName) ?? null,
      getTrackedRunId: (teamName) =>
        provisioningRunByTeam.get(teamName) ?? aliveRunByTeam.get(teamName) ?? null,
      getAliveTeamNames: () => [...aliveRunByTeam.keys()],
      hasSecondaryRuntimeRuns: () => false,
      readBootstrapRuntimeState,
    },
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
    runtimeSnapshotCache,
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
    runtimeState: {
      runs,
      provisioningRunByTeam,
      aliveRunByTeam,
      runtimeAdapterProgressByRunId,
      retainedProgressByRunId,
      bootstrapStateByTeam,
      readBootstrapRuntimeState,
    },
    incrementGeneration: () => {
      runtimeSnapshotCache.invalidateRuntimeSnapshotCaches('alpha');
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

  it('starts a fresh snapshot build after cache invalidation for the same tracked run', async () => {
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

    expect(buildTeamAgentRuntimeSnapshot).toHaveBeenCalledTimes(2);
    expect(buildTeamAgentRuntimeSnapshot.mock.calls[0]?.[0]).toMatchObject({
      teamName: 'alpha',
      runId: null,
      generationAtStart: 0,
    });
    expect(buildTeamAgentRuntimeSnapshot.mock.calls[1]?.[0]).toMatchObject({
      teamName: 'alpha',
      runId: null,
      generationAtStart: 1,
    });
    firstProbe.resolve(firstSnapshot);
    await expect(first).resolves.toBe(firstSnapshot);
    secondProbe.resolve(secondSnapshot);
    await expect(second).resolves.toBe(secondSnapshot);
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

  it('delegates runtime state projection through the snapshot facade', async () => {
    const harness = createFacadeHarness();
    const teamName = 'alpha';
    const runId = 'run-alpha';
    harness.runtimeState.provisioningRunByTeam.set(teamName, runId);
    harness.runtimeState.aliveRunByTeam.set(teamName, runId);
    harness.runtimeState.runs.set(runId, runtimeRun(runId, teamName));

    expect(harness.facade.hasProvisioningRun(teamName)).toBe(true);
    expect(harness.facade.isTeamAlive(teamName)).toBe(true);
    expect(harness.facade.getAliveTeams()).toEqual([teamName]);
    await expect(harness.facade.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: true,
      runId,
      progress: progress(runId, teamName),
    });
  });

  it('uses recovered bootstrap runtime state when the facade has no current run', async () => {
    const harness = createFacadeHarness();
    const teamName = 'alpha';
    const recovered: TeamRuntimeState = {
      teamName,
      isAlive: false,
      runId: 'run-recovered',
      progress: progress('run-recovered', teamName, 'failed'),
    };
    harness.runtimeState.bootstrapStateByTeam.set(teamName, recovered);

    await expect(harness.facade.getRuntimeState(teamName)).resolves.toBe(recovered);
    expect(harness.runtimeState.readBootstrapRuntimeState).toHaveBeenCalledWith(teamName);
  });
});
