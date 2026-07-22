import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeRuntimeStopFlowPorts,
  type SingleMixedSecondaryRuntimeLaneStopPorts,
  stopMixedSecondaryRuntimeLanes,
  stopOpenCodeRuntimeAdapterTeam,
  stopSingleMixedSecondaryRuntimeLane,
} from '../TeamProvisioningOpenCodeRuntimeStopFlow';

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
  clearCalls: Array<{ teamName: string; laneId: string }>;
  emittedEvents: unknown[];
  progressUpdates: TeamProvisioningProgress[];
  writeLaunchStateSnapshot: ReturnType<typeof vi.fn>;
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
  const clearCalls: Array<{ teamName: string; laneId: string }> = [];
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
      clearCalls.push({ teamName: clearInput.teamName, laneId: clearInput.laneId });
      await input.clearLane?.(clearInput);
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

function makeSingleLaneRun(input: Partial<TeamCreateRequest> = {}) {
  return {
    teamName: 'team-a',
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
  } = {}
): SingleMixedSecondaryRuntimeLaneStopPorts & {
  clearCalls: Array<{ teamName: string; laneId: string }>;
  logger: { warn: ReturnType<typeof vi.fn> };
  upsertOpenCodeRuntimeLaneIndexEntry: ReturnType<typeof vi.fn>;
  readLaunchState: ReturnType<typeof vi.fn>;
  deleteSecondaryRuntimeRun: ReturnType<typeof vi.fn>;
} {
  const clearCalls: Array<{ teamName: string; laneId: string }> = [];
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
    clearOpenCodeRuntimeLaneStorage: vi.fn(async ({ teamName, laneId }) => {
      clearCalls.push({ teamName, laneId });
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
  it('upserts a stopped index entry before stopping a single mixed secondary lane', async () => {
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
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary-worker',
      state: 'stopped',
      diagnostics: ['OpenCode lane stop requested: relaunch'],
    });
    expect(ports.readLaunchState.mock.invocationCallOrder[0]).toBeLessThan(
      ports.upsertOpenCodeRuntimeLaneIndexEntry.mock.invocationCallOrder[0]
    );
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0]
    );
  });

  it('clears storage, deletes the secondary run, and resets a single lane when no adapter is available', async () => {
    const ports = makeSingleLaneStopPorts({ adapter: null });
    const lane = makeSingleLane();

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports);

    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'secondary-worker' }]);
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'secondary-worker');
    expectFinalSingleLaneState(lane);
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

  it('logs a single lane stop warning when adapter stop fails but still runs final cleanup', async () => {
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop failed');
        })
      ),
    });
    const lane = makeSingleLane();

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop mixed OpenCode lane secondary-worker: adapter stop failed'
    );
    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'secondary-worker' }]);
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'secondary-worker');
    expectFinalSingleLaneState(lane);
  });

  it('clears mixed secondary lane storage and run state when no adapter is available', async () => {
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

    await stopMixedSecondaryRuntimeLanes('team-a', ports);

    expect(ports.clearCalls).toEqual([
      { teamName: 'team-a', laneId: 'lane-a' },
      { teamName: 'team-a', laneId: 'lane-b' },
    ]);
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-a');
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-b');
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('stops every mixed secondary lane and deletes each run even when one stop throws', async () => {
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

    await stopMixedSecondaryRuntimeLanes('team-a', ports);

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
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-a');
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-b');
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
    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'lane-a' }]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
  });

  it('clears primary lane storage and run tracking when no adapter is available', async () => {
    const ports = makePorts({ adapter: null });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'primary' }]);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(false);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(false);
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('team-a');
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
    expect(ports.writeLaunchStateSnapshot).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        teamName: 'team-a',
        launchPhase: 'reconciled',
        expectedMembers: previousLaunchState.expectedMembers,
        leadSessionId: previousLaunchState.leadSessionId,
      })
    );
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

  it('records failed progress with the error tail after primary adapter failure', async () => {
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop exploded');
        })
      ),
      nowIsoValues: ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'],
    });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

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
  });

  it('emits stopped and clears primary runtime tracking in final cleanup', async () => {
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop failed');
        })
      ),
    });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(ports.clearCalls.at(-1)).toEqual({ teamName: 'team-a', laneId: 'primary' });
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(false);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(false);
    expect(ports.emittedEvents).toContainEqual({
      type: 'process',
      teamName: 'team-a',
      runId: 'run-primary',
      detail: 'stopped',
    });
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
    expect(ports.aliveDeleteRunIds).toEqual(['run-primary']);
    expect(primaryStorageOwner.get('primary')).toBe('run-new');
    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'primary' }]);
  });
});
