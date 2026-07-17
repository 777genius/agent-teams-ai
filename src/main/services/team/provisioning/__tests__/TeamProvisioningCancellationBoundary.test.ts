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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function makePorts(
  input: {
    run?: TestRun;
    runtimeProgress?: TeamProvisioningProgress;
    trackedRunId?: string | null;
    hasSecondaryRuntimeRuns?: boolean;
    adapter?: TeamLaunchRuntimeAdapter | null;
    runtimeAdapterRunId?: string | null;
    provisioningRunId?: string | null;
    aliveRunId?: string | null;
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
  const runtimeAdapterRunId = Object.prototype.hasOwnProperty.call(input, 'runtimeAdapterRunId')
    ? input.runtimeAdapterRunId
    : 'run-1';
  const provisioningRunId = Object.prototype.hasOwnProperty.call(input, 'provisioningRunId')
    ? input.provisioningRunId
    : 'run-1';
  const aliveRunId = Object.prototype.hasOwnProperty.call(input, 'aliveRunId')
    ? input.aliveRunId
    : 'run-1';
  const runtimeAdapterRunByTeam: TeamProvisioningCancellationBoundaryPorts<TestRun>['runtimeAdapterRunByTeam'] =
    new Map();
  if (runtimeAdapterRunId !== null && runtimeAdapterRunId !== undefined) {
    runtimeAdapterRunByTeam.set('team-a', {
      runId: runtimeAdapterRunId,
      providerId: 'opencode' as const,
      cwd: '/runtime-cwd',
    });
  }
  const provisioningRunByTeam = new Map<string, string>();
  if (provisioningRunId !== null && provisioningRunId !== undefined) {
    provisioningRunByTeam.set('team-a', provisioningRunId);
  }
  const aliveRunByTeam = new Map<string, string>();
  if (aliveRunId !== null && aliveRunId !== undefined) {
    aliveRunByTeam.set('team-a', aliveRunId);
  }

  const ports = {
    runs,
    runtimeAdapterProgressByRunId,
    cancelledRuntimeAdapterRunIds: new Set<string>(),
    runtimeAdapterRunByTeam,
    provisioningRunByTeam,
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

  it('cancels a validating direct run and rolls back its owned runtime resources', async () => {
    const run = makeRun({
      progress: progress({ state: 'validating', message: 'Validating' }),
    });
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
    expect(ports.killTeamProcess).toHaveBeenCalledWith(run.child);
    expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(run.teamName, run.runId);
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
    expect(ports.runs.has(run.runId)).toBe(false);
  });

  it.each([
    ['exact', 'run-1'],
    ['absent', null],
  ] as const)(
    'stops the exact primary but not secondaries without tracking when provisioning is %s',
    async (_provisioningState, provisioningRunId) => {
      const run = makeRun();
      const ports = makePorts({
        run,
        trackedRunId: null,
        runtimeAdapterRunId: run.runId,
        provisioningRunId,
        aliveRunId: null,
        hasSecondaryRuntimeRuns: true,
      });
      const boundary = createTeamProvisioningCancellationBoundary(ports);

      await boundary.cancelProvisioning(run.runId);

      expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(run.teamName, run.runId);
      expect(ports.stopMixedSecondaryRuntimeLanes).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['provisioning', 'run-1', null],
    ['alive', null, 'run-1'],
  ] as const)(
    'does not stop runtime lanes for an exact %s owner without an exact primary runtime entry',
    async (_owner, provisioningRunId, aliveRunId) => {
      const run = makeRun();
      const ports = makePorts({
        run,
        trackedRunId: null,
        runtimeAdapterRunId: null,
        provisioningRunId,
        aliveRunId,
        hasSecondaryRuntimeRuns: true,
      });
      const boundary = createTeamProvisioningCancellationBoundary(ports);

      await boundary.cancelProvisioning(run.runId);

      expect(ports.stopOpenCodeRuntimeAdapterTeam).not.toHaveBeenCalled();
      expect(ports.stopMixedSecondaryRuntimeLanes).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['absent', null, null, null, false],
    ['exact', 'run-1', 'run-1', 'run-1', true],
  ] as const)(
    'stops secondaries for exact tracking when the other ownership maps are %s',
    async (_ownerState, provisioningRunId, aliveRunId, runtimeAdapterRunId, stopsPrimary) => {
      const run = makeRun();
      const ports = makePorts({
        run,
        trackedRunId: run.runId,
        runtimeAdapterRunId,
        provisioningRunId,
        aliveRunId,
        hasSecondaryRuntimeRuns: true,
      });
      const boundary = createTeamProvisioningCancellationBoundary(ports);

      await boundary.cancelProvisioning(run.runId);

      expect(ports.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(run.teamName);
      if (stopsPrimary) {
        expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(run.teamName, run.runId);
      } else {
        expect(ports.stopOpenCodeRuntimeAdapterTeam).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['tracked', 'newer-run', 'run-1', 'run-1', 'run-1'],
    ['provisioning', 'run-1', 'newer-run', 'run-1', 'run-1'],
    ['alive', 'run-1', 'run-1', 'newer-run', 'run-1'],
    ['runtime adapter', 'run-1', 'run-1', 'run-1', 'newer-run'],
  ] as const)(
    'does not stop either lane when the %s ownership map belongs to a newer run',
    async (_conflictingOwner, trackedRunId, provisioningRunId, aliveRunId, runtimeAdapterRunId) => {
      const run = makeRun();
      const ports = makePorts({
        run,
        trackedRunId,
        runtimeAdapterRunId,
        provisioningRunId,
        aliveRunId,
        hasSecondaryRuntimeRuns: true,
      });
      const boundary = createTeamProvisioningCancellationBoundary(ports);

      await boundary.cancelProvisioning(run.runId);

      expect(ports.stopOpenCodeRuntimeAdapterTeam).not.toHaveBeenCalled();
      expect(ports.stopMixedSecondaryRuntimeLanes).not.toHaveBeenCalled();
    }
  );

  it('awaits every owned runtime lane stop before cancelled progress and cleanup', async () => {
    const primaryStop = createDeferred<void>();
    const secondaryStops = createDeferred<void>();
    const events: string[] = [];
    const run = makeRun({
      onProgress: vi.fn(() => {
        events.push('cancelled progress');
      }),
    });
    const ports = makePorts({
      run,
      trackedRunId: run.runId,
      hasSecondaryRuntimeRuns: true,
    });
    ports.stopOpenCodeRuntimeAdapterTeam.mockImplementation(async () => {
      await primaryStop.promise;
      events.push('primary stopped');
    });
    ports.stopMixedSecondaryRuntimeLanes.mockImplementation(async () => {
      await secondaryStops.promise;
      events.push('secondaries stopped');
    });
    ports.cleanupRun.mockImplementation(() => {
      events.push('cleanup');
    });
    const boundary = createTeamProvisioningCancellationBoundary(ports);

    const cancellation = boundary.cancelProvisioning(run.runId);

    expect(ports.stopOpenCodeRuntimeAdapterTeam).toHaveBeenCalledWith(run.teamName, run.runId);
    expect(ports.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith(run.teamName);
    expect(events).toEqual([]);

    secondaryStops.resolve();
    await secondaryStops.promise;
    await Promise.resolve();

    expect(events).toEqual(['secondaries stopped']);
    expect(ports.updateProgress).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    primaryStop.resolve();
    await cancellation;

    expect(events).toEqual([
      'secondaries stopped',
      'primary stopped',
      'cancelled progress',
      'cleanup',
    ]);
  });

  it('awaits remaining stops and performs required cleanup before rejecting a stop failure', async () => {
    const primaryStop = createDeferred<void>();
    const secondaryStops = createDeferred<void>();
    const events: string[] = [];
    const run = makeRun({
      onProgress: vi.fn(() => {
        events.push('cancelled progress');
      }),
    });
    const ports = makePorts({
      run,
      trackedRunId: run.runId,
      hasSecondaryRuntimeRuns: true,
    });
    ports.stopOpenCodeRuntimeAdapterTeam.mockImplementation(async () => {
      try {
        await primaryStop.promise;
      } catch (error) {
        events.push('primary stop failed');
        throw error;
      }
    });
    ports.stopMixedSecondaryRuntimeLanes.mockImplementation(async () => {
      await secondaryStops.promise;
      events.push('secondaries stopped');
    });
    ports.cleanupRun.mockImplementation(() => {
      events.push('cleanup');
    });
    const boundary = createTeamProvisioningCancellationBoundary(ports);
    let cancellationSettled = false;
    const cancellation = boundary.cancelProvisioning(run.runId).then(
      () => {
        cancellationSettled = true;
        return { status: 'fulfilled' as const };
      },
      (error: unknown) => {
        cancellationSettled = true;
        events.push('cancellation rejected');
        return { status: 'rejected' as const, error };
      }
    );

    primaryStop.reject(new Error('primary stop failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['primary stop failed']);
    expect(cancellationSettled).toBe(false);
    expect(ports.updateProgress).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    secondaryStops.resolve();
    const result = await cancellation;

    expect(result).toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'primary stop failed' }),
    });
    expect(events).toEqual([
      'primary stop failed',
      'secondaries stopped',
      'cancelled progress',
      'cleanup',
      'cancellation rejected',
    ]);
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });

  it.each(['ready', 'disconnected', 'failed', 'cancelled'] as const)(
    'rejects direct run cancellation in the %s state',
    async (state) => {
      const run = makeRun({ progress: progress({ state }) });
      const ports = makePorts({
        run,
        trackedRunId: run.runId,
        hasSecondaryRuntimeRuns: true,
      });
      const boundary = createTeamProvisioningCancellationBoundary(ports);

      await expect(boundary.cancelProvisioning(run.runId)).rejects.toThrow(
        'Provisioning cannot be cancelled in current state'
      );

      expect(run.cancelRequested).toBe(false);
      expect(run.processKilled).toBe(false);
      expect(ports.killTeamProcess).not.toHaveBeenCalled();
      expect(ports.stopOpenCodeRuntimeAdapterTeam).not.toHaveBeenCalled();
      expect(ports.stopMixedSecondaryRuntimeLanes).not.toHaveBeenCalled();
      expect(run.onProgress).not.toHaveBeenCalled();
      expect(ports.cleanupRun).not.toHaveBeenCalled();
      expect(ports.runs.get(run.runId)).toBe(run);
    }
  );

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
