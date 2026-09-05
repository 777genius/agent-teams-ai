import {
  countLiveRecordedRuntimeHostsForTeam,
  RUNTIME_HOSTS_POLL_INTERVAL_MS,
  runTeamForceStopFlow,
  STOP_ESCALATION_TIMEOUT_MS,
  stopTeamWithEscalation,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';
import type { TeamLaunchStateReadResult } from '@main/services/team/TeamLaunchStateStore';

function createPorts(overrides: Partial<TeamForceStopFlowPorts> = {}): {
  [K in keyof TeamForceStopFlowPorts]: TeamForceStopFlowPorts[K];
} & {
  stopTeam: ReturnType<typeof vi.fn>;
  observeOwnedRuntimeRunIds: ReturnType<typeof vi.fn>;
  killRetainedRuntimeProcesses: ReturnType<typeof vi.fn>;
  clearPendingPromptDeliveries: ReturnType<typeof vi.fn>;
  logWarning: ReturnType<typeof vi.fn>;
} {
  return {
    stopTeam: vi.fn(() => Promise.resolve()),
    observeOwnedRuntimeRunIds: vi.fn(() => Promise.resolve(['run-a'])),
    killRetainedRuntimeProcesses: vi.fn(() =>
      Promise.resolve({ killedPids: [4242], diagnostics: ['Killed persisted runtime pid=4242'] })
    ),
    clearPendingPromptDeliveries: vi.fn(() =>
      Promise.resolve({
        cleared: 2,
        diagnostics: ['Cancelled 2 pending prompt delivery record(s)'],
      })
    ),
    logWarning: vi.fn(),
    stopTimeoutMs: 20,
    ...overrides,
  } as never;
}

/** A launch state that recorded one OpenCode host pid per lane. */
function recordedSnapshot(pids: Record<string, number | undefined>): TeamLaunchStateReadResult {
  return {
    status: 'snapshot',
    snapshot: {
      members: Object.fromEntries(
        Object.entries(pids).map(([laneId, runtimePid]) => [
          laneId,
          { name: laneId, providerId: 'opencode', laneId, runtimePid },
        ])
      ),
    } as unknown as PersistedTeamLaunchSnapshot,
  };
}

/** A launch-state store that answers every read with the same result. */
function launchStateStore(result: TeamLaunchStateReadResult): {
  readResult: () => Promise<TeamLaunchStateReadResult>;
} {
  return { readResult: () => Promise.resolve(result) };
}

describe('runTeamForceStopFlow', () => {
  it('completes confirmed scoped stop and cancels deliveries without hard cleanup', async () => {
    const ports = createPorts();

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(ports.stopTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
    expect(result.stopOutcome).toBe('stopped');
    expect(result.cleanupOutcome).toBe('completed');
    expect(result.killedRuntimePids).toEqual([]);
    expect(result.clearedPendingDeliveries).toBe(2);
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  it('hands the kill step the time the stop was requested, not the time it gave up', async () => {
    // A relaunch of the same team can start a host while the regular stop is
    // still running, so the fence has to be the start of the flow. The stop
    // here spends real time before failing, and the two moments must differ.
    let gaveUpAtMs = 0;
    const ports = createPorts({
      stopTeam: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              gaveUpAtMs = Date.now();
              reject(new Error('did not confirm stop'));
            }, 40);
          })
      ),
      stopTimeoutMs: 5_000,
    });
    const before = Date.now();

    await runTeamForceStopFlow('fixteam', ports);

    const [, context] = ports.killRetainedRuntimeProcesses.mock.calls[0] as [
      string,
      { requestedAtMs: number },
    ];
    expect(gaveUpAtMs).toBeGreaterThan(0);
    expect(context.requestedAtMs).toBeGreaterThanOrEqual(before);
    expect(context.requestedAtMs).toBeLessThan(gaveUpAtMs);
  });

  it('reads the run ids before it asks for the stop and fences the cleanup with them', async () => {
    // The delivery ledger is keyed by lane, and a relaunch of the same team
    // reuses the lane. Reading the run ids after the stop would name the
    // successor, so the read has to happen before the stop is even asked for.
    const order: string[] = [];
    const ports = createPorts({
      observeOwnedRuntimeRunIds: vi.fn(() => {
        order.push('observe');
        return Promise.resolve(['run-a', 'run-a-secondary']);
      }),
      stopTeam: vi.fn(() => {
        order.push('stop');
        return Promise.resolve();
      }),
      clearPendingPromptDeliveries: vi.fn(() => {
        order.push('clear');
        return Promise.resolve({ cleared: 1, diagnostics: [] });
      }),
    });

    await runTeamForceStopFlow('fixteam', ports);

    expect(order).toEqual(['observe', 'clear', 'stop']);
    const [, context] = ports.clearPendingPromptDeliveries.mock.calls[0] as [
      string,
      { requestedAtMs: number; ownedRunIds: string[] },
    ];
    expect(context.ownedRunIds).toEqual(['run-a', 'run-a-secondary']);
    expect(context.requestedAtMs).toEqual(expect.any(Number));
  });

  it('cancels on the age fence alone when the run ids cannot be read', async () => {
    const ports = createPorts({
      observeOwnedRuntimeRunIds: vi.fn(() => Promise.reject(new Error('lane index unreadable'))),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: [],
    });
    expect(result.diagnostics.join('\n')).toContain(
      'Runtime run ids could not be read: lane index unreadable'
    );
    expect(ports.logWarning).toHaveBeenCalledWith(
      "[fixteam] Force stop could not read the team's run ids: lane index unreadable"
    );
  });

  it('continues with the hard kill when the regular stop rejects', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() =>
        Promise.reject(new Error('did not confirm stop; retaining runtime ownership'))
      ),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stop_failed');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
    });
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
    expect(result.killedRuntimePids).toEqual([4242]);
    expect(result.diagnostics.join('\n')).toContain('did not confirm stop');
  });

  it('continues with the hard kill when the regular stop never settles', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('timed_out');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
    });
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
    expect(result.diagnostics.join('\n')).toContain('timed out after 20ms');
  });

  it('reports a failing kill step as a diagnostic instead of failing the force stop', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => Promise.reject(new Error('stop failed'))),
      killRetainedRuntimeProcesses: vi.fn(() => Promise.reject(new Error('taskkill exited 1'))),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stop_failed');
    expect(result.killedRuntimePids).toEqual([]);
    expect(result.diagnostics.join('\n')).toContain('Process kill failed: taskkill exited 1');
    // The delivery cleanup still runs: a failed kill must not strand the ledger.
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
  });

  it('reports zero cleared deliveries when the team has none pending', async () => {
    const ports = createPorts({
      clearPendingPromptDeliveries: vi.fn(() => Promise.resolve({ cleared: 0, diagnostics: [] })),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.clearedPendingDeliveries).toBe(0);
    expect(result.diagnostics.join('\n')).not.toContain('pending prompt delivery record');
  });
  it('captures lane scope before stop and cancels again after the lane index is removed', async () => {
    const order: string[] = [];
    const clear = vi
      .fn()
      .mockResolvedValueOnce({ cleared: 1, diagnostics: [] })
      .mockResolvedValueOnce({ cleared: 2, diagnostics: [] });
    const ports = createPorts({
      observeOwnedRuntimeLaneIds: () => Promise.resolve(['primary']),
      clearPendingPromptDeliveries: clear,
      stopTeam: () => {
        order.push('stop');
        expect(clear).toHaveBeenCalledTimes(1);
        return Promise.resolve();
      },
    });
    const result = await runTeamForceStopFlow('fixteam', ports);
    expect(order).toEqual(['stop']);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenLastCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
      ownedLaneIds: ['primary'],
    });
    expect(result.clearedPendingDeliveries).toBe(3);
    expect(result.cleanupOutcome).toBe('completed');
  });

  it('persists the stopped state after the cleanup steps have run', async () => {
    const order: string[] = [];
    const markTeamStopped = vi.fn(() => {
      order.push('markTeamStopped');
      return Promise.resolve();
    });
    const ports = createPorts({
      clearPendingPromptDeliveries: vi.fn(() => {
        order.push('clearPendingPromptDeliveries');
        return Promise.resolve({ cleared: 0, diagnostics: [] });
      }),
      markTeamStopped,
    });

    await runTeamForceStopFlow('fixteam', ports);

    expect(markTeamStopped).toHaveBeenCalledWith('fixteam');
    expect(order).toEqual(['clearPendingPromptDeliveries', 'markTeamStopped']);
  });

  it('marks the team stopped even when the regular stop never confirmed', async () => {
    const markTeamStopped = vi.fn(() => Promise.resolve());
    const ports = createPorts({
      stopTeam: vi.fn(() => Promise.reject(new Error('did not confirm stop'))),
      markTeamStopped,
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stop_failed');
    expect(markTeamStopped).toHaveBeenCalledWith('fixteam');
  });

  it('reports a failing stopped-state write as a diagnostic instead of failing the force stop', async () => {
    const ports = createPorts({
      markTeamStopped: vi.fn(() => Promise.reject(new Error('team directory is read-only'))),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(result.diagnostics.join('\n')).toContain(
      'Stopped-state persistence failed: team directory is read-only'
    );
    expect(ports.logWarning).toHaveBeenCalledWith(
      '[fixteam] Could not persist stopped launch state: team directory is read-only'
    );
  });
});

describe('stopTeamWithEscalation', () => {
  it('touches no other process when the regular stop confirms', async () => {
    const ports = createPorts({ markTeamStopped: vi.fn(() => Promise.resolve()) });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(ports.stopTeam).toHaveBeenCalledWith('fixteam');
    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(ports.clearPendingPromptDeliveries).not.toHaveBeenCalled();
    expect(result).toEqual({
      stopOutcome: 'stopped',
      cleanupOutcome: 'completed',
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    });
    expect(ports.markTeamStopped).toHaveBeenCalledWith('fixteam');
  });

  it('does not cancel deliveries up front the way the force stop does', async () => {
    // The force stop cancels before the stop so a stop that removes the lane
    // index cannot strand the ledger. A regular Stop cannot: it does not yet
    // know whether it will have to escalate, and a confirmed Stop must leave
    // pending work alone.
    const escalating = createPorts({
      observeOwnedRuntimeLaneIds: () => Promise.resolve(['primary']),
    });
    await stopTeamWithEscalation('fixteam', escalating);
    expect(escalating.clearPendingPromptDeliveries).not.toHaveBeenCalled();

    const forcing = createPorts({ observeOwnedRuntimeLaneIds: () => Promise.resolve(['primary']) });
    await runTeamForceStopFlow('fixteam', forcing);
    expect(forcing.clearPendingPromptDeliveries).toHaveBeenCalled();
  });

  it('escalates to the force-stop cleanup when the regular stop rejects', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() =>
        Promise.reject(new Error('did not confirm stop; retaining runtime ownership'))
      ),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result.stopOutcome).toBe('stop_failed');
    expect(result.killedRuntimePids).toEqual([4242]);
    expect(result.clearedPendingDeliveries).toBe(2);
  });

  it('escalates to the force-stop cleanup when the regular stop runs out of budget', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result.stopOutcome).toBe('timed_out');
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
    });
    // The escalated cleanup carries the same run fence the force stop does:
    // a relaunch started inside the stop budget keeps its deliveries.
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledTimes(1);
  });

  it('scopes the escalated cancellation to the lanes read before the stop', async () => {
    const ports = createPorts({
      observeOwnedRuntimeLaneIds: () => Promise.resolve(['primary']),
      stopTeam: vi.fn(() => Promise.reject(new Error('did not confirm stop'))),
    });

    await stopTeamWithEscalation('fixteam', ports);

    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
      ownedLaneIds: ['primary'],
    });
  });
});

