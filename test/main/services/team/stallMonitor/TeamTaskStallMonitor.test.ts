import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';

describe('TeamTaskStallMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('runs end-to-end and notifies only after a second confirmed scan', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const registry = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => ['demo']),
    };
    const snapshot = {
      teamName: 'demo',
      inProgressTasks: [{ id: 'task-a', displayId: 'abcd1234', subject: 'Task A' }],
      reviewOpenTasks: [],
      allTasksById: new Map([
        ['task-a', { id: 'task-a', displayId: 'abcd1234', subject: 'Task A' }],
      ]),
    };
    const snapshotSource = {
      getSnapshot: vi.fn(async () => snapshot),
    };
    const policy = {
      evaluateWork: vi.fn(() => ({
        status: 'alert',
        taskId: 'task-a',
        branch: 'work',
        signal: 'turn_ended_after_touch',
        epochKey: 'task-a:epoch',
        reason: 'Potential work stall.',
      })),
      evaluateReview: vi.fn(),
    };
    const journal = {
      reconcileScan: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            status: 'alert',
            taskId: 'task-a',
            branch: 'work',
            signal: 'turn_ended_after_touch',
            epochKey: 'task-a:epoch',
            reason: 'Potential work stall.',
          },
        ]),
      markAlerted: vi.fn(async () => undefined),
    };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
    };

    const monitor = new TeamTaskStallMonitor(
      registry as never,
      snapshotSource as never,
      policy as never,
      journal as never,
      notifier as never
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(snapshotSource.getSnapshot).toHaveBeenCalledTimes(2);
    expect(notifier.notifyLead).toHaveBeenCalledTimes(1);
    expect(journal.markAlerted).toHaveBeenCalledWith(
      'demo',
      'task-a:epoch',
      expect.any(String)
    );
  });
});
