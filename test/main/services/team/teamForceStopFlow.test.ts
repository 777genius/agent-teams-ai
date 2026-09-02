import { runTeamForceStopFlow } from '@main/services/team/lifecycle/teamForceStopFlow';
import { describe, expect, it, vi } from 'vitest';

import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';

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
