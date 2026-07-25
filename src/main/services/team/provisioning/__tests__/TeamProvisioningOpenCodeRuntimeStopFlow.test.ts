import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeRuntimeStopFlowPorts,
  type SingleMixedSecondaryRuntimeLaneStopPorts,
  type SingleMixedSecondaryRuntimeLaneStopRun,
  stopMixedSecondaryRuntimeLanes,
  stopOpenCodeRuntimeAdapterTeam,
  stopSingleMixedSecondaryRuntimeLane,
} from '../TeamProvisioningOpenCodeRuntimeStopFlow';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type {
  MixedSecondaryRuntimeLaneState,
  SecondaryRuntimeRunEntry,
} from '../TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function snapshot(teamName = 'team-a'): PersistedTeamLaunchSnapshot {
  return {
    teamName,
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    leadSessionId: 'lead-session',
    expectedMembers: ['Lead', 'Worker'],
    members: {
      Lead: {
        memberName: 'Lead',
        providerId: 'opencode',
        launchState: 'running',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        diagnostics: [],
      },
    },
    summary: {
      totalMembers: 1,
      runningMembers: 1,
      failedMembers: 0,
      pendingMembers: 0,
      completedMembers: 0,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as PersistedTeamLaunchSnapshot;
}

function makeAdapter(
  stop: TeamLaunchRuntimeAdapter['stop'] = vi.fn(async (input) => ({
    runId: input.runId,
    teamName: input.teamName,
    stopped: true,
    members: {},
    warnings: [],
    diagnostics: [],
  }))
): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop,
  } as unknown as TeamLaunchRuntimeAdapter;
}

function makePorts(
  input: {
    adapter?: TeamLaunchRuntimeAdapter | null;
    secondaryRuns?: SecondaryRuntimeRunEntry[];
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
    nowIsoValues?: string[];
    clearLane?: OpenCodeRuntimeStopFlowPorts['clearOpenCodeRuntimeLaneStorage'];
  } = {}
): OpenCodeRuntimeStopFlowPorts & {
  aliveRunByTeam: Map<string, string>;
  aliveDeleteRunIds: (string | null)[];
  clearCalls: { teamName: string; laneId: string; expectedRunId?: string }[];
  emittedEvents: unknown[];
  progressUpdates: TeamProvisioningProgress[];
  writeLaunchStateSnapshot: ReturnType<typeof vi.fn>;
  clearOpenCodeRuntimeToolApprovals: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn> };
} {
  const runtimeAdapterRunByTeam = new Map([
    [
      'team-a',
      {
        runId: 'run-primary',
        providerId: 'opencode' as const,
        cwd: '/runtime-cwd',
      },
    ],
  ]);
  const provisioningRunByTeam = new Map([['team-a', 'run-primary']]);
  const aliveRunByTeam = new Map([['team-a', 'run-primary']]);
  const aliveDeleteRunIds: (string | null)[] = [];
  const runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  const clearCalls: { teamName: string; laneId: string; expectedRunId?: string }[] = [];
  const progressUpdates: TeamProvisioningProgress[] = [];
  const emittedEvents: unknown[] = [];
  const nowIsoValues = [...(input.nowIsoValues ?? [])];
  const logger = { warn: vi.fn() };

  const defaultSecondaryRuns: SecondaryRuntimeRunEntry[] = [
    {
      runId: 'run-worker',
      providerId: 'opencode',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      cwd: '/worker-cwd',
    },
  ];

  return {
    teamsBasePath: '/teams',
    getSecondaryRuntimeRuns: vi.fn(() => input.secondaryRuns ?? defaultSecondaryRuns),
    stoppingSecondaryRuntimeTeams: new Set<string>(),
    getOpenCodeRuntimeAdapter: vi.fn(() =>
      Object.prototype.hasOwnProperty.call(input, 'adapter')
        ? (input.adapter ?? null)
        : makeAdapter()
    ),
    readLaunchState: vi.fn(async () => input.previousLaunchState ?? snapshot()),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, nextSnapshot) => nextSnapshot),
    readPersistedTeamProjectPath: vi.fn(() => '/persisted-cwd'),
    clearOpenCodeRuntimeLaneStorage: vi.fn(async (clearInput) => {
      clearCalls.push({
        teamName: clearInput.teamName,
        laneId: clearInput.laneId,
        expectedRunId: clearInput.expectedRunId,
      });
      return (await input.clearLane?.(clearInput)) ?? true;
    }),
    deleteSecondaryRuntimeRun: vi.fn(),
    clearSecondaryRuntimeRuns: vi.fn(),
    runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId,
    setRuntimeAdapterProgress: vi.fn((progress) => {
      runtimeAdapterProgressByRunId.set(progress.runId, progress);
      progressUpdates.push(progress);
      return progress;
    }),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    getAliveRunId: vi.fn((teamName) => aliveRunByTeam.get(teamName) ?? null),
    deleteAliveRunId: vi.fn((teamName) => {
      aliveDeleteRunIds.push(aliveRunByTeam.get(teamName) ?? null);
      aliveRunByTeam.delete(teamName);
    }),
    provisioningRunByTeam,
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitTeamChange: vi.fn((event) => {
      emittedEvents.push(event);
    }),
    logger,
    nowIso: vi.fn(() => nowIsoValues.shift() ?? '2026-01-01T00:00:01.000Z'),
    aliveRunByTeam,
    aliveDeleteRunIds,
    clearCalls,
    emittedEvents,
    progressUpdates,
  };
}

