import { describe, expect, it, vi } from 'vitest';

import { ActiveTeamRegistry } from '../../../../../src/main/services/team/stallMonitor/ActiveTeamRegistry';

describe('ActiveTeamRegistry', () => {
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