describe('stopTeamWithEscalation runtime-host evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advances fake time in poll-sized steps, letting each sample settle. */
  async function advanceThroughSamples(samples: number): Promise<void> {
    for (let sample = 0; sample < samples; sample += 1) {
      await vi.advanceTimersByTimeAsync(RUNTIME_HOSTS_POLL_INTERVAL_MS);
    }
  }

  it('finishes the moment the recorded hosts are gone instead of waiting out the budget', async () => {
    let liveHosts = 2;
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
      stopTimeoutMs: STOP_ESCALATION_TIMEOUT_MS,
      countLiveRuntimeHosts: vi.fn(() => Promise.resolve(liveHosts)),
    });

    const stopping = stopTeamWithEscalation('fixteam', ports);
    await advanceThroughSamples(2);
    liveHosts = 0;
    await advanceThroughSamples(2);
    const result = await stopping;

    expect(result.stopOutcome).toBe('runtime_already_down');
    expect(result.diagnostics.join('\n')).toContain('Runtime hosts were gone');
    // The team is down but the cleanup still runs: startup locks and pending
    // deliveries outlive the hosts.
    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
    });
    expect(ports.clearPendingPromptDeliveries).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
      ownedRunIds: ['run-a'],
    });
  });

  it('samples the hosts on their own evidence after the force stop cancelled deliveries up front', async () => {
    // The force stop persists the cancellation before it asks for the stop.
    // That write reaches the delivery ledger, never the launch state the poll
    // reads, so the poll must still end the wait on host evidence alone and a
    // lane must not read as down merely because its records were cancelled.
    const order: string[] = [];
    let liveHosts = 1;
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
      stopTimeoutMs: STOP_ESCALATION_TIMEOUT_MS,
      clearPendingPromptDeliveries: vi.fn(() => {
        order.push('cancel');
        return Promise.resolve({ cleared: 1, diagnostics: [] });
      }),
      countLiveRuntimeHosts: vi.fn(() => {
        order.push('sample');
        return Promise.resolve(liveHosts);
      }),
    });

    const stopping = runTeamForceStopFlow('fixteam', ports);
    await advanceThroughSamples(2);
    expect(order).toEqual(['cancel', 'sample', 'sample', 'sample']);
    liveHosts = 0;
    await advanceThroughSamples(1);

    await expect(stopping).resolves.toMatchObject({ stopOutcome: 'runtime_already_down' });
  });

  it('keeps the previous fixed budget when no host counter is supplied', async () => {
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
      stopTimeoutMs: 5_000,
    });

    const stopping = stopTeamWithEscalation('fixteam', ports);
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    await expect(stopping).resolves.toMatchObject({ stopOutcome: 'timed_out' });
    // The same flag on the same promise, one tick past the budget: that is what
    // makes the reading above evidence that the flow waited rather than a flag
    // nothing was ever going to set.
    expect(settled).toBe(true);
  });

  it('never arms the poller when the first sample already reports no live host', async () => {
    const countLiveRuntimeHosts = vi.fn(() => Promise.resolve(0));
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
      stopTimeoutMs: 5_000,
      countLiveRuntimeHosts,
    });

    const stopping = stopTeamWithEscalation('fixteam', ports);
    await advanceThroughSamples(4);
    // A team with nothing recorded must not be read as "everything exited".
    expect(countLiveRuntimeHosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(stopping).resolves.toMatchObject({ stopOutcome: 'timed_out' });
  });

  it('stops sampling once the flow leaves the stop phase, including when it throws', async () => {
    const countLiveRuntimeHosts = vi.fn(() => Promise.resolve(1));
    const ports = createPorts({
      stopTeam: vi.fn(() => new Promise<void>(() => undefined)),
      stopTimeoutMs: 2_000,
      countLiveRuntimeHosts,
      killRetainedRuntimeProcesses: vi.fn(() => Promise.reject(new Error('kill exploded'))),
    });

    const stopping = stopTeamWithEscalation('fixteam', ports);
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    const samplesAtStopEnd = countLiveRuntimeHosts.mock.calls.length;
    await advanceThroughSamples(5);

    expect(countLiveRuntimeHosts).toHaveBeenCalledTimes(samplesAtStopEnd);
  });

  /**
   * Arms the poller on a live host, then blinds the probe, and holds the
   * orchestrator's stop open until the assertions are made. A stop that ends as
   * `stopped` is evidence the flow kept waiting for the acknowledgement: had it
   * read the blind samples as "the hosts are gone" it would have ended on its
   * own, reported `runtime_already_down`, and run the force-stop cleanup.
   */
  async function expectBlindProbeKeepsStopOnItsNormalPath(
    countLiveRuntimeHosts: TeamForceStopFlowPorts['countLiveRuntimeHosts']
  ): Promise<void> {
    let confirmStop: (() => void) | undefined;
    const ports = createPorts({
      stopTeam: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            confirmStop = resolve;
          })
      ),
      stopTimeoutMs: STOP_ESCALATION_TIMEOUT_MS,
      countLiveRuntimeHosts,
    });

    const stopping = stopTeamWithEscalation('fixteam', ports);
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await advanceThroughSamples(4);

    expect(settled).toBe(false);
    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(ports.clearPendingPromptDeliveries).not.toHaveBeenCalled();

    confirmStop?.();
    const result = await stopping;

    expect(result.stopOutcome).toBe('stopped');
    expect(result.diagnostics.join('\n')).not.toContain('Runtime hosts were gone');
    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(ports.clearPendingPromptDeliveries).not.toHaveBeenCalled();
  }

  it('does not read a probe that rejects as hosts that are gone', async () => {
    let samples = 0;

    await expectBlindProbeKeepsStopOnItsNormalPath(() => {
      samples += 1;
      return samples === 1 ? Promise.resolve(2) : Promise.reject(new Error('probe exploded'));
    });
  });

  it('does not read a failed launch-state read as hosts that are gone', async () => {
    // The recorded-host probe in production: a launch state that named a live
    // host, then a read that failed. A failed read names no host either, and
    // that must not pass for a team that finished exiting.
    let reads = 0;
    const store = {
      readResult: (): Promise<TeamLaunchStateReadResult> => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? recordedSnapshot({ 'lane-a': 11 }) : { status: 'unreadable', reason: 'EIO' }
        );
      },
    };

    await expectBlindProbeKeepsStopOnItsNormalPath((teamName) =>
      countLiveRecordedRuntimeHostsForTeam({
        teamName,
        launchStateStore: store as never,
        isRuntimeProcessAlive: () => true,
      })
    );
  });
});

