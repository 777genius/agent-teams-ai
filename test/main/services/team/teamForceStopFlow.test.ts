import {
  PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS,
  purgeStaleOpenCodeHostStartupLocks,
} from '@main/services/team/opencode/bridge/OpenCodeHostStartupLockCleanup';
import {
  countLiveRecordedRuntimeHostsForTeam,
  RUNTIME_HOSTS_POLL_INTERVAL_MS,
  releaseLoopbackRuntimesReservedByTeam,
  releaseSharedRuntimeResourcesAfterStop,
  runTeamForceStopFlow,
  STOP_ESCALATION_TIMEOUT_MS,
  stopTeamWithEscalation,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const releaseLoopbackRuntimeModels = vi.hoisted(() =>
  vi.fn<(options: { memberModels: readonly string[] }) => Promise<unknown>>(() =>
    Promise.resolve({ attempted: [], released: [], diagnostics: [] })
  )
);
vi.mock('@main/services/team/opencode/bridge/OpenCodeLoopbackRuntimeRelease', () => ({
  releaseLoopbackRuntimeModels,
}));

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

describe('post-stop external lead process tree reap', () => {
  /**
   * The step the kill above it cannot do. A scoped stop that confirmed has
   * released the team's sessions and never touched the external lead, which is
   * exactly the case where the tree is left behind, so unlike the host kill this
   * runs on both paths.
   */
  it('reaps on a stop that confirmed, where the kill step never runs', async () => {
    const ports = createPorts({
      reapOwnedLeadProcessTrees: vi.fn(() =>
        Promise.resolve({
          killedPids: [8100],
          diagnostics: ['Reaped 1 cursor-agent process tree(s)'],
        })
      ),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(ports.reapOwnedLeadProcessTrees).toHaveBeenCalledWith('fixteam', {
      requestedAtMs: expect.any(Number),
    });
    expect(result.stopOutcome).toBe('stopped');
    expect(result.cleanupOutcome).toBe('completed');
    expect(result.killedRuntimePids).toEqual([8100]);
    expect(result.diagnostics).toEqual(['Reaped 1 cursor-agent process tree(s)']);
  });

  /**
   * The sweep reports a tree that refused to die per tree and carries on, so
   * the reap resolves. It has still left the workspace occupied, and a stop
   * that called itself completed over it would be telling the user the team is
   * fully down while its lead is still running.
   */
  it('reports an incomplete cleanup when a lead tree the reap targeted refused to die', async () => {
    const ports = createPorts({
      reapOwnedLeadProcessTrees: vi.fn(() =>
        Promise.resolve({
          killedPids: [],
          incomplete: true,
          diagnostics: ['cursor-agent sweep: cursor-agent tree kill failed pid=8100: EPERM'],
        })
      ),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(result.cleanupOutcome).toBe('incomplete');
    expect(result.diagnostics).toEqual([
      'cursor-agent sweep: cursor-agent tree kill failed pid=8100: EPERM',
    ]);
  });

  // Between the kill and the release: the reap is a kill, and the release
  // unlinks locks that only a dead process lets go of.
  it('reaps after the kill step and before the shared runtime release', async () => {
    const order: string[] = [];
    const ports = createPorts({
      stopTeam: vi.fn(() => Promise.reject(new Error('did not confirm stop'))),
      killRetainedRuntimeProcesses: vi.fn(() => {
        order.push('kill');
        return Promise.resolve({ killedPids: [4242], diagnostics: [] });
      }),
      reapOwnedLeadProcessTrees: vi.fn(() => {
        order.push('reap');
        return Promise.resolve({ killedPids: [8100], diagnostics: [] });
      }),
      releaseSharedRuntimeResources: vi.fn(() => {
        order.push('release');
        return Promise.resolve({ diagnostics: [] });
      }),
    });

    const result = await runTeamForceStopFlow('fixteam', ports);

    expect(order).toEqual(['kill', 'reap', 'release']);
    expect(result.killedRuntimePids).toEqual([4242, 8100]);
  });

  // The port has no upstream default, so the common case is that no caller
  // supplies one, and that case must be indistinguishable from the behaviour
  // before the port existed.
  it('behaves exactly as before when no caller supplies the port', async () => {
    const ports = createPorts({ markTeamStopped: vi.fn(() => Promise.resolve()) });
    expect(ports.reapOwnedLeadProcessTrees).toBeUndefined();

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result).toEqual({
      stopOutcome: 'stopped',
      cleanupOutcome: 'completed',
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    });
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  /**
   * A reap that threw left a tree standing, which is what an incomplete cleanup
   * means - but the stop itself has already done everything else it owed, so it
   * still finishes and still writes the stopped state.
   */
  it('reports a reap that threw as an incomplete cleanup and still finishes the stop', async () => {
    const ports = createPorts({
      reapOwnedLeadProcessTrees: vi.fn(() =>
        Promise.reject(new Error('process table unavailable'))
      ),
      markTeamStopped: vi.fn(() => Promise.resolve()),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(result.cleanupOutcome).toBe('incomplete');
    expect(result.diagnostics).toEqual([
      'Lead process tree reap failed: process table unavailable',
    ]);
    expect(ports.markTeamStopped).toHaveBeenCalledWith('fixteam');
  });
});

describe('post-stop shared runtime release', () => {
  it('releases after a stop that confirmed on its own, before the stopped state is written', async () => {
    const order: string[] = [];
    const ports = createPorts({
      releaseSharedRuntimeResources: vi.fn(() => {
        order.push('release');
        return Promise.resolve({ diagnostics: ['Purged 3 stale OpenCode host startup lock(s)'] });
      }),
      markTeamStopped: vi.fn(() => {
        order.push('markStopped');
        return Promise.resolve();
      }),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(ports.releaseSharedRuntimeResources).toHaveBeenCalledWith('fixteam');
    expect(ports.killRetainedRuntimeProcesses).not.toHaveBeenCalled();
    expect(order).toEqual(['release', 'markStopped']);
    expect(result.diagnostics).toEqual(['Purged 3 stale OpenCode host startup lock(s)']);
  });

  // The kill has to come first: a lock a live host still holds open cannot be
  // unlinked, so releasing before the kill would leave every lock behind. The
  // kill step only runs when the stop did not confirm, so the stop rejects here.
  it('releases after the kill step on the force path', async () => {
    const order: string[] = [];
    const ports = createPorts({
      stopTeam: vi.fn(() => Promise.reject(new Error('did not confirm stop'))),
      killRetainedRuntimeProcesses: vi.fn(() => {
        order.push('kill');
        return Promise.resolve({ killedPids: [4242], diagnostics: [] });
      }),
      releaseSharedRuntimeResources: vi.fn(() => {
        order.push('release');
        return Promise.resolve({ diagnostics: [] });
      }),
    });

    await runTeamForceStopFlow('fixteam', ports);

    expect(ports.killRetainedRuntimeProcesses).toHaveBeenCalled();
    expect(order).toEqual(['kill', 'release']);
  });

  // The port has no upstream default, so the overwhelmingly common case is
  // that no caller supplies one. That case must be indistinguishable from the
  // behaviour before the port existed.
  it('behaves exactly as before when no caller supplies the port', async () => {
    const ports = createPorts({ markTeamStopped: vi.fn(() => Promise.resolve()) });
    expect(ports.releaseSharedRuntimeResources).toBeUndefined();

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result).toEqual({
      stopOutcome: 'stopped',
      cleanupOutcome: 'completed',
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    });
    expect(ports.markTeamStopped).toHaveBeenCalledWith('fixteam');
    expect(ports.logWarning).not.toHaveBeenCalled();
  });

  it('records a failed release as a diagnostic and still writes the stopped state', async () => {
    const ports = createPorts({
      releaseSharedRuntimeResources: vi.fn(() => Promise.reject(new Error('data dir gone'))),
      markTeamStopped: vi.fn(() => Promise.resolve()),
    });

    const result = await stopTeamWithEscalation('fixteam', ports);

    expect(result.stopOutcome).toBe('stopped');
    expect(result.diagnostics).toEqual(['Post-stop resource release failed: data dir gone']);
    expect(ports.markTeamStopped).toHaveBeenCalledWith('fixteam');
  });
});

describe('releaseSharedRuntimeResourcesAfterStop', () => {
  const purgedNothing = () =>
    Promise.resolve({ locksDir: '/locks', scanned: 0, removed: 0, kept: 0, diagnostics: [] });

  it('releases nothing at all while another team is alive', async () => {
    const purgeHostStartupLocks = vi.fn(purgedNothing);
    const releaseSharedLocalRuntime = vi.fn(() => Promise.resolve());

    const result = await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'fixteam',
      otherAliveTeams: ['other-team'],
      purgeHostStartupLocks,
      releaseSharedLocalRuntime,
    });

    expect(purgeHostStartupLocks).not.toHaveBeenCalled();
    expect(releaseSharedLocalRuntime).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([
      'Kept shared runtime resources: other teams are still alive (other-team)',
    ]);
  });

  it('purges the orphaned host startup locks when this was the last team', async () => {
    const result = await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'fixteam',
      otherAliveTeams: [],
      purgeHostStartupLocks: () =>
        Promise.resolve({
          locksDir: '/locks',
          scanned: 4,
          removed: 3,
          kept: 1,
          diagnostics: ['host-2.lock: Error: EIO'],
        }),
    });

    expect(result.diagnostics).toEqual([
      'Purged 3 stale OpenCode host startup lock(s)',
      'lock purge: host-2.lock: Error: EIO',
    ]);
  });

  // The port carries no upstream default: with no port handed in there is no
  // release step at all, and the result must be the lock purge and nothing else.
  it('has no shared-runtime step when no release port is supplied', async () => {
    const result = await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'fixteam',
      otherAliveTeams: [],
      purgeHostStartupLocks: purgedNothing,
    });

    expect(result.diagnostics).toEqual([]);
  });

  it('runs the supplied release port and reports it', async () => {
    const releaseSharedLocalRuntime = vi.fn(() => Promise.resolve());

    const result = await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'fixteam',
      otherAliveTeams: [],
      purgeHostStartupLocks: purgedNothing,
      releaseSharedLocalRuntime,
    });

    expect(releaseSharedLocalRuntime).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toEqual(['Released the shared runtime held for this team']);
  });

  // The alive-team list is read before this step runs, so a launch that starts
  // in between owns a lock this purge can already see. The age floor is the
  // only thing that keeps that lock: an unheld one would otherwise be unlinked
  // and the next host for the same port would start unserialised beside it.
  it('keeps the startup lock of a host that is starting right now', async () => {
    const locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-stop-locks-'));
    try {
      const startingLock = path.join(locksDir, 'starting.lock');
      fs.writeFileSync(startingLock, '');
      const orphanLock = path.join(locksDir, 'orphan.lock');
      fs.writeFileSync(orphanLock, '');
      const orphanMtime = new Date(Date.now() - (PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS + 60_000));
      fs.utimesSync(orphanLock, orphanMtime, orphanMtime);

      const result = await releaseSharedRuntimeResourcesAfterStop({
        teamName: 'fixteam',
        otherAliveTeams: [],
        purgeHostStartupLocks: (options) =>
          purgeStaleOpenCodeHostStartupLocks({ ...options, locksDir }),
      });

      expect(result.diagnostics).toEqual(['Purged 1 stale OpenCode host startup lock(s)']);
      expect(fs.existsSync(startingLock)).toBe(true);
      expect(fs.existsSync(orphanLock)).toBe(false);
    } finally {
      fs.rmSync(locksDir, { recursive: true, force: true });
    }
  });

  it('never throws: a failing purge or release is reported, not raised', async () => {
    const result = await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'fixteam',
      otherAliveTeams: [],
      purgeHostStartupLocks: () => Promise.reject(new Error('lock dir gone')),
      releaseSharedLocalRuntime: () => Promise.reject(new Error('runtime unreachable')),
    });

    expect(result.diagnostics).toEqual([
      'lock purge failed: lock dir gone',
      'Shared runtime release failed: runtime unreachable',
    ]);
  });
});

