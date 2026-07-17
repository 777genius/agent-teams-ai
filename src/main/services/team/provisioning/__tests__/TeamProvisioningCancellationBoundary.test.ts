import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningCancellationBoundary,
  createTeamProvisioningCancellationBoundaryPortsFromService,
  type TeamProvisioningCancellationBoundaryPorts,
  type TeamProvisioningCancellationBoundaryServiceHost,
  type TeamProvisioningCancellationRun,
} from '../TeamProvisioningCancellationBoundary';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { TeamChangeEvent, TeamProvisioningProgress } from '@shared/types';

interface TestRun extends TeamProvisioningCancellationRun {
  child: { killed?: boolean } | null;
}

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Spawning',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: progress(),
    cancelRequested: false,
    processKilled: false,
    child: {},
    onProgress: vi.fn(),
    ...overrides,
  };
}

function makeAdapter(): TeamLaunchRuntimeAdapter {
  return {
    providerId: 'opencode',
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    })),
  } as unknown as TeamLaunchRuntimeAdapter;
}

function makePorts(
  input: {
    run?: TestRun;
    runtimeProgress?: TeamProvisioningProgress;
    trackedRunId?: string | null;
    hasSecondaryRuntimeRuns?: boolean;
    adapter?: TeamLaunchRuntimeAdapter | null;
  } = {}
): TeamProvisioningCancellationBoundaryPorts<TestRun> & {
  cleanupRun: ReturnType<typeof vi.fn>;
  emittedEvents: TeamChangeEvent[];
  progressUpdates: TeamProvisioningProgress[];
  stopMixedSecondaryRuntimeLanes: ReturnType<typeof vi.fn>;
  stopOpenCodeRuntimeAdapterTeam: ReturnType<typeof vi.fn>;
} {
  const runs = new Map(input.run ? [[input.run.runId, input.run]] : []);
  const runtimeAdapterProgressByRunId = new Map(
    input.runtimeProgress ? [[input.runtimeProgress.runId, input.runtimeProgress]] : []
  );
  const emittedEvents: TeamChangeEvent[] = [];
  const progressUpdates: TeamProvisioningProgress[] = [];
  const aliveRunByTeam = new Map([['team-a', 'run-1']]);

  const ports = {
    runs,
    runtimeAdapterProgressByRunId,
    cancelledRuntimeAdapterRunIds: new Set<string>(),
    runtimeAdapterRunByTeam: new Map([
      [
        'team-a',
        {
          runId: 'run-1',
          providerId: 'opencode' as const,
          cwd: '/runtime-cwd',
        },
      ],
    ]),
    provisioningRunByTeam: new Map([['team-a', 'run-1']]),
    aliveRunByTeam,
    getTrackedRunId: vi.fn(() => input.trackedRunId ?? null),
    deleteAliveRunId: vi.fn((teamName: string) => {
      aliveRunByTeam.delete(teamName);
    }),
    hasSecondaryRuntimeRuns: vi.fn(() => input.hasSecondaryRuntimeRuns ?? false),
    stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
    stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
    killTeamProcess: vi.fn((child: TestRun['child']) => {
      if (child) {
        child.killed = true;
      }
    }),
    updateProgress: vi.fn((run: TestRun, state, message) => {
      const next = progress({ runId: run.runId, teamName: run.teamName, state, message });
      run.progress = next;
      return next;
    }),
    cleanupRun: vi.fn((run: TestRun) => {
      runs.delete(run.runId);
    }),
    nowIso: vi.fn(() => '2026-01-01T00:00:02.000Z'),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    setRuntimeAdapterProgress: vi.fn((nextProgress: TeamProvisioningProgress, onProgress) => {
      progressUpdates.push(nextProgress);
      onProgress?.(nextProgress);
      return nextProgress;
    }),
    emitTeamChange: vi.fn((event: TeamChangeEvent) => {
      emittedEvents.push(event);
    }),
    readLaunchState: vi.fn(async () => null),
    getOpenCodeRuntimeAdapter: vi.fn(() =>
      Object.prototype.hasOwnProperty.call(input, 'adapter') ? (input.adapter ?? null) : null
    ),
    readPersistedTeamProjectPath: vi.fn(() => '/persisted-cwd'),
    logWarning: vi.fn(),
    emittedEvents,
    progressUpdates,
  } satisfies TeamProvisioningCancellationBoundaryPorts<TestRun> & {
    emittedEvents: TeamChangeEvent[];
    progressUpdates: TeamProvisioningProgress[];
  };

  return ports;
}

