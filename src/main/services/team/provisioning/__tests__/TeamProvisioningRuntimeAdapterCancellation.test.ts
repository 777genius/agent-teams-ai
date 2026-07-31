import { describe, expect, it, vi } from 'vitest';

import {
  buildCancelledOpenCodeRuntimeAdapterLaunchProgress,
  cancelRuntimeAdapterProvisioning,
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned,
  isCancellableRuntimeAdapterProgress,
  ownsOpenCodeRuntimeAdapterPrimaryLane,
  recordCancelledOpenCodeRuntimeAdapterLaunch,
  type RuntimeAdapterCancellationPorts,
  stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned,
} from '../TeamProvisioningRuntimeAdapterCancellation';
import { TeamProvisioningRunTrackingDeliveryHelper } from '../TeamProvisioningRunTrackingDelivery';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
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

function progress(overrides: Partial<TeamProvisioningProgress> = {}): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Launching runtime',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function snapshot(): PersistedTeamLaunchSnapshot {
  return {
    teamName: 'team-a',
    launchPhase: 'active',
    teamLaunchState: 'running',
    members: {},
    summary: {
      totalMembers: 0,
      runningMembers: 0,
      failedMembers: 0,
      pendingMembers: 0,
      completedMembers: 0,
    },
    updatedAt: '2026-01-01T00:00:02.000Z',
  } as unknown as PersistedTeamLaunchSnapshot;
}

function adapter(stop: TeamLaunchRuntimeAdapter['stop']): TeamLaunchRuntimeAdapter {
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
    readLaunchState?: () => Promise<PersistedTeamLaunchSnapshot | null>;
    clearLane?: RuntimeAdapterCancellationPorts['clearOpenCodeRuntimeLaneStorage'];
    nowIso?: () => string;
  } = {}
): RuntimeAdapterCancellationPorts & {
  aliveRunByTeam: Map<string, string>;
  events: string[];
  progressUpdates: TeamProvisioningProgress[];
  emittedEvents: TeamChangeEvent[];
  warnings: string[];
  onProgressCalls: TeamProvisioningProgress[];
} {
  const events: string[] = [];
  const progressUpdates: TeamProvisioningProgress[] = [];
  const emittedEvents: TeamChangeEvent[] = [];
  const warnings: string[] = [];
  const onProgressCalls: TeamProvisioningProgress[] = [];
  const aliveRunByTeam = new Map([['team-a', 'run-1']]);
  const runtimeAdapterRunByTeam = new Map([
    [
      'team-a',
      {
        runId: 'run-1',
        providerId: 'opencode' as const,
        cwd: '/runtime-cwd',
      },
    ],
  ]);
  const provisioningRunByTeam = new Map([['team-a', 'run-1']]);
  const runtimeAdapterProgressByRunId = new Map([['run-1', progress()]]);

  return {
    cancelledRuntimeAdapterRunIds: new Set<string>(),
    runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId,
    provisioningRunByTeam,
    aliveRunByTeam,
    teamsBasePath: '/teams',
    nowIso: input.nowIso ?? vi.fn(() => '2026-01-01T00:00:03.000Z'),
    clearOpenCodeRuntimeToolApprovals: vi.fn(() => {
      events.push('clear-approvals');
    }),
    deleteAliveRunId: vi.fn((teamName) => {
      events.push('delete-alive');
      aliveRunByTeam.delete(teamName);
    }),
    invalidateRuntimeSnapshotCaches: vi.fn(() => {
      events.push('invalidate');
    }),
    setRuntimeAdapterProgress: vi.fn((nextProgress, onProgress) => {
      events.push('set-progress');
      runtimeAdapterProgressByRunId.set(nextProgress.runId, nextProgress);
      progressUpdates.push(nextProgress);
      onProgress?.(nextProgress);
      if (onProgress) {
        onProgressCalls.push(nextProgress);
      }
      return nextProgress;
    }),
    emitTeamChange: vi.fn((event) => {
      events.push('emit-change');
      emittedEvents.push(event);
    }),
    readLaunchState: vi.fn(async () => {
      events.push('read-launch-state');
      return input.readLaunchState ? input.readLaunchState() : snapshot();
    }),
    getOpenCodeRuntimeAdapter: vi.fn(() => {
      events.push('get-adapter');
      return Object.prototype.hasOwnProperty.call(input, 'adapter')
        ? (input.adapter ?? null)
        : adapter(
            vi.fn(async (stopInput) => {
              events.push(`adapter-stop:${stopInput.cwd ?? ''}`);
              return {
                runId: stopInput.runId,
                teamName: stopInput.teamName,
                stopped: true,
                members: {},
                warnings: [],
                diagnostics: [],
              };
            })
          );
    }),
    readPersistedTeamProjectPath: vi.fn(() => {
      events.push('read-persisted-cwd');
      return '/persisted-cwd';
    }),
    clearOpenCodeRuntimeLaneStorage:
      input.clearLane ??
      vi.fn(async () => {
        events.push('clear-lane');
        return true;
      }),
    logWarning: vi.fn((message) => {
      warnings.push(message);
    }),
    events,
    progressUpdates,
    emittedEvents,
    warnings,
    onProgressCalls,
  };
}

