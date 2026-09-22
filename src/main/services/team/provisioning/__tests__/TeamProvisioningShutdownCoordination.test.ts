import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelPendingRuntimeAdapterLaunchesForShutdown,
  getShutdownTrackedTeamNames,
  killTransientProbeProcessesForShutdown,
  stopTrackedTeamsForShutdown,
  type TeamProvisioningShutdownCoordinationPorts,
  type TeamProvisioningShutdownCoordinationState,
  waitForInFlightTeamOperationsForShutdown,
} from '../TeamProvisioningShutdownCoordination';

import type { TeamProvisioningProgress } from '@shared/types';

interface ProbeProcess {
  id: string;
}

function makeProgress(
  runId: string,
  teamName: string,
  state: TeamProvisioningProgress['state'] = 'spawning'
): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state,
    message: 'Launching',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeState(
  overrides: Partial<TeamProvisioningShutdownCoordinationState<ProbeProcess>> = {}
): TeamProvisioningShutdownCoordinationState<ProbeProcess> {
  return {
    provisioningRunByTeam: new Map(),
    aliveRunByTeam: new Map(),
    runtimeAdapterRunByTeam: new Map(),
    secondaryRuntimeRunByTeam: new Map(),
    teamOpLocks: new Map(),
    runtimeAdapterProgressByRunId: new Map(),
    transientProbeProcesses: new Set(),
    ...overrides,
  };
}

function makePorts(
  overrides: Partial<TeamProvisioningShutdownCoordinationPorts<ProbeProcess>> = {}
): TeamProvisioningShutdownCoordinationPorts<ProbeProcess> {
  return {
    isCancellableRuntimeAdapterProgress: (progress) =>
      ['validating', 'spawning', 'configuring', 'assembling', 'finalizing', 'verifying'].includes(
        progress.state
      ),
    getOpenCodeAggregatePrimaryRestartTeamNames: () => [],
    getOpenCodeRuntimeAdapterStopInFlightTeamNames: () => [],
    stopTeam: vi.fn(),
    cancelRuntimeAdapterProvisioning: vi.fn(),
    killProcessTree: vi.fn(),
    logger: makeLogger(),
    ...overrides,
  };
}

describe('team provisioning shutdown coordination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects tracked team names from live state and pending runtime adapter launches', () => {
    const state = makeState({
      provisioningRunByTeam: new Map([
        ['provisioning-team', 'run-1'],
        ['shared-team', 'run-2'],
      ]),
      aliveRunByTeam: new Map([
        ['alive-team', 'run-3'],
        ['shared-team', 'run-2'],
      ]),
      runtimeAdapterRunByTeam: new Map([['runtime-team', { runId: 'run-4' }]]),
      secondaryRuntimeRunByTeam: new Map([['secondary-team', new Map()]]),
      teamOpLocks: new Map([['locked-team', Promise.resolve()]]),
      runtimeAdapterProgressByRunId: new Map([
        ['pending-run', makeProgress('pending-run', 'pending-team')],
        ['ready-run', makeProgress('ready-run', 'ready-team', 'ready')],
      ]),
    });

    expect(getShutdownTrackedTeamNames(state, makePorts())).toEqual([
      'provisioning-team',
      'shared-team',
      'alive-team',
      'runtime-team',
      'secondary-team',
      'locked-team',
      'pending-team',
    ]);
  });

  it('logs stop warnings while continuing best-effort shutdown stops', async () => {
    const logger = makeLogger();
    const stopTeam = vi.fn(async (teamName: string) => {
      if (teamName === 'team-a') {
        throw new Error('stop failed');
      }
    });
    const state = makeState({
      provisioningRunByTeam: new Map([
        ['team-a', 'run-a'],
        ['team-b', 'run-b'],
      ]),
    });

    await expect(
      stopTrackedTeamsForShutdown('Shutdown', state, makePorts({ logger, stopTeam }))
    ).resolves.toEqual(['team-a', 'team-b']);

    expect(stopTeam).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Shutdown: stopping tracked team processes: team-a, team-b'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[team-a] Failed to stop team during shutdown: stop failed'
    );
  });

  it('logs cancel warnings while continuing best-effort runtime adapter cancellation', async () => {
    const logger = makeLogger();
    const cancelRuntimeAdapterProvisioning = vi.fn(async (runId: string) => {
      if (runId === 'run-b') {
        throw new Error('cancel failed');
      }
    });
    const state = makeState({
      runtimeAdapterProgressByRunId: new Map([
        ['run-a', makeProgress('run-a', 'team-a')],
        ['run-b', makeProgress('run-b', 'team-b')],
        ['run-c', makeProgress('run-c', 'team-c', 'ready')],
      ]),
    });

    await cancelPendingRuntimeAdapterLaunchesForShutdown(
      state,
      makePorts({ cancelRuntimeAdapterProvisioning, logger })
    );

    expect(cancelRuntimeAdapterProvisioning).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Cancelling pending OpenCode runtime adapter launches on shutdown: team-a, team-b'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[team-b] Failed to cancel pending OpenCode runtime adapter launch on shutdown: cancel failed'
    );
  });

  it('unrefs the lock wait timeout and warns when in-flight operations do not settle', async () => {
    let timeoutHandler: () => void = () => {
      throw new Error('timeout handler not installed');
    };
    const timeoutRef = { unref: vi.fn() };
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number
    ) => {
      expect(timeout).toBe(42);
      timeoutHandler = typeof handler === 'function' ? (handler as () => void) : () => undefined;
      return timeoutRef as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const logger = makeLogger();
    const state = makeState({
      teamOpLocks: new Map([['team-a', new Promise<void>(() => undefined)]]),
    });

    const wait = waitForInFlightTeamOperationsForShutdown(state, makePorts({ logger }), 42);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutRef.unref).toHaveBeenCalledTimes(1);
    timeoutHandler();
    await wait;

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutRef);
    expect(logger.warn).toHaveBeenCalledWith(
      'Timed out after 42ms waiting for in-flight team operations during shutdown'
    );
  });

  it('kills transient probe processes best-effort and logs debug failures', () => {
    const logger = makeLogger();
    const firstChild = { id: 'first' };
    const secondChild = { id: 'second' };
    const killProcessTree = vi.fn((child: ProbeProcess) => {
      if (child === firstChild) {
        throw new Error('kill failed');
      }
    });

    killTransientProbeProcessesForShutdown(
      makeState({ transientProbeProcesses: new Set([firstChild, secondChild]) }),
      makePorts({ killProcessTree, logger })
    );

    expect(killProcessTree).toHaveBeenCalledTimes(2);
    expect(killProcessTree).toHaveBeenNthCalledWith(1, firstChild);
    expect(killProcessTree).toHaveBeenNthCalledWith(2, secondChild);
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to kill transient probe process during shutdown: kill failed'
    );
  });
});
