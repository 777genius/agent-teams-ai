import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeRuntimeStopFlowPorts,
  stopMixedSecondaryRuntimeLanes,
  stopOpenCodeRuntimeAdapterTeam,
} from '../TeamProvisioningOpenCodeRuntimeStopFlow';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { SecondaryRuntimeRunEntry } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchSnapshot, TeamProvisioningProgress } from '@shared/types';

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

function makePorts(input: {
  adapter?: TeamLaunchRuntimeAdapter | null;
  secondaryRuns?: SecondaryRuntimeRunEntry[];
  previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  nowIsoValues?: string[];
} = {}): OpenCodeRuntimeStopFlowPorts & {
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
    getSecondaryRuntimeRuns: vi.fn(
      () => input.secondaryRuns ?? defaultSecondaryRuns
    ),
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

describe('OpenCode runtime stop flow', () => {
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
    expect(ports.clearSecondaryRuntimeRuns).toHaveBeenCalledWith('team-a');
    expect(ports.deleteSecondaryRuntimeRun).not.toHaveBeenCalled();
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
    expect(ports.clearSecondaryRuntimeRuns).toHaveBeenCalledWith('team-a');
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop mixed OpenCode secondary lane lane-a: lane stop failed'
    );
    expect(ports.stoppingSecondaryRuntimeTeams.has('team-a')).toBe(false);
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
      adapter: makeAdapter(vi.fn(async () => {
        throw new Error('adapter stop exploded');
      })),
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
      adapter: makeAdapter(vi.fn(async () => {
        throw new Error('adapter stop failed');
      })),
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
});