function makeSingleLaneRun(
  input: Partial<TeamCreateRequest> = {}
): SingleMixedSecondaryRuntimeLaneStopRun & {
  runId: string;
  progress: TeamProvisioningProgress;
  processKilled: boolean;
  cancelRequested: boolean;
  onProgress: ReturnType<typeof vi.fn>;
} {
  return {
    runId: 'aggregate-run',
    teamName: 'team-a',
    processKilled: false,
    cancelRequested: false,
    progress: {
      runId: 'aggregate-run',
      teamName: 'team-a',
      state: 'ready',
      message: 'OpenCode team ready',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    },
    onProgress: vi.fn(),
    request: {
      cwd: '/team-cwd',
      ...input,
    },
  };
}

function makeSingleLane(
  input: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary-worker',
    providerId: 'opencode',
    member: {
      name: 'Worker',
      role: 'Build',
      providerId: 'opencode',
      cwd: '/member-cwd',
    },
    runId: 'lane-run-existing',
    state: 'launching',
    result: {
      runId: 'lane-run-existing',
      teamName: 'team-a',
      launchPhase: 'active',
      teamLaunchState: 'running',
      members: {},
      warnings: ['result-warning'],
      diagnostics: ['result-diagnostic'],
    },
    warnings: ['warning-a'],
    diagnostics: ['diagnostic-a'],
    ...input,
  } as MixedSecondaryRuntimeLaneState;
}

function makeSingleLaneStopPorts(
  input: {
    adapter?: TeamLaunchRuntimeAdapter | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
    clearLane?: SingleMixedSecondaryRuntimeLaneStopPorts['clearOpenCodeRuntimeLaneStorage'];
  } = {}
): SingleMixedSecondaryRuntimeLaneStopPorts & {
  clearCalls: { teamName: string; laneId: string; expectedRunId?: string }[];
  logger: { warn: ReturnType<typeof vi.fn> };
  upsertOpenCodeRuntimeLaneIndexEntry: ReturnType<typeof vi.fn>;
  clearOpenCodeRuntimeLaneStorage: ReturnType<typeof vi.fn>;
  readLaunchState: ReturnType<typeof vi.fn>;
  deleteSecondaryRuntimeRun: ReturnType<typeof vi.fn>;
} {
  const clearCalls: { teamName: string; laneId: string; expectedRunId?: string }[] = [];
  const logger = { warn: vi.fn() };
  return {
    teamsBasePath: '/teams',
    getOpenCodeRuntimeAdapter: vi.fn(() =>
      Object.prototype.hasOwnProperty.call(input, 'adapter')
        ? (input.adapter ?? null)
        : makeAdapter()
    ),
    readLaunchState: vi.fn(async () => input.previousLaunchState ?? snapshot()),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
    clearOpenCodeRuntimeLaneStorage: vi.fn(async ({ teamName, laneId, expectedRunId }) => {
      clearCalls.push({ teamName, laneId, expectedRunId });
      return (
        (await input.clearLane?.({
          teamsBasePath: '/teams',
          teamName,
          laneId,
          expectedRunId,
        })) ?? true
      );
    }),
    deleteSecondaryRuntimeRun: vi.fn(),
    logger,
    clearCalls,
  };
}

