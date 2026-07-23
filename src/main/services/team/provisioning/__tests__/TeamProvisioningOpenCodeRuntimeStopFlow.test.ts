import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningCancellationBoundary } from '../TeamProvisioningCancellationBoundary';
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
  } = {}
): OpenCodeRuntimeStopFlowPorts & {
  aliveRunByTeam: Map<string, string>;
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
    clearOpenCodeRuntimeLaneStorage: vi.fn(async ({ teamName, laneId }) => {
      clearCalls.push({ teamName, laneId });
      return 'cleared' as const;
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
    secondaryRuns?: SecondaryRuntimeRunEntry[];
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
    getSecondaryRuntimeRuns: vi.fn(
      () =>
        input.secondaryRuns ?? [
          {
            runId: 'lane-run-existing',
            providerId: 'opencode' as const,
            laneId: 'secondary-worker',
            memberName: 'Worker',
            cwd: '/member-cwd',
          },
        ]
    ),
    getOpenCodeRuntimeAdapter: vi.fn(() =>
      Object.prototype.hasOwnProperty.call(input, 'adapter')
        ? (input.adapter ?? null)
        : makeAdapter()
    ),
    readLaunchState: vi.fn(async () => input.previousLaunchState ?? snapshot()),
    upsertOpenCodeRuntimeLaneIndexEntry: vi.fn(async () => undefined),
    clearOpenCodeRuntimeLaneStorage: vi.fn(async ({ teamName, laneId }) => {
      clearCalls.push({ teamName, laneId });
      return 'cleared' as const;
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
  it('retries a retained secondary stop after the primary stop clears run ownership', async () => {
    const teamName = 'team-a';
    const runId = 'run-primary';
    const progress: TeamProvisioningProgress = {
      runId,
      teamName,
      state: 'spawning',
      message: 'Launching OpenCode lanes',
      startedAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    };
    const run = {
      runId,
      teamName,
      progress,
      cancelRequested: false,
      processKilled: false,
      child: null,
      anthropicApiKeyHelper: null,
      anthropicApiKeyHelperCleanupPromise: null,
      onProgress: vi.fn(),
    };
    const runs = new Map([[runId, run]]);
    const provisioningRunByTeam = new Map([[teamName, runId]]);
    const aliveRunByTeam = new Map([[teamName, runId]]);
    const runtimeAdapterRunByTeam = new Map([
      [teamName, { runId, providerId: 'opencode' as const }],
    ]);
    let secondaryTracked = true;
    let secondaryRuntimeAlive = true;
    const secondaryRun: SecondaryRuntimeRunEntry = {
      runId: 'run-secondary-worker',
      providerId: 'opencode',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      cwd: '/worker-cwd',
    };
    const adapterStop = vi.fn(async (input) => {
      if (adapterStop.mock.calls.length === 1) {
        throw new Error('secondary stop was not confirmed');
      }
      secondaryRuntimeAlive = false;
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const stopFlowPorts = makePorts({
      adapter: makeAdapter(adapterStop),
      secondaryRuns: [secondaryRun],
    });
    vi.mocked(stopFlowPorts.getSecondaryRuntimeRuns).mockImplementation(() =>
      secondaryTracked ? [secondaryRun] : []
    );
    vi.mocked(stopFlowPorts.deleteSecondaryRuntimeRun).mockImplementation(() => {
      secondaryTracked = false;
    });
    vi.mocked(stopFlowPorts.clearSecondaryRuntimeRuns).mockImplementation(() => {
      secondaryTracked = false;
    });
    const stopPrimary = vi.fn(async () => {
      runtimeAdapterRunByTeam.delete(teamName);
      provisioningRunByTeam.delete(teamName);
      aliveRunByTeam.delete(teamName);
    });
    const stopSecondaries = vi.fn((targetTeamName: string) =>
      stopMixedSecondaryRuntimeLanes(targetTeamName, stopFlowPorts)
    );
    const cleanupRun = vi.fn(() => {
      runs.delete(runId);
      secondaryTracked = false;
    });
    const cancellation = createTeamProvisioningCancellationBoundary({
      runs,
      runtimeAdapterProgressByRunId: new Map(),
      cancelledRuntimeAdapterRunIds: new Set(),
      runtimeAdapterRunByTeam,
      provisioningRunByTeam,
      aliveRunByTeam,
      getTrackedRunId: (targetTeamName) =>
        provisioningRunByTeam.get(targetTeamName) ?? aliveRunByTeam.get(targetTeamName) ?? null,
      deleteAliveRunId: (targetTeamName) => {
        aliveRunByTeam.delete(targetTeamName);
      },
      hasSecondaryRuntimeRuns: () => secondaryTracked,
      stopMixedSecondaryRuntimeLanes: stopSecondaries,
      stopOpenCodeRuntimeAdapterTeam: stopPrimary,
      killTeamProcess: vi.fn(),
      killTeamProcessAndWait: vi.fn(async () => undefined),
      updateProgress: (targetRun, state, message) => {
        targetRun.progress = { ...targetRun.progress, state, message };
        return targetRun.progress;
      },
      cleanupRun,
      nowIso: () => '2026-07-18T00:00:01.000Z',
      clearOpenCodeRuntimeToolApprovals: vi.fn(),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      setRuntimeAdapterProgress: (nextProgress) => nextProgress,
      emitTeamChange: vi.fn(),
      readLaunchState: async () => null,
      getOpenCodeRuntimeAdapter: () => null,
      readPersistedTeamProjectPath: () => null,
      logWarning: vi.fn(),
    });

    await expect(cancellation.cancelProvisioning(runId)).rejects.toMatchObject({
      message: `[${teamName}] Failed to stop all OpenCode secondary lanes`,
      errors: [expect.objectContaining({ message: 'secondary stop was not confirmed' })],
    });

    expect(stopPrimary).toHaveBeenCalledTimes(1);
    expect(stopSecondaries).toHaveBeenCalledTimes(1);
    expect(adapterStop).toHaveBeenCalledTimes(1);
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(runs.get(runId)).toBe(run);
    expect(secondaryTracked).toBe(true);
    expect(secondaryRuntimeAlive).toBe(true);
    expect(run.progress.state).toBe('cancelled');

    await expect(cancellation.cancelProvisioning(runId)).rejects.toThrow(
      'Provisioning cannot be cancelled in current state'
    );
    await expect(stopMixedSecondaryRuntimeLanes(teamName, stopFlowPorts)).resolves.toBeUndefined();

    expect(stopPrimary).toHaveBeenCalledTimes(1);
    expect(stopSecondaries).toHaveBeenCalledTimes(1);
    expect(adapterStop).toHaveBeenCalledTimes(2);
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(runs.get(runId)).toBe(run);
    expect(secondaryTracked).toBe(false);
    expect(secondaryRuntimeAlive).toBe(false);
  });

  it('confirms a single mixed secondary stop before updating or clearing lane evidence', async () => {
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
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'secondary-worker',
      expectedRunId: 'lane-run-existing',
    });
    expect(ports.readLaunchState.mock.invocationCallOrder[0]).toBeLessThan(
      stop.mock.invocationCallOrder[0]
    );
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      ports.upsertOpenCodeRuntimeLaneIndexEntry.mock.invocationCallOrder[0]
    );
    expect(ports.upsertOpenCodeRuntimeLaneIndexEntry.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.clearOpenCodeRuntimeLaneStorage).mock.invocationCallOrder[0]
    );
  });

  it('preserves a tracked single lane when no adapter can confirm the stop', async () => {
    const ports = makeSingleLaneStopPorts({ adapter: null });
    const lane = makeSingleLane();

    await expect(
      stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports)
    ).rejects.toThrow('OpenCode runtime adapter is unavailable; lane stop was not confirmed');

    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.runId).toBe('lane-run-existing');
    expect(lane.state).toBe('launching');
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
      secondaryRuns: [
        {
          runId: 'existing-lane-run',
          providerId: 'opencode',
          laneId: 'secondary-worker',
          memberName: 'Worker',
          cwd: '/team-cwd',
        },
      ],
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

  it('preserves single-lane evidence and propagates when adapter stop rejects', async () => {
    const ports = makeSingleLaneStopPorts({
      adapter: makeAdapter(
        vi.fn(async () => {
          throw new Error('adapter stop failed');
        })
      ),
    });
    const lane = makeSingleLane();

    await expect(
      stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports)
    ).rejects.toThrow('adapter stop failed');

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
  });

  it.each(['launch-state read', 'adapter stop', 'lane-index upsert', 'storage clear'] as const)(
    'preserves a replacement single-lane owner after the %s await',
    async (replacementPoint) => {
      const replacement: SecondaryRuntimeRunEntry = {
        runId: 'lane-run-replacement',
        providerId: 'opencode',
        laneId: 'secondary-worker',
        memberName: 'Worker',
        cwd: '/replacement-cwd',
      };
      const stop = vi.fn(async (input) => ({
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      }));
      const ports = makeSingleLaneStopPorts({ adapter: makeAdapter(stop) });
      const replaceOwner = () => {
        vi.mocked(ports.getSecondaryRuntimeRuns).mockReturnValue([replacement]);
      };
      if (replacementPoint === 'launch-state read') {
        ports.readLaunchState.mockImplementation(async () => {
          replaceOwner();
          return snapshot();
        });
      } else if (replacementPoint === 'adapter stop') {
        stop.mockImplementation(async (input) => {
          replaceOwner();
          return {
            runId: input.runId,
            teamName: input.teamName,
            stopped: true,
            members: {},
            warnings: [],
            diagnostics: [],
          };
        });
      } else if (replacementPoint === 'lane-index upsert') {
        ports.upsertOpenCodeRuntimeLaneIndexEntry.mockImplementation(async () => {
          replaceOwner();
        });
      } else {
        vi.mocked(ports.clearOpenCodeRuntimeLaneStorage).mockImplementation(async () => {
          replaceOwner();
          return 'cleared';
        });
      }
      const lane = makeSingleLane();

      await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'relaunch', ports);

      expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
      expect(lane.runId).toBe('lane-run-existing');
      expect(lane.state).toBe('launching');
      expect(ports.getSecondaryRuntimeRuns('team-a')).toEqual([replacement]);
      if (replacementPoint === 'launch-state read' || replacementPoint === 'adapter stop') {
        expect(ports.upsertOpenCodeRuntimeLaneIndexEntry).not.toHaveBeenCalled();
      }
      if (replacementPoint !== 'storage clear') {
        expect(ports.clearCalls).toEqual([]);
      }
    }
  );

  it('does not delete a single-lane map entry when durable storage reports owner_changed', async () => {
    const ports = makeSingleLaneStopPorts();
    vi.mocked(ports.clearOpenCodeRuntimeLaneStorage).mockResolvedValue('owner_changed');
    const lane = makeSingleLane();

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports);

    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(lane.runId).toBe('lane-run-existing');
    expect(lane.state).toBe('launching');
  });

  it('is idempotent after the same single-lane owner was already stopped', async () => {
    const stop = vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    }));
    const ports = makeSingleLaneStopPorts({ adapter: makeAdapter(stop) });
    const lane = makeSingleLane();

    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports);
    await stopSingleMixedSecondaryRuntimeLane(makeSingleLaneRun(), lane, 'cleanup', ports);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledTimes(1);
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledTimes(1);
    expectFinalSingleLaneState(lane);
  });

  it('preserves mixed secondary tracking when no adapter can confirm the stops', async () => {
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
      '[team-a] OpenCode runtime adapter is unavailable; secondary lane stops were not confirmed'
    );

    expect(ports.clearCalls).toEqual([]);
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('aggregates mixed-lane stop rejection while preserving the rejected lane evidence', async () => {
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

    const error = await stopMixedSecondaryRuntimeLanes('team-a', ports).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: '[team-a] Failed to stop all OpenCode secondary lanes',
      errors: [expect.objectContaining({ message: 'lane stop failed' })],
    });
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
    expect(ports.deleteSecondaryRuntimeRun).toHaveBeenCalledWith('team-a', 'lane-b');
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalledWith('team-a', 'lane-a');
    expect(ports.clearCalls).toEqual([{ teamName: 'team-a', laneId: 'lane-b' }]);
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop mixed OpenCode secondary lane lane-a: lane stop failed'
    );
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('does not stop a replacement secondary owner installed while reading launch state', async () => {
    const stoppedRun: SecondaryRuntimeRunEntry = {
      runId: 'run-worker-a',
      providerId: 'opencode',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      cwd: '/worker-a',
    };
    const newerRun: SecondaryRuntimeRunEntry = {
      ...stoppedRun,
      runId: 'run-worker-b',
      cwd: '/worker-b',
    };
    let trackedRuns = [stoppedRun];
    const stop = vi.fn();
    const ports = makePorts({ adapter: makeAdapter(stop), secondaryRuns: [stoppedRun] });
    vi.mocked(ports.getSecondaryRuntimeRuns).mockImplementation(() => trackedRuns);
    vi.mocked(ports.readLaunchState).mockImplementation(async () => {
      trackedRuns = [newerRun];
      return snapshot();
    });

    await stopMixedSecondaryRuntimeLanes('team-a', ports);

    expect(stop).not.toHaveBeenCalled();
    expect(ports.progressUpdates).toEqual([]);
    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.emittedEvents).toEqual([]);
    expect(ports.getSecondaryRuntimeRuns('team-a')).toEqual([newerRun]);
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
  });

  it('does not clear secondary lane storage for a newer owner registered during stop', async () => {
    const stoppedRun: SecondaryRuntimeRunEntry = {
      runId: 'run-worker-a',
      providerId: 'opencode',
      laneId: 'secondary-worker',
      memberName: 'Worker',
      cwd: '/worker-a',
    };
    const newerRun: SecondaryRuntimeRunEntry = {
      ...stoppedRun,
      runId: 'run-worker-b',
      cwd: '/worker-b',
    };
    let trackedRuns = [stoppedRun];
    const stop = vi.fn(async (input) => {
      trackedRuns = [newerRun];
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const ports = makePorts({ adapter: makeAdapter(stop), secondaryRuns: [stoppedRun] });
    vi.mocked(ports.getSecondaryRuntimeRuns).mockImplementation(() => trackedRuns);

    await stopMixedSecondaryRuntimeLanes('team-a', ports);

    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
    expect(ports.getSecondaryRuntimeRuns('team-a')).toEqual([newerRun]);
  });

  it('preserves a same-lane replacement installed while the immutable old run stop is awaiting', async () => {
    const secondaryRun: SecondaryRuntimeRunEntry = {
      runId: 'run-old',
      providerId: 'opencode',
      laneId: 'lane-a',
      memberName: 'A',
    };
    const stop = vi.fn(async (input) => {
      secondaryRun.runId = 'run-new';
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const ports = makePorts({ adapter: makeAdapter(stop), secondaryRuns: [secondaryRun] });

    await stopMixedSecondaryRuntimeLanes('team-a', ports);

    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-old' }));
    expect(secondaryRun.runId).toBe('run-new');
    expect(ports.clearCalls).toEqual([]);
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
    expect(ports.clearSecondaryRuntimeRuns).not.toHaveBeenCalled();
  });

  it('preserves primary evidence when no adapter can confirm the stop', async () => {
    const ports = makePorts({ adapter: null });

    await expect(stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports)).rejects.toThrow(
      'OpenCode runtime adapter is unavailable; stop was not confirmed'
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
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ports.clearOpenCodeRuntimeLaneStorage).mock.invocationCallOrder[0]
    );
    expect(ports.clearOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'team-a',
      laneId: 'primary',
      expectedRunId: 'run-primary',
    });
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

  it('records and propagates primary adapter rejection without clearing evidence or tracking', async () => {
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
    expect(ports.clearCalls).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(true);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(true);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(true);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.emittedEvents).toEqual([]);
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

  it('treats a resolved but unconfirmed primary stop as a failure and preserves tracking', async () => {
    const ports = makePorts({
      adapter: makeAdapter(
        vi.fn(async (input) => ({
          runId: input.runId,
          teamName: input.teamName,
          stopped: false,
          members: {},
          warnings: [],
          diagnostics: ['runtime remained alive'],
        }))
      ),
    });

    await expect(stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports)).rejects.toThrow(
      'runtime remained alive'
    );

    expect(ports.clearCalls).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(true);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(true);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(true);
    expect(ports.emittedEvents).toEqual([]);
  });

  it('does not clear primary storage for a newer owner registered during stop', async () => {
    const stop = vi.fn(async (input) => {
      ports.runtimeAdapterRunByTeam.set('team-a', {
        runId: 'run-B',
        providerId: 'opencode',
        cwd: '/runtime-cwd-b',
      });
      ports.provisioningRunByTeam.set('team-a', 'run-B');
      ports.aliveRunByTeam.set('team-a', 'run-B');
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const ports = makePorts({ adapter: makeAdapter(stop), previousLaunchState: snapshot() });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.clearCalls).toEqual([]);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-B');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-B');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-B');
  });

  it('does not stop an old primary when launch-state reading installs a new owner', async () => {
    const stop = vi.fn();
    const ports = makePorts({ adapter: makeAdapter(stop), previousLaunchState: snapshot() });
    vi.mocked(ports.readLaunchState).mockImplementation(async () => {
      ports.runtimeAdapterRunByTeam.set('team-a', {
        runId: 'run-B',
        providerId: 'opencode',
        cwd: '/runtime-cwd-b',
      });
      ports.provisioningRunByTeam.set('team-a', 'run-B');
      ports.aliveRunByTeam.set('team-a', 'run-B');
      return snapshot();
    });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(stop).not.toHaveBeenCalled();
    expect(ports.progressUpdates).toEqual([]);
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.clearCalls).toEqual([]);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.emittedEvents).toEqual([]);
    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toEqual({
      runId: 'run-B',
      providerId: 'opencode',
      cwd: '/runtime-cwd-b',
    });
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-B');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-B');
  });

  it('stops the exact old primary without clearing state owned by a newer alive run', async () => {
    const stop = vi.fn(async (input) => {
      ports.aliveRunByTeam.set('team-a', 'run-B');
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: true,
        members: {},
        warnings: [],
        diagnostics: [],
      };
    });
    const ports = makePorts({ adapter: makeAdapter(stop), previousLaunchState: snapshot() });

    await stopOpenCodeRuntimeAdapterTeam('team-a', 'run-primary', ports);

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-primary',
        laneId: 'primary',
        teamName: 'team-a',
      })
    );
    expect(ports.writeLaunchStateSnapshot).not.toHaveBeenCalled();
    expect(ports.clearCalls).toEqual([]);
    expect(ports.clearOpenCodeRuntimeToolApprovals).not.toHaveBeenCalled();
    expect(ports.invalidateRuntimeSnapshotCaches).not.toHaveBeenCalled();
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-primary');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-primary');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-B');
    expect(ports.deleteAliveRunId).not.toHaveBeenCalled();
    expect(ports.progressUpdates).toEqual([
      expect.objectContaining({
        runId: 'run-primary',
        state: 'disconnected',
        message: 'Stopping OpenCode team through runtime adapter',
      }),
    ]);
    expect(ports.emittedEvents).toEqual([]);
  });
});
