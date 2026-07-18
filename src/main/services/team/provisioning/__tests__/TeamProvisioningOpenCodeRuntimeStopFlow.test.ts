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
});