function expectFinalSingleLaneState(lane: MixedSecondaryRuntimeLaneState): void {
  expect(lane.runId).toBeNull();
  expect(lane.state).toBe('finished');
  expect(lane.result).toBeNull();
  expect(lane.warnings).toEqual([]);
  expect(lane.diagnostics).toEqual([]);
}

describe('OpenCode runtime stop flow', () => {
  it('clears exact lane storage only after a single mixed secondary lane confirms stop', async () => {
    const stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const previousLaunchState = snapshot();
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(stop),
      previousLaunchState,
    });
    const lane = makeSingleLane();

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'relaunch', ports);

    expect(ports.readLaunchState).toHaveBeenCalledWith('team-a');
    expect(ports.clearCalls).toEqual([
      {
        teamName: 'team-a',
        laneId: 'secondary-worker',
        expectedRunId: 'lane-run-existing',
      },
    ]);
    expect(ports.readLaunchState.mock.invocationCallOrder[0]).toBeLessThan(
      ports.clearOpenCodeRuntimeLaneStorage.mock.invocationCallOrder[0]
    );
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      ports.clearOpenCodeRuntimeLaneStorage.mock.invocationCallOrder[0]
    );
  });

  it('retains a single lane and storage when no adapter can confirm stop', async () => {
    const ports = makeSingleLaneStopPorts({ adapter: null });
    const lane = makeSingleLane();

    await expect(
      stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports)
    ).rejects.toThrow('OpenCode runtime adapter is unavailable');

    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.runId).toBe('lane-run-existing');
  });

  it('passes the existing lane run id and request cwd fallback to adapter stop', async () => {
    const stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const previousLaunchState = snapshot();
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(stop),
      previousLaunchState,
    });
    const lane = makeSingleLane({
      runId: 'existing-lane-run',
      member: {
        name: 'Worker',
        role: 'Build',
        providerId: 'opencode',
        cwd: '   ',
      },
    });

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'user_requested', ports);

    expect(stop).toHaveBeenCalledWith({
      runId: 'existing-lane-run',
      laneId: 'secondary-worker',
      teamName: 'team-a',
      cwd: '/team-cwd',
      providerId: 'opencode',
      reason: 'user_requested',
      previousLaunchState,
      force: true,
    });
    expectFinalSingleLaneState(lane);
  });

  it('preserves a same-lane replacement installed while exact storage cleanup is awaiting', async () => {
    const clearStarted = createDeferred<void>();
    const clearRelease = createDeferred<void>();
    const lane = makeSingleLane();
    const ports = makeSingleLaneStopPorts({
      clearLane: async ({ expectedRunId }) => {
        clearStarted.resolve();
        await clearRelease.promise;
        return lane.runId === expectedRunId;
      },
    });

    const stopping = stopSingleMixedSecondaryRuntimeLane(
      makeSingleLaneRun(),
      lane,
      'relaunch',
      ports
    );
    await clearStarted.promise;
    lane.runId = 'lane-run-replacement';
    lane.state = 'launching';
    clearRelease.resolve();
    await stopping;

    expect(ports.clearCalls).toEqual([
      {
        teamName: 'team-a',
        laneId: 'secondary-worker',
        expectedRunId: 'lane-run-existing',
      },
    ]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.runId).toBe('lane-run-replacement');
    expect(lane.state).toBe('launching');
  });

  it('publishes one team-level pending-stop fence while exact secondary ownership is awaiting stop', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const run = makeSingleLaneRun();
    const previousProgress = run.progress;
    const lane = makeSingleLane();
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async (stopInput) => {
          stopStarted.resolve();
          await stopRelease.promise;
          return {
            runId: stopInput.runId,
            teamName: stopInput.teamName,
            stopped: true,
            members: {},
            warnings: [],
            diagnostics: [],
          };
        })
      ),
    });
    const helper = new TeamProvisioningRunTrackingDeliveryHelper({
      state: {
        provisioningRunByTeam: new Map([[run.teamName, run.runId]]),
        aliveRunByTeam: new Map([[run.teamName, run.runId]]),
        runs: new Map([[run.runId, run]]),
        runtimeAdapterProgressByRunId: new Map([[run.runId, previousProgress]]),
        runtimeAdapterRunByTeam: new Map([[run.teamName, { runId: run.runId }]]),
        getRetainedProvisioningProgressMap: () => new Map(),
      },
      ports: {
        notifyTeamWatchScopeChanged: vi.fn(),
        isTeamAlive: vi.fn(() => true),
        hasAlivePersistedTeamProcess: vi.fn(() => true),
        hasOnlyExplicitlyStoppedPersistedTeamProcesses: vi.fn(() => false),
        logDebug: vi.fn(),
      },
      liveRuntimeSnapshotCacheTtlMs: 1,
      persistedRuntimeSnapshotCacheTtlMs: 2,
    });

    const stopping = stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch', ports);
    await stopStarted.promise;

    expect(run.progress).toMatchObject({
      state: 'disconnected',
      message: 'Stopping OpenCode runtime lane before cleanup or relaunch',
    });
    expect(lane.runId).toBe('lane-run-existing');
    expect(helper.canDeliverToTrackedRuntimeRun(run.teamName, run.runId)).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId(run.teamName)).toBeNull();
    expect(helper.canDeliverToOpenCodeRuntimeForTeam(run.teamName)).toBe(false);

    stopRelease.resolve();
    await stopping;
    expect(run.progress).toBe(previousProgress);
    expectFinalSingleLaneState(lane);
  });

  it('retains a single lane and its storage when adapter stop throws', async () => {
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop failed');
        })
      ),
    });
    const lane = makeSingleLane();
    const run = makeSingleLaneRun();
    const previousProgress = run.progress;

    await expect(stopSingleMixedSecondaryRuntimeLane(run, lane, 'cleanup', ports)).rejects.toThrow(
      'adapter stop failed'
    );

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop mixed OpenCode lane secondary-worker: adapter stop failed'
    );
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).not.toHaveBeenCalled();
    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane).toMatchObject({
      runId: 'lane-run-existing',
      state: 'launching',
      warnings: ['warning-a'],
      diagnostics: ['diagnostic-a'],
    });
    expect(run.progress).toBe(previousProgress);
  });

  it('retains a single lane and its storage when adapter stop is not confirmed', async () => {
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async (input) => ({
          runId: input.runId,
          teamName: input.teamName,
          stopped: false,
          members: {},
          warnings: ['runtime still alive'],
          diagnostics: [],
        }))
      ),
    });
    const lane = makeSingleLane();
    const run = makeSingleLaneRun();
    const previousProgress = run.progress;

    await expect(stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch', ports)).rejects.toThrow(
      'OpenCode lane secondary-worker did not confirm stop: runtime still alive'
    );

    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).not.toHaveBeenCalled();
    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.runId).toBe('lane-run-existing');
    expect(run.progress).toBe(previousProgress);
  });

  it('does not roll back newer aggregate progress or same-lane ownership after stop failure', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const run = makeSingleLaneRun();
    const lane = makeSingleLane();
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async (stopInput) => {
          stopStarted.resolve();
          await stopRelease.promise;
          return {
            runId: stopInput.runId,
            teamName: stopInput.teamName,
            stopped: false,
            members: {},
            warnings: ['old lane still active'],
            diagnostics: [],
          };
        })
      ),
    });

    const stopping = stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch', ports);
    await stopStarted.promise;
    const newerProgress = {
      ...run.progress,
      state: 'ready' as const,
      message: 'New aggregate owner ready',
      updatedAt: '2026-01-01T00:00:05.000Z',
    };
    run.progress = newerProgress;
    lane.runId = 'lane-run-replacement';
    stopRelease.resolve();

    await expect(stopping).rejects.toThrow(
      'OpenCode lane secondary-worker did not confirm stop: old lane still active'
    );
    expect(run.progress).toBe(newerProgress);
    expect(lane.runId).toBe('lane-run-replacement');
  });

  it('retains mixed secondary lane storage and run state when no adapter is available', async () => {
    const ports = makePorts({
      adapter: null,
      secondaryRuns: [
        {
          runId: 'run-a',
          providerId: 'opencode',
          laneId: 'lane-a',
          memberName: 'A',
        },
        {
          runId: 'run-b',
          providerId: 'opencode',
          laneId: 'lane-b',
          memberName: 'B',
        },
      ],
    });

    await expect(stopMixedSecondaryRuntimeLanes('team-a', ports)).rejects.toThrow(
      'OpenCode runtime adapter is unavailable'
    );

    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('stops every mixed secondary lane but retains a lane whose stop throws', async () => {
    const stop = vi.fn(async (input) => {
      if (input.laneId === 'lane-a') {
        throw new Error('lane stop failed');
      }
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const previousLaunchState = snapshot();
    const ports = makePorts({
      adapter: makeAdapter(stop),
      previousLaunchState,
      secondaryRuns: [
        {
          runId: 'run-a',
          providerId: 'opencode',
          laneId: 'lane-a',
          memberName: 'A',
        },
        {
          runId: 'run-b',
          providerId: 'opencode',
          laneId: 'lane-b',
          memberName: 'B',
          cwd: '/lane-b-cwd',
        },
      ],
    });

    await expect(stopMixedSecondaryRuntimeLanes('team-a', ports)).rejects.toThrow(
      'lane stop failed'
    );

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: 'run-a',
        laneId: 'lane-a',
        teamName: 'team-a',
        cwd: '/persisted-cwd',
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState,
        force: true,
      })
    );
    expect(stop).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: 'run-b',
        laneId: 'lane-b',
        cwd: '/lane-b-cwd',
      })
    );
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalledWith('team-a', 'lane-a');
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-b');
    expect(ports.clearCalls).toEqual([
      { teamName: 'team-a', laneId: 'lane-b', expectedRunId: 'run-b' },
    ]);
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop mixed OpenCode secondary lane lane-a: lane stop failed'
    );
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('preserves a same-lane replacement installed while the immutable old run stop is awaiting', async () => {
    const stopRelease = createDeferred<void>();
    const stopStarted = createDeferred<void>();
    const secondaryRun: SecondaryRuntimeRunEntry = {
      runId: 'run-old',
      providerId: 'opencode',
      laneId: 'lane-a',
      memberName: 'A',
    };
    const laneStorageOwner = new Map([['lane-a', 'run-old']]);
    const stop = vi.fn(async (input) => {
      stopStarted.resolve();
      await stopRelease.promise;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const ports = makePorts({
      adapter: makeAdapter(stop),
      secondaryRuns: [secondaryRun],
      clearLane: async ({ laneId }) => {
        laneStorageOwner.delete(laneId);
        return true;
      },
    });

    const stopping = stopMixedSecondaryRuntimeLanes('team-a', ports);
    await stopStarted.promise;

    // Reuse and mutate the exact object returned by the store, matching the
    // verifier's run-old -> run-new replacement rather than swapping fixtures.
    secondaryRun.runId = 'run-new';
    laneStorageOwner.set('lane-a', 'run-new');
    stopRelease.resolve();
    await stopping;

    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-old' }));
    expect(secondaryRun.runId).toBe('run-new');
    expect(laneStorageOwner.get('lane-a')).toBe('run-new');
    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
  });

  it('retains primary lane storage and run tracking when no adapter is available', async () => {
    const ports = makePorts({ adapter: null });

    await expect(stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports)).rejects.toThrow(
      'OpenCode runtime adapter is unavailable'
    );

    expect(ports.clearCalls).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(true);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(true);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(true);
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
  });

  it('writes a reconciled snapshot and disconnected progress after primary adapter success', async () => {
    const stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: ['warn-a'],
      diagnostics: ['diag-a', 'diag-b'],
    }));
    const previousLaunchState = snapshot();
    const ports = makePorts({
      adapter: makeAdapter(stop),
      previousLaunchState,
      nowIsoValues: ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'],
    });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-primary',
        laneId: 'primary',
        teamName: 'team-a',
        cwd: '/runtime-cwd',
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState,
        force: true,
      })
    );
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.progressUpdates.at(-1)).toEqual(
      expect.objectContaining({
        runId: 'run-primary',
        teamName: 'team-a',
        state: 'disconnected',
        message: 'OpenCode team stopped',
        updatedAt: '2026-01-01T00:00:02.000Z',
        cliLogsTail: 'diag-a\ndiag-b',
        warnings: ['warn-a'],
      })
    );
  });

  it('publishes a non-deliverable stop fence while retaining exact primary ownership', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async (input) => {
          stopStarted.resolve();
          await stopRelease.promise;
          return {
            runId: input.runId,
            teamName: input.teamName,
            stopped: true,
            members: {},
            warnings: [],
            diagnostics: [],
          };
        })
      ),
    });

    const stopping = stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);
    await stopStarted.promise;

    expect(ports.progressUpdates).toHaveLength(1);
    expect(ports.progressUpdates[0]).toMatchObject({
      runId: 'run-primary',
      teamName: 'team-a',
      state: 'disconnected',
      message: 'Stopping OpenCode team through runtime adapter',
    });
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-primary');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.clearCalls).toEqual([]);

    stopRelease.resolve();
    await stopping;
  });

  it('records failed progress and retains primary ownership after adapter failure', async () => {
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop exploded');
        })
      ),
      nowIsoValues: ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'],
    });

    await expect(stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports)).rejects.toThrow(
      'adapter stop exploded'
    );

    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.progressUpdates.at(-1)).toEqual(
      expect.objectContaining({
        runId: 'run-primary',
        teamName: 'team-a',
        state: 'failed',
        message: 'OpenCode team stop failed',
        messageSeverity: 'error',
        updatedAt: '2026-01-01T00:00:02.000Z',
        error: 'adapter stop exploded',
        cliLogsTail: 'adapter stop exploded',
      })
    );
    expect(ports.clearCalls).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-primary');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.emittedEvents).toEqual([]);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
  });

  it('retains primary ownership and does not emit stopped when adapter returns stopped false', async () => {
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async (input) => ({
          runId: input.runId,
          teamName: input.teamName,
          stopped: false,
          members: {},
          warnings: [],
          diagnostics: ['runtime still active'],
        }))
      ),
    });

    await expect(stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports)).rejects.toThrow(
      'OpenCode team did not confirm stop: runtime still active'
    );

    expect(ports.clearCalls).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-primary');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.emittedEvents).toEqual([]);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
  });

  it('preserves newer primary storage and alive ownership installed during the first clear await', async () => {
    const firstClearRelease = createDeferred<void>();
    const firstClearStarted = createDeferred<void>();
    const primaryStorageOwner = new Map([['primary', 'run-primary']]);
    let clearCount = 0;
    const ports = makePorts({
      adapter: makeAdapter(),
      previousLaunchState: snapshot(),
      clearLane: async ({ laneId }) => {
        clearCount += 1;
        primaryStorageOwner.delete(laneId);
        if (clearCount === 1) {
          firstClearStarted.resolve();
          await firstClearRelease.promise;
        }
        return true;
      },
    });

    const stopping = stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);
    await firstClearStarted.promise;

    // An alive-only newer owner is sufficient authority. It installs its lane
    // storage while the old run's already-issued clear is still settling.
    ports.aliveRunByTeam.set('team-a', 'run-new');
    primaryStorageOwner.set('primary', 'run-new');
    firstClearRelease.resolve();
    await stopping;

    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-new');
    expect(ports.aliveDeleteRunIds).toEqual([]);
    expect(primaryStorageOwner.get('primary')).toBe('run-new');
    expect(ports.clearCalls).toEqual([
      { teamName: 'team-a', laneId: 'primary', expectedRunId: 'run-primary' },
    ]);
  });
});