describe('countLiveRecordedRuntimeHostsForTeam', () => {
  it('counts only the pids the launch state recorded for this team', async () => {
    const alivePids = new Set([11, 22]);

    const live = await countLiveRecordedRuntimeHostsForTeam({
      teamName: 'fixteam',
      launchStateStore: launchStateStore(
        recordedSnapshot({ 'lane-a': 11, 'lane-b': 33, 'lane-c': undefined })
      ) as never,
      isRuntimeProcessAlive: (pid) => alivePids.has(pid),
    });

    expect(live).toBe(1);
  });

  it('counts no live host for a team that published no launch state', async () => {
    const live = await countLiveRecordedRuntimeHostsForTeam({
      teamName: 'fixteam',
      launchStateStore: launchStateStore({ status: 'absent' }) as never,
      isRuntimeProcessAlive: () => true,
    });

    expect(live).toBe(0);
  });

  it('reports unknown, not zero, when the launch state could not be read', async () => {
    const live = await countLiveRecordedRuntimeHostsForTeam({
      teamName: 'fixteam',
      launchStateStore: launchStateStore({ status: 'unreadable', reason: 'EBUSY' }) as never,
      isRuntimeProcessAlive: () => true,
    });

    expect(live).toBeNull();
  });

  it('reports unknown when the launch state read itself rejects', async () => {
    const live = await countLiveRecordedRuntimeHostsForTeam({
      teamName: 'fixteam',
      launchStateStore: { readResult: () => Promise.reject(new Error('unreadable')) } as never,
      isRuntimeProcessAlive: () => true,
    });

    expect(live).toBeNull();
  });

  it('does not count a process whose liveness cannot be read', async () => {
    const live = await countLiveRecordedRuntimeHostsForTeam({
      teamName: 'fixteam',
      launchStateStore: launchStateStore(recordedSnapshot({ 'lane-a': 11 })) as never,
      isRuntimeProcessAlive: () => {
        throw new Error('EPERM');
      },
    });

    expect(live).toBe(0);
  });
});
