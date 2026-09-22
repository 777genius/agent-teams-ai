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
type RuntimeSnapshotResourceSamplingPorts = ReturnType<
  TeamProvisioningRuntimeSnapshotFacadePorts['createRuntimeSnapshotResourceSamplingPorts']
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
  const pruneAgentRuntimeResourceHistory = vi.fn(
    (teamName: string, activeKeys: ReadonlySet<string>) => {
      resourceHistory.prune(teamName, activeKeys);
    }
  );
  // Mirrors the production factory: the read-only build is handed the
  // write-free history port, which reports the series a member already has and
  // prunes nothing.
  const createRuntimeSnapshotResourceSamplingPortsSpy = vi.fn(
    (portOptions?: { readOnly?: boolean }): RuntimeSnapshotResourceSamplingPorts => ({
      readRuntimeProcessRowsForUsageSnapshot: async () => null,
      readProcessUsageStatsByPid: async () => new Map(),
      buildRuntimeUsageProcessTrees: () => new Map(),
      buildRuntimeProcessLoadStats: () => undefined,
      agentRuntimeResourceHistory:
        portOptions?.readOnly === true
          ? {
              record: (recordParams) => resourceHistory.read(recordParams),
              prune: () => undefined,
            }
          : {
              record: (recordParams) => resourceHistory.record(recordParams),
              prune: pruneAgentRuntimeResourceHistory,
            },
    })
  );
  const getMemberSpawnStatusesPort = vi.fn(
    async (): Promise<MemberSpawnStatusesSnapshot> => ({ statuses: {}, runId })
  );
  const getMemberSpawnStatusesReadOnlyPort = vi.fn(
    async (): Promise<MemberSpawnStatusesSnapshot> => ({ statuses: {}, runId })
  );
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
    getMemberSpawnStatuses: getMemberSpawnStatusesPort,
    getMemberSpawnStatusesReadOnly: getMemberSpawnStatusesReadOnlyPort,
    getLiveTeamAgentRuntimeMetadata: async () => new Map(),
    createRuntimeSnapshotResourceSamplingPorts: createRuntimeSnapshotResourceSamplingPortsSpy,
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
    pruneAgentRuntimeResourceHistory,
    createRuntimeSnapshotResourceSamplingPortsSpy,
    resourceHistory,
    getMemberSpawnStatusesReadOnlyPort,
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

  describe('read-only snapshot', () => {
    it('never prunes the shared runtime telemetry history and never fills the cache', async () => {
      const harness = createFacadeHarness({ ttlMs: 0 });

      await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      expect(harness.pruneAgentRuntimeResourceHistory).toHaveBeenCalledTimes(1);
      const cachedAfterMutatingBuild = harness.agentRuntimeSnapshotCache.get('alpha');
      expect(cachedAfterMutatingBuild).toBeDefined();

      await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');

      // A monitor poll resolving one member without a pid would otherwise drop
      // that member's accumulated series and restart the sparkline.
      expect(harness.pruneAgentRuntimeResourceHistory).toHaveBeenCalledTimes(1);
      expect(harness.agentRuntimeSnapshotCache.get('alpha')).toBe(cachedAfterMutatingBuild);
    });

    // Recording a sample is an in-memory write to a history every reader of
    // this team shares, so the write-free build takes the port that reports a
    // member's series instead of extending it.
    it('takes the write-free resource history port', async () => {
      const harness = createFacadeHarness({ ttlMs: 0 });

      await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      expect(harness.createRuntimeSnapshotResourceSamplingPortsSpy).toHaveBeenLastCalledWith(
        undefined
      );

      await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');
      expect(harness.createRuntimeSnapshotResourceSamplingPortsSpy).toHaveBeenLastCalledWith({
        readOnly: true,
      });
    });

    it('coalesces concurrent read-only builds for the same tracked run', async () => {
      const deferred = createDeferred<null>();
      const harness = createFacadeHarness({ ttlMs: 0, getMeta: () => deferred.promise });

      const first = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');
      const second = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');

      expect(harness.getBuildCount()).toBe(1);

      deferred.resolve(null);
      const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
      expect(secondSnapshot).toBe(firstSnapshot);
      expect(harness.pruneAgentRuntimeResourceHistory).not.toHaveBeenCalled();
    });

    it('rides a build the mutating getter already started', async () => {
      const deferred = createDeferred<null>();
      const harness = createFacadeHarness({ ttlMs: 0, getMeta: () => deferred.promise });

      const mutating = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      const readOnly = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');

      expect(harness.getBuildCount()).toBe(1);

      deferred.resolve(null);
      const [mutatingSnapshot, readOnlySnapshot] = await Promise.all([mutating, readOnly]);
      expect(readOnlySnapshot).toBe(mutatingSnapshot);
    });

    // The read-only status projection neither coalesces nor fills a cache, so
    // a caller that needs both halves - the HTTP diagnostics route reports the
    // statuses next to this snapshot - would otherwise run two of them.
    it('builds from a status projection the caller already made', async () => {
      let projectionUsedByBuild: MemberSpawnStatusesSnapshot | undefined;
      const buildTeamAgentRuntimeSnapshot = vi.fn<BuildTeamAgentRuntimeSnapshotPort>(
        async (params) => {
          projectionUsedByBuild = await params.getMemberSpawnStatuses('alpha');
          return {
            teamName: 'alpha',
            updatedAt: '2026-06-20T17:19:11.000Z',
            runId: params.runId,
            members: {},
          };
        }
      );
      const harness = createFacadeHarness({ ttlMs: 0, buildTeamAgentRuntimeSnapshot });
      harness.setRunId('run-1');
      const memberSpawnStatuses: MemberSpawnStatusesSnapshot = { statuses: {}, runId: 'run-1' };

      await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha', { memberSpawnStatuses });

      expect(projectionUsedByBuild).toBe(memberSpawnStatuses);
      expect(harness.getMemberSpawnStatusesReadOnlyPort).not.toHaveBeenCalled();
    });

    // Both directions of the rule: a caller that supplied a projection is
    // answered by a build of its own even when the cached snapshot is for the
    // very same run, and a caller that supplied none still rides that snapshot
    // - otherwise the rule would just be "never share anything".
    it('answers a supplied projection with its own build and a plain read from the cache', async () => {
      const harness = createFacadeHarness({ ttlMs: 60_000 });
      harness.setRunId('run-2');
      const shared = await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      expect(harness.agentRuntimeSnapshotCache.get('alpha')?.snapshot).toBe(shared);

      const staleProjection: MemberSpawnStatusesSnapshot = { statuses: {}, runId: 'run-1' };
      const rebuilt = await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha', {
        memberSpawnStatuses: staleProjection,
      });
      expect(rebuilt).not.toBe(shared);

      const currentProjection: MemberSpawnStatusesSnapshot = { statuses: {}, runId: 'run-2' };
      const rebuiltForCurrentRun = await harness.facade.getTeamAgentRuntimeSnapshotReadOnly(
        'alpha',
        { memberSpawnStatuses: currentProjection }
      );
      expect(rebuiltForCurrentRun).not.toBe(shared);

      const polled = await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');
      expect(polled).toBe(shared);
    });

    // The snapshot cache is keyed by team and run and nothing in the key says
    // which status projection filled it, so an entry for the tracked run can
    // still carry runtime members projected from an earlier read of the
    // statuses. Serving it to a caller that supplied its own projection is the
    // two-views defect this parameter exists to remove, in a different order.
    it('rebuilds rather than serving a cached snapshot made from another projection', async () => {
      const projectionByBuild: MemberSpawnStatusesSnapshot[] = [];
      const buildTeamAgentRuntimeSnapshot = vi.fn<BuildTeamAgentRuntimeSnapshotPort>(
        async (params) => {
          projectionByBuild.push(await params.getMemberSpawnStatuses(params.teamName));
          const snapshot: TeamAgentRuntimeSnapshot = {
            teamName: params.teamName,
            updatedAt: `2026-06-20T17:19:0${projectionByBuild.length}.000Z`,
            runId: params.runId,
            members: {},
          };
          // Mirrors the production builder, whose publish the facade drops for
          // a write-free build.
          params.rememberAgentRuntimeSnapshot({
            teamName: params.teamName,
            runId: params.runId,
            generationAtStart: params.generationAtStart,
            snapshot,
            ttlMs: params.getAgentRuntimeSnapshotCacheTtlMs(params.teamName, params.runId),
          });
          return snapshot;
        }
      );
      const harness = createFacadeHarness({ ttlMs: 60_000, buildTeamAgentRuntimeSnapshot });
      harness.setRunId('run-1');

      const cachedFromFirstProjection = await harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      const cacheEntry = harness.agentRuntimeSnapshotCache.get('alpha');
      expect(cacheEntry?.snapshot).toBe(cachedFromFirstProjection);

      const secondProjection: MemberSpawnStatusesSnapshot = { statuses: {}, runId: 'run-1' };
      const answered = await harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha', {
        memberSpawnStatuses: secondProjection,
      });

      expect(projectionByBuild[0]).not.toBe(secondProjection);
      expect(projectionByBuild[1]).toBe(secondProjection);
      expect(answered).not.toBe(cachedFromFirstProjection);
      // The write-free build stays this caller's: the cache keeps the entry the
      // writing build published.
      expect(harness.agentRuntimeSnapshotCache.get('alpha')).toBe(cacheEntry);
      expect(harness.agentRuntimeSnapshotCache.get('alpha')?.snapshot).toBe(
        cachedFromFirstProjection
      );
    });

    // The in-flight maps are keyed the same way, so the same mismatch reaches a
    // build that has not finished yet - in both directions.
    it('neither joins nor publishes an in-flight build when the caller supplied a projection', async () => {
      const gates = [
        createDeferred<null>(),
        createDeferred<null>(),
        createDeferred<null>(),
        createDeferred<null>(),
      ];
      let gateIndex = 0;
      const harness = createFacadeHarness({
        ttlMs: 0,
        getMeta: () => gates[gateIndex++]?.promise ?? Promise.resolve(null),
      });
      harness.setRunId('run-1');
      const memberSpawnStatuses: MemberSpawnStatusesSnapshot = { statuses: {}, runId: 'run-1' };

      const mutating = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      const alongsideMutating = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha', {
        memberSpawnStatuses,
      });
      expect(harness.getBuildCount()).toBe(2);
      gates[0]?.resolve(null);
      gates[1]?.resolve(null);
      const [mutatingSnapshot, alongsideMutatingSnapshot] = await Promise.all([
        mutating,
        alongsideMutating,
      ]);
      expect(alongsideMutatingSnapshot).not.toBe(mutatingSnapshot);

      const diagnostics = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha', {
        memberSpawnStatuses,
      });
      const polled = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');
      expect(harness.getBuildCount()).toBe(4);
      gates[2]?.resolve(null);
      gates[3]?.resolve(null);
      const [diagnosticsSnapshot, polledSnapshot] = await Promise.all([diagnostics, polled]);
      expect(polledSnapshot).not.toBe(diagnosticsSnapshot);
    });

    it('starts its own build when the tracked run moved on', async () => {
      const firstDeferred = createDeferred<null>();
      const secondDeferred = createDeferred<null>();
      const gates = [firstDeferred, secondDeferred];
      let gateIndex = 0;
      const harness = createFacadeHarness({
        ttlMs: 0,
        getMeta: () => gates[gateIndex++]?.promise ?? Promise.resolve(null),
      });

      harness.setRunId('run-1');
      const mutating = harness.facade.getTeamAgentRuntimeSnapshot('alpha');
      harness.setRunId('run-2');
      const readOnly = harness.facade.getTeamAgentRuntimeSnapshotReadOnly('alpha');

      expect(harness.getBuildCount()).toBe(2);

      firstDeferred.resolve(null);
      secondDeferred.resolve(null);
      const [mutatingSnapshot, readOnlySnapshot] = await Promise.all([mutating, readOnly]);
      expect(mutatingSnapshot.runId).toBe('run-1');
      expect(readOnlySnapshot.runId).toBe('run-2');
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