describe('TeamProvisioningCancellationBoundary', () => {
  it('builds cancellation ports from service-shaped dependencies', async () => {
    const run = makeRun();
    const basePorts = makePorts({
      run,
      trackedRunId: run.runId,
      hasSecondaryRuntimeRuns: true,
    });
    const service = {
      runs: basePorts.runs,
      runtimeAdapterProgressByRunId: basePorts.runtimeAdapterProgressByRunId,
      cancelledRuntimeAdapterRunIds: basePorts.cancelledRuntimeAdapterRunIds,
      runtimeAdapterRunByTeam: basePorts.runtimeAdapterRunByTeam,
      provisioningRunByTeam: basePorts.provisioningRunByTeam,
      aliveRunByTeam: basePorts.aliveRunByTeam,
      runTracking: {
        getTrackedRunId: basePorts.getTrackedRunId,
        deleteAliveRunId: basePorts.deleteAliveRunId,
      },
      hasSecondaryRuntimeRuns: basePorts.hasSecondaryRuntimeRuns,
      stopMixedSecondaryRuntimeLanes: basePorts.stopMixedSecondaryRuntimeLanes,
      stopOpenCodeRuntimeAdapterTeam: basePorts.stopOpenCodeRuntimeAdapterTeam,
      cleanupRun: basePorts.cleanupRun,
      toolApprovalFacade: {
        clearOpenCodeRuntimeToolApprovals: basePorts.clearOpenCodeRuntimeToolApprovals,
      },
      invalidateRuntimeSnapshotCaches: basePorts.invalidateRuntimeSnapshotCaches,
      runtimeAdapterProgressState: {
        setRuntimeAdapterProgress: basePorts.setRuntimeAdapterProgress,
      },
      teamChangeEmitter: basePorts.emitTeamChange,
      launchStateStore: {
        read: basePorts.readLaunchState,
      },
      appShellBoundary: {
        getOpenCodeRuntimeAdapter: basePorts.getOpenCodeRuntimeAdapter,
      },
      readPersistedTeamProjectPath: basePorts.readPersistedTeamProjectPath,
    } satisfies TeamProvisioningCancellationBoundaryServiceHost<TestRun>;

    const boundary = createTeamProvisioningCancellationBoundary(
      createTeamProvisioningCancellationBoundaryPortsFromService(service, {
        killTeamProcess: basePorts.killTeamProcess,
        updateProgress: basePorts.updateProgress,
        nowIso: basePorts.nowIso,
        logWarning: basePorts.logWarning,
      })
    );

    await boundary.cancelProvisioning(run.runId);

    expect(run.cancelRequested).toBe(true);
    expect(basePorts.killTeamProcess).toHaveBeenCalledWith(run.child);
    expect(basePorts.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(run.teamName);
    // The tracked primary lane is an owned OpenCode adapter run — cancelling must stop it too,
    // otherwise the adapter-managed primary runtime process is orphaned (run.child is null for
    // a pure-OpenCode aggregate run, so killTeamProcess alone does not cover it).
    expect(basePorts.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(run.teamName, run.runId);
    expect(basePorts.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('cancels an active direct provisioning run and leaves cleanup behind the ports', async () => {
    const run = makeRun();
    const ports = makePorts({
      run,
      trackedRunId: run.runId,
      hasSecondaryRuntimeRuns: true,
    });
    const boundary = createTeamProvisioningCancellationBoundary(ports);

    await boundary.cancelProvisioning(run.runId);

    expect(run.cancelRequested).toBe(true);
    expect(run.processKilled).toBe(true);
    expect(run.child?.killed).toBe(true);
    expect(ports.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(run.teamName);
    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        teamName: run.teamName,
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      })
    );
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('rejects direct run cancellation after the provisioning window closes', async () => {
    const run = makeRun({ progress: progress({ state: 'ready' }) });
    const ports = makePorts({ run });
    const boundary = createTeamProvisioningCancellationBoundary(ports);

    await expect(boundary.cancelProvisioning(run.runId)).rejects.toThrow(
      'Provisioning cannot be cancelled in current state'
    );

    expect(run.cancelRequested).toBe(false);
    expect(ports.cleanupRun).not.toHaveBeenCalled();
  });

  it('routes runtime-adapter-only cancellation through the runtime cancellation port', async () => {
    const adapter = makeAdapter();
    const ports = makePorts({
      runtimeProgress: progress(),
      adapter,
    });
    const boundary = createTeamProvisioningCancellationBoundary(ports);

    await boundary.cancelProvisioning('run-1');

    expect(ports.cancelledRuntimeAdapterRunIds.has('run-1')).toBe(true);
    expect(ports.progressUpdates).toMatchObject([
      {
        runId: 'run-1',
        teamName: 'team-a',
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
      },
    ]);
    expect(adapter.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'primary',
        reason: 'user_requested',
      })
    );
  });
});
