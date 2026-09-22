import { describe, expect, it, vi } from 'vitest';

import { ActiveTeamRegistry } from '../../../../../src/main/services/team/stallMonitor/ActiveTeamRegistry';

describe('ActiveTeamRegistry', () => {
  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  it('activates a team on lead-activity and enables stall-monitor tracking', async () => {
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => []) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });

    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledWith('demo', 'stall_monitor');
    });
    await expect(registry.listActiveTeams()).resolves.toEqual(['demo']);
  });

  it('does not re-enable tracking for repeated activation events on the same team', async () => {
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => []) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });
    registry.noteTeamChange({
      type: 'member-spawn',
      teamName: 'demo',
      detail: 'alice',
    });

    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledTimes(1);
    });
    await expect(registry.listActiveTeams()).resolves.toEqual(['demo']);
  });

  it('does not cold-activate a team from task-log-change alone', async () => {
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => []) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'task-log-change',
      teamName: 'cold-team',
      taskId: 'task-1',
    });

    expect(tracker.enableTracking).not.toHaveBeenCalled();
    await expect(registry.listActiveTeams()).resolves.toEqual([]);
  });

  it('reconciles alive teams through TeamDataService helper and tracker consumer', async () => {
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => ['beta']) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'member-spawn',
      teamName: 'alpha',
      detail: 'alice',
    });
    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledWith('alpha', 'stall_monitor');
    });

    tracker.enableTracking.mockClear();
    await registry.reconcile();

    expect(tracker.enableTracking).toHaveBeenCalledWith('beta', 'stall_monitor');
    expect(tracker.disableTracking).toHaveBeenCalledWith('alpha', 'stall_monitor');
    await expect(registry.listActiveTeams()).resolves.toEqual(['beta']);
  });

  it('retries activation when enabling stall-monitor tracking fails', async () => {
    const tracker = {
      enableTracking: vi
        .fn()
        .mockRejectedValueOnce(new Error('tracker unavailable'))
        .mockResolvedValueOnce({ projectFingerprint: null, logSourceGeneration: null }),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => ['demo']) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });

    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'Failed to enable stall-monitor tracking for demo'
    );
    vi.mocked(console.warn).mockClear();
    await expect(registry.listActiveTeams()).resolves.toEqual([]);

    await registry.reconcile();

    expect(tracker.enableTracking).toHaveBeenCalledTimes(2);
    await expect(registry.listActiveTeams()).resolves.toEqual(['demo']);
  });

  it('does not re-add a team when pending activation finishes after stop', async () => {
    const activation = createDeferred<{
      projectFingerprint: string | null;
      logSourceGeneration: string | null;
    }>();
    const tracker = {
      enableTracking: vi.fn(() => activation.promise),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => []) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });
    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledWith('demo', 'stall_monitor');
    });

    await registry.stop();
    activation.resolve({ projectFingerprint: null, logSourceGeneration: null });

    await vi.waitFor(() => {
      expect(tracker.disableTracking).toHaveBeenCalledWith('demo', 'stall_monitor');
    });
    await expect(registry.listActiveTeams()).resolves.toEqual([]);
  });

  it('does not activate a team when a reconcile resumes after stop', async () => {
    const aliveTeams = createDeferred<string[]>();
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(() => aliveTeams.promise) },
      tracker as never
    );

    const reconcilePromise = registry.reconcile();
    await registry.stop();
    aliveTeams.resolve(['demo']);
    await reconcilePromise;

    expect(tracker.enableTracking).not.toHaveBeenCalled();
    await expect(registry.listActiveTeams()).resolves.toEqual([]);
  });

  it('does not re-enable tracking for teams that are already active during reconcile', async () => {
    const tracker = {
      enableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
      disableTracking: vi.fn(async () => ({ projectFingerprint: null, logSourceGeneration: null })),
    };
    const registry = new ActiveTeamRegistry(
      { listAliveProcessTeams: vi.fn(async () => ['demo']) },
      tracker as never
    );

    registry.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });
    await vi.waitFor(() => {
      expect(tracker.enableTracking).toHaveBeenCalledTimes(1);
    });

    tracker.enableTracking.mockClear();
    await registry.reconcile();

    expect(tracker.enableTracking).not.toHaveBeenCalled();
    await expect(registry.listActiveTeams()).resolves.toEqual(['demo']);
  });
});