/**
 * The port implementor. `releaseSharedRuntimeResourcesAfterStop` decides
 * whether a release happens at all; this decides what it is allowed to touch,
 * and that is only what the stopped team's own members were running on.
 */
describe('releaseLoopbackRuntimesReservedByTeam', () => {
  const teamsBasePaths: string[] = [];

  afterEach(() => {
    for (const base of teamsBasePaths.splice(0)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  function writeTeamConfig(config: unknown): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'at-teams-'));
    teamsBasePaths.push(base);
    fs.mkdirSync(path.join(base, 'fixteam'), { recursive: true });
    fs.writeFileSync(path.join(base, 'fixteam', 'config.json'), JSON.stringify(config));
    return base;
  }

  it('releases only what the team members were configured to run on', async () => {
    releaseLoopbackRuntimeModels.mockClear();
    const teamsBasePath = writeTeamConfig({
      projectPath: '/projects/demo',
      members: [
        { name: 'lead', model: 'local-provider/model-a' },
        { name: 'worker', model: '  ' },
        { name: 'broken', model: 42 },
        { name: 'other', model: 'cursor-acp/auto' },
      ],
    });

    await releaseLoopbackRuntimesReservedByTeam(teamsBasePath, 'fixteam');

    expect(releaseLoopbackRuntimeModels).toHaveBeenCalledExactlyOnceWith({
      memberModels: ['local-provider/model-a', 'cursor-acp/auto'],
    });
  });

  // Fail closed: an unreadable config means the release has no list to narrow
  // by, and "no list" must release nothing rather than everything.
  it('narrows to nothing when the team config cannot be read', async () => {
    releaseLoopbackRuntimeModels.mockClear();
    const teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'at-teams-'));
    teamsBasePaths.push(teamsBasePath);

    await releaseLoopbackRuntimesReservedByTeam(teamsBasePath, 'fixteam');

    expect(releaseLoopbackRuntimeModels).toHaveBeenCalledExactlyOnceWith({ memberModels: [] });
  });
});