describe('TeamProvisioningRuntimeAdapterCancellation', () => {
  it('identifies only active runtime adapter provisioning states as cancellable', () => {
    expect(
      ['validating', 'spawning', 'configuring', 'assembling', 'finalizing', 'verifying'].every(
        (state) =>
          isCancellableRuntimeAdapterProgress({
            state: state as TeamProvisioningProgress['state'],
          })
      )
    ).toBe(true);
    expect(isCancellableRuntimeAdapterProgress({ state: 'cancelled' })).toBe(false);
    expect(isCancellableRuntimeAdapterProgress({ state: 'ready' })).toBe(false);
  });

  it('clears exact runtime ownership only after cancellation stop is confirmed', async () => {
    const ports = makePorts();

    await cancelRuntimeAdapterProvisioning({
      runId: 'run-1',
      runtimeProgress: progress(),
      ports,
    });

    expect(ports.cancelledRuntimeAdapterRunIds.has('run-1')).toBe(true);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.provisioningRunByTeam.has('team-a')).toBe(false);
    expect(ports.aliveRunByTeam.has('team-a')).toBe(false);
    expect(ports.progressUpdates).toMatchObject([
      {
        runId: 'run-1',
        teamName: 'team-a',
        state: 'cancelled',
        message: 'Provisioning cancellation requested; stopping OpenCode runtime',
        updatedAt: '2026-01-01T00:00:03.000Z',
      },
      {
        runId: 'run-1',
        teamName: 'team-a',
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
        updatedAt: '2026-01-01T00:00:03.000Z',
      },
    ]);
    expect(ports.emittedEvents).toEqual([
      {
        type: 'process',
        teamName: 'team-a',
        runId: 'run-1',
        detail: 'cancelled',
      },
    ]);
    expect(ports.events).toEqual([
      'set-progress',
      'invalidate',
      'read-launch-state',
      'get-adapter',
      'adapter-stop:/runtime-cwd',
      'clear-approvals',
      'clear-lane',
      'delete-alive',
      'invalidate',
      'set-progress',
      'emit-change',
    ]);
  });

  it('falls back to the persisted project path when the runtime run has no cwd', async () => {
    const ports = makePorts();
    ports.runtimeAdapterRunByTeam.set('team-a', {
      runId: 'run-1',
      providerId: 'opencode',
    });

    await cancelRuntimeAdapterProvisioning({
      runId: 'run-1',
      runtimeProgress: progress(),
      ports,
    });

    expect(ports.events).toContain('read-persisted-cwd');
    expect(ports.events).toContain('adapter-stop:/persisted-cwd');
  });

  it('throws before mutating state when runtime adapter progress is not cancellable', async () => {
    const ports = makePorts();

    await expect(
      cancelRuntimeAdapterProvisioning({
        runId: 'run-1',
        runtimeProgress: progress({ state: 'ready' }),
        ports,
      })
    ).rejects.toThrow('Provisioning cannot be cancelled in current state');

    expect(ports.cancelledRuntimeAdapterRunIds.size).toBe(0);
    expect(ports.events).toEqual([]);
  });

  it('logs stop failures and retains primary ownership and storage', async () => {
    const ports = makePorts({
      adapter: adapter(
        vi.fn(async () => {
          throw new Error('stop failed');
        })
      ),
    });

    await expect(
      cancelRuntimeAdapterProvisioning({
        runId: 'run-1',
        runtimeProgress: progress(),
        ports,
      })
    ).rejects.toThrow('did not confirm stop during cancellation');

    expect(ports.warnings).toEqual([
      '[team-a] Failed to stop OpenCode runtime adapter launch during cancel: stop failed',
    ]);
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-1');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.events).not.toContain('clear-lane');
    expect(ports.events).not.toContain('clear-approvals');
    expect(ports.events).not.toContain('delete-alive');
    expect(ports.progressUpdates.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Provisioning cancellation could not stop the OpenCode runtime',
    });
  });

  it('retains primary ownership and storage when cancellation stop is not confirmed', async () => {
    const ports = makePorts({
      adapter: adapter(
        vi.fn(async (stopInput) => ({
          runId: stopInput.runId,
          teamName: stopInput.teamName,
          stopped: false,
          members: {},
          warnings: ['runtime still active'],
          diagnostics: [],
        }))
      ),
    });

    await expect(
      cancelRuntimeAdapterProvisioning({
        runId: 'run-1',
        runtimeProgress: progress(),
        ports,
      })
    ).rejects.toThrow('did not confirm stop during cancellation');

    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-1');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.events).not.toContain('clear-lane');
    expect(ports.warnings).toEqual([
      '[team-a] Failed to stop OpenCode runtime adapter launch during cancel: OpenCode runtime adapter launch did not confirm stop: runtime still active',
    ]);
  });

  it('publishes a truthful non-deliverable cancellation state while primary stop is pending', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const ports = makePorts({
      adapter: adapter(
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

    const cancelling = cancelRuntimeAdapterProvisioning({
      runId: 'run-1',
      runtimeProgress: progress(),
      ports,
    });
    await stopStarted.promise;

    expect(ports.progressUpdates).toHaveLength(1);
    expect(ports.progressUpdates[0]).toMatchObject({
      runId: 'run-1',
      teamName: 'team-a',
      state: 'cancelled',
      message: 'Provisioning cancellation requested; stopping OpenCode runtime',
    });
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-1');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.events).not.toContain('clear-lane');
    expect(ports.events).not.toContain('delete-alive');

    stopRelease.resolve();
    await cancelling;
  });

  it('publishes exact late-launch ownership and a non-deliverable fence before adapter stop', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const ports = makePorts({
      adapter: adapter(
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
    ports.runtimeAdapterRunByTeam.delete('team-a');
    ports.provisioningRunByTeam.delete('team-a');
    ports.aliveRunByTeam.delete('team-a');
    const helper = new TeamProvisioningRunTrackingDeliveryHelper({
      state: {
        provisioningRunByTeam: ports.provisioningRunByTeam,
        aliveRunByTeam: ports.aliveRunByTeam,
        runs: new Map(),
        runtimeAdapterProgressByRunId: ports.runtimeAdapterProgressByRunId!,
        runtimeAdapterRunByTeam: ports.runtimeAdapterRunByTeam,
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

    const stopping = stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
      teamName: 'team-a',
      runId: 'run-1',
      ports,
    });
    await stopStarted.promise;

    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toEqual({
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/persisted-cwd',
    });
    expect(ports.runtimeAdapterProgressByRunId?.get('run-1')).toMatchObject({
      state: 'disconnected',
      message: 'Stopping cancelled OpenCode runtime launch',
    });
    expect(helper.canDeliverToTrackedRuntimeRun('team-a', 'run-1')).toBe(false);
    expect(helper.resolveDeliverableTrackedRuntimeRunId('team-a')).toBeNull();
    expect(helper.canDeliverToOpenCodeRuntimeForTeam('team-a')).toBe(false);

    stopRelease.resolve();
    await expect(stopping).resolves.toBe(true);
    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
  });

  it('rolls failed late cancelled-launch stop state back to the exact prior state', async () => {
    const ports = makePorts({
      adapter: adapter(
        vi.fn(async (stopInput) => ({
          runId: stopInput.runId,
          teamName: stopInput.teamName,
          stopped: false,
          members: {},
          warnings: ['late runtime still active'],
          diagnostics: [],
        }))
      ),
    });
    ports.runtimeAdapterRunByTeam.delete('team-a');
    ports.provisioningRunByTeam.delete('team-a');
    ports.aliveRunByTeam.delete('team-a');
    const previousProgress = ports.runtimeAdapterProgressByRunId?.get('run-1');

    await expect(
      stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
        teamName: 'team-a',
        runId: 'run-1',
        ports,
      })
    ).resolves.toBe(false);

    expect(ports.runtimeAdapterRunByTeam.has('team-a')).toBe(false);
    expect(ports.runtimeAdapterProgressByRunId?.get('run-1')).toBe(previousProgress);
    expect(ports.events).not.toContain('clear-lane');
    expect(ports.events).not.toContain('clear-approvals');
    expect(ports.warnings).toEqual([
      '[team-a] Failed to stop OpenCode runtime adapter launch before primary lane cleanup: OpenCode runtime adapter launch did not confirm stop: late runtime still active',
    ]);
  });

  it('does not roll a newer late-launch owner back after stop failure', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const ports = makePorts({
      adapter: adapter(
        vi.fn(async (stopInput) => {
          stopStarted.resolve();
          await stopRelease.promise;
          return {
            runId: stopInput.runId,
            teamName: stopInput.teamName,
            stopped: false,
            members: {},
            warnings: ['old runtime still active'],
            diagnostics: [],
          };
        })
      ),
    });
    ports.runtimeAdapterRunByTeam.delete('team-a');
    ports.provisioningRunByTeam.delete('team-a');
    ports.aliveRunByTeam.delete('team-a');

    const stopping = stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
      teamName: 'team-a',
      runId: 'run-1',
      ports,
    });
    await stopStarted.promise;

    const newerOwner = {
      runId: 'run-new',
      providerId: 'opencode' as const,
      cwd: '/new-runtime-cwd',
    };
    ports.runtimeAdapterRunByTeam.set('team-a', newerOwner);
    ports.provisioningRunByTeam.set('team-a', 'run-new');
    ports.aliveRunByTeam.set('team-a', 'run-new');
    stopRelease.resolve();
    await expect(stopping).resolves.toBe(false);

    expect(ports.runtimeAdapterRunByTeam.get('team-a')).toBe(newerOwner);
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-new');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-new');
  });

  it('retains ownership when primary lane storage cleanup fails after confirmed stop', async () => {
    const storageError = new Error('storage cleanup failed');
    const ports = makePorts({
      clearLane: vi.fn(async () => {
        throw storageError;
      }),
    });

    await expect(
      clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
        teamName: 'team-a',
        runId: 'run-1',
        ports,
      })
    ).rejects.toBe(storageError);

    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-1');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.events).not.toContain('delete-alive');
  });

  it('does not clear a newer primary owner installed while adapter stop is awaiting', async () => {
    const stopStarted = createDeferred<void>();
    const stopRelease = createDeferred<void>();
    const clearLane = vi.fn(async () => true);
    const ports = makePorts({
      adapter: adapter(
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
      clearLane,
    });

    const cancelling = cancelRuntimeAdapterProvisioning({
      runId: 'run-1',
      runtimeProgress: progress(),
      ports,
    });
    await stopStarted.promise;

    ports.runtimeAdapterRunByTeam.set('team-a', {
      runId: 'run-new',
      providerId: 'opencode',
    });
    ports.provisioningRunByTeam.set('team-a', 'run-new');
    ports.aliveRunByTeam.set('team-a', 'run-new');
    stopRelease.resolve();
    await cancelling;

    expect(clearLane).not.toHaveBeenCalled();
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-new');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-new');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-new');
    expect(ports.events.filter((event) => event === 'delete-alive')).toHaveLength(0);
  });

  it('detects primary lane ownership only when every installed owner is exact', () => {
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: 'run-1',
        currentAliveRunId: undefined,
        currentRuntimeRun: undefined,
        runId: 'run-1',
      })
    ).toBe(true);
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: undefined,
        currentAliveRunId: 'run-1',
        currentRuntimeRun: undefined,
        runId: 'run-1',
      })
    ).toBe(true);
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: undefined,
        currentAliveRunId: undefined,
        currentRuntimeRun: { runId: 'run-1', providerId: 'opencode' },
        runId: 'run-1',
      })
    ).toBe(true);
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: undefined,
        currentAliveRunId: undefined,
        currentRuntimeRun: undefined,
        runId: 'run-1',
      })
    ).toBe(false);
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: 'other-run',
        currentAliveRunId: undefined,
        currentRuntimeRun: undefined,
        runId: 'run-1',
      })
    ).toBe(false);
    expect(
      ownsOpenCodeRuntimeAdapterPrimaryLane({
        currentProvisioningRunId: 'run-1',
        currentAliveRunId: 'other-run',
        currentRuntimeRun: { runId: 'run-1', providerId: 'opencode' },
        runId: 'run-1',
      })
    ).toBe(false);
  });

  it('clears primary lane ownership only when the run still owns tracked entries', async () => {
    const ports = makePorts({
      clearLane: vi.fn(async () => {
        ports.events.push('clear-lane');
        ports.runtimeAdapterRunByTeam.set('team-a', {
          runId: 'new-run',
          providerId: 'opencode',
        });
        ports.provisioningRunByTeam.set('team-a', 'new-run');
        ports.aliveRunByTeam.set('team-a', 'new-run');
        return true;
      }),
    });

    await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
      teamName: 'team-a',
      runId: 'run-1',
      ports,
    });

    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('new-run');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('new-run');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('new-run');
    expect(ports.events).toEqual(['clear-lane', 'invalidate']);
  });

  it('skips primary lane cleanup when another run owns the lane', async () => {
    const ports = makePorts();
    ports.runtimeAdapterRunByTeam.set('team-a', {
      runId: 'other-run',
      providerId: 'opencode',
    });
    ports.provisioningRunByTeam.set('team-a', 'other-run');
    ports.aliveRunByTeam.set('team-a', 'other-run');

    await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
      teamName: 'team-a',
      runId: 'run-1',
      ports,
    });

    expect(ports.events).toEqual([]);
  });

  it('builds and records cancelled runtime adapter launch progress', () => {
    expect(
      buildCancelledOpenCodeRuntimeAdapterLaunchProgress({
        runId: 'cancelled-run',
        teamName: 'team-a',
        timestamp: '2026-01-01T00:00:04.000Z',
        sourceWarning: 'previous launch cancelled',
      })
    ).toEqual({
      runId: 'cancelled-run',
      teamName: 'team-a',
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
      startedAt: '2026-01-01T00:00:04.000Z',
      updatedAt: '2026-01-01T00:00:04.000Z',
      warnings: ['previous launch cancelled'],
    });

    const ports = makePorts({ nowIso: () => '2026-01-01T00:00:05.000Z' });
    const onProgress = vi.fn();

    const response = recordCancelledOpenCodeRuntimeAdapterLaunch({
      teamName: 'team-a',
      sourceWarning: undefined,
      onProgress,
      createRunId: () => 'cancelled-run',
      ports,
    });

    expect(response).toEqual({ runId: 'cancelled-run' });
    expect(ports.runtimeAdapterRunByTeam.get('team-a')?.runId).toBe('run-1');
    expect(ports.provisioningRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(ports.progressUpdates).toEqual([
      {
        runId: 'cancelled-run',
        teamName: 'team-a',
        state: 'cancelled',
        message: 'Provisioning cancelled by user',
        startedAt: '2026-01-01T00:00:05.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
        warnings: undefined,
      },
    ]);
    expect(onProgress).toHaveBeenCalledWith(ports.progressUpdates[0]);
    expect(ports.events).toEqual(['set-progress', 'emit-change']);
  });
});
