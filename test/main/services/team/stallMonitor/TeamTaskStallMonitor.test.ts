import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';

function neverResolves(): Promise<never> {
  return new Promise(() => undefined);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe('TeamTaskStallMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('does not start scans or track team events when scanner gates are explicitly disabled', () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'false');

    const registry = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => []),
    };
    const monitor = new TeamTaskStallMonitor(
      registry as never,
      { getSnapshot: vi.fn() } as never,
      { evaluateWork: vi.fn(), evaluateReview: vi.fn() } as never,
      { reconcileScan: vi.fn(), markAlerted: vi.fn() } as never,
      { notifyLead: vi.fn(), notifyOpenCodeOwners: vi.fn() } as never
    );

    monitor.start();
    monitor.noteTeamChange({
      type: 'lead-activity',
      teamName: 'demo',
      detail: 'active',
    });

    expect(registry.start).not.toHaveBeenCalled();
    expect(registry.noteTeamChange).not.toHaveBeenCalled();
  });

  it('defaults to monitoring non-OpenCode work stalls and notifies lead after a second confirmed scan', async () => {
    vi.useFakeTimers();
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
      notifyOpenCodeOwners: vi.fn(async () => []),
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

  it('times out a hung scan so later stall scans continue', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const snapshotSource = {
      getSnapshot: vi.fn().mockImplementationOnce(neverResolves).mockResolvedValueOnce(null),
    };
    const monitor = new TeamTaskStallMonitor(
      {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['demo']),
      } as never,
      snapshotSource as never,
      { evaluateWork: vi.fn(), evaluateReview: vi.fn() } as never,
      { reconcileScan: vi.fn(), markAlerted: vi.fn() } as never,
      { notifyLead: vi.fn(), notifyOpenCodeOwners: vi.fn() } as never,
      { scanTimeoutMs: 10 }
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(3_010);
    expect(snapshotSource.getSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'task stall monitor scan timed out after 10ms'
    );
    vi.mocked(console.warn).mockClear();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(snapshotSource.getSnapshot).toHaveBeenCalledTimes(2);

    await monitor.stop();
  });

  it('does not let one stuck team block stall scans for other active teams', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const task = {
      id: 'task-healthy',
      displayId: 'beef1234',
      subject: 'Healthy team task',
    };
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-healthy',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-healthy:epoch',
      reason: 'Potential work stall.',
    };
    const snapshotSource = {
      getSnapshot: vi.fn(async (teamName: string) => {
        if (teamName === 'stuck') {
          return neverResolves();
        }
        return {
          teamName: 'healthy',
          inProgressTasks: [task],
          reviewOpenTasks: [],
          allTasksById: new Map([['task-healthy', task]]),
        };
      }),
    };
    const journal = {
      reconcileScan: vi.fn(async () => [readyEvaluation]),
      markAlerted: vi.fn(async () => undefined),
    };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
      notifyOpenCodeOwners: vi.fn(async () => []),
    };
    const monitor = new TeamTaskStallMonitor(
      {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['stuck', 'healthy']),
      } as never,
      snapshotSource as never,
      {
        evaluateWork: vi.fn(() => readyEvaluation),
        evaluateReview: vi.fn(),
      } as never,
      journal as never,
      notifier as never,
      { scanTimeoutMs: 100 }
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(3_100);
    await flushAsyncWork();

    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'task stall monitor scan timed out after 100ms'
    );
    vi.mocked(console.warn).mockClear();
    expect(snapshotSource.getSnapshot).toHaveBeenCalledWith('stuck');
    expect(snapshotSource.getSnapshot).toHaveBeenCalledWith('healthy');
    expect(notifier.notifyLead).toHaveBeenCalledWith(
      'healthy',
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-healthy',
        }),
      ])
    );
    expect(journal.markAlerted).toHaveBeenCalledWith(
      'healthy',
      'task-healthy:epoch',
      expect.any(String)
    );

    await monitor.stop();
  });

  it('ignores late side effects from a scan that already timed out', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const staleJournalScan = createDeferred<unknown[]>();
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch',
      reason: 'Potential work stall.',
    };
    const task = { id: 'task-a', displayId: 'abcd1234', subject: 'Task A' };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
      notifyOpenCodeOwners: vi.fn(async () => []),
    };
    const journal = {
      reconcileScan: vi
        .fn()
        .mockImplementationOnce(() => staleJournalScan.promise)
        .mockResolvedValueOnce([]),
      markAlerted: vi.fn(async () => undefined),
    };
    const monitor = new TeamTaskStallMonitor(
      {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['demo']),
      } as never,
      {
        getSnapshot: vi.fn(async () => ({
          teamName: 'demo',
          inProgressTasks: [task],
          reviewOpenTasks: [],
          allTasksById: new Map([['task-a', task]]),
        })),
      } as never,
      {
        evaluateWork: vi.fn(() => readyEvaluation),
        evaluateReview: vi.fn(),
      } as never,
      journal as never,
      notifier as never,
      { scanTimeoutMs: 10 }
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(3_010);
    expect(journal.reconcileScan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'task stall monitor scan timed out after 10ms'
    );
    vi.mocked(console.warn).mockClear();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(journal.reconcileScan).toHaveBeenCalledTimes(2);

    staleJournalScan.resolve([readyEvaluation]);
    await flushAsyncWork();

    expect(notifier.notifyLead).not.toHaveBeenCalled();
    expect(journal.markAlerted).not.toHaveBeenCalled();

    await monitor.stop();
  });

  it('defaults to OpenCode owner remediation without duplicate lead alerts when remediation is accepted', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const task = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
    };
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      progressSignal: 'weak_start_only',
      epochKey: 'task-a:epoch',
      reason: 'Potential work stall after weak start-only task comment.',
    };
    const journal = {
      reconcileScan: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([readyEvaluation]),
      markAlerted: vi.fn(async () => undefined),
    };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
      notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
    };
    const monitor = new TeamTaskStallMonitor(
      {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['demo']),
      } as never,
      {
        getSnapshot: vi.fn(async () => ({
          teamName: 'demo',
          inProgressTasks: [task],
          reviewOpenTasks: [],
          allTasksById: new Map([['task-a', task]]),
          providerByMemberName: new Map([['alice', 'opencode']]),
        })),
      } as never,
      {
        evaluateWork: vi.fn(() => readyEvaluation),
        evaluateReview: vi.fn(),
      } as never,
      journal as never,
      notifier as never
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
    expect(notifier.notifyLead).not.toHaveBeenCalled();
    expect(journal.reconcileScan).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        scopeTaskIds: expect.any(Array),
      })
    );
    expect(journal.markAlerted).toHaveBeenCalledWith(
      'demo',
      'task-a:epoch',
      expect.any(String)
    );
  });

  it('uses OpenCode owner remediation without lead alerts when only remediation is enabled', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const registry = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => ['demo']),
    };
    const task = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
    };
    const snapshot = {
      teamName: 'demo',
      inProgressTasks: [task],
      reviewOpenTasks: [],
      allTasksById: new Map([['task-a', task]]),
      providerByMemberName: new Map([['alice', 'opencode']]),
    };
    const snapshotSource = {
      getSnapshot: vi.fn(async () => snapshot),
    };
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      progressSignal: 'weak_start_only',
      epochKey: 'task-a:epoch',
      reason: 'Potential work stall after weak start-only task comment.',
    };
    const policy = {
      evaluateWork: vi.fn(() => readyEvaluation),
      evaluateReview: vi.fn(),
    };
    const journal = {
      reconcileScan: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([readyEvaluation]),
      markAlerted: vi.fn(async () => undefined),
    };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
      notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
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

    expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
    expect(journal.reconcileScan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        evaluations: [readyEvaluation],
        scopeTaskIds: ['task-a'],
      })
    );
    expect(notifier.notifyLead).not.toHaveBeenCalled();
    expect(journal.markAlerted).toHaveBeenCalledWith(
      'demo',
      'task-a:epoch',
      expect.any(String)
    );
  });

  it('does not journal non-OpenCode task alerts when only OpenCode remediation is enabled', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const task = {
      id: 'task-codex',
      displayId: 'c0dex123',
      subject: 'Codex task',
      owner: 'alice',
    };
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-codex',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-codex:epoch',
      reason: 'Potential work stall.',
    };
    const journal = {
      reconcileScan: vi.fn(async ({ evaluations }: { evaluations: unknown[] }) => evaluations),
      markAlerted: vi.fn(async () => undefined),
    };
    const notifier = {
      notifyLead: vi.fn(async () => undefined),
      notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
    };
    const monitor = new TeamTaskStallMonitor(
      {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['demo']),
      } as never,
      {
        getSnapshot: vi.fn(async () => ({
          teamName: 'demo',
          inProgressTasks: [task],
          reviewOpenTasks: [],
          allTasksById: new Map([['task-codex', task]]),
          providerByMemberName: new Map([['alice', 'codex']]),
        })),
      } as never,
      {
        evaluateWork: vi.fn(() => readyEvaluation),
        evaluateReview: vi.fn(),
      } as never,
      journal as never,
      notifier as never
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(1_100);

    expect(journal.reconcileScan).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluations: [],
        scopeTaskIds: [],
      })
    );
    expect(notifier.notifyOpenCodeOwners).not.toHaveBeenCalled();
    expect(notifier.notifyLead).not.toHaveBeenCalled();
    expect(journal.markAlerted).not.toHaveBeenCalled();
  });

  it('defaults to lead fallback when OpenCode remediation is not accepted', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const registry = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => ['demo']),
    };
    const task = {
      id: 'task-a',
      displayId: 'abcd1234',
      subject: 'Task A',
      owner: 'alice',
    };
    const snapshot = {
      teamName: 'demo',
      inProgressTasks: [task],
      reviewOpenTasks: [],
      allTasksById: new Map([['task-a', task]]),
      providerByMemberName: new Map([['alice', 'opencode']]),
    };
    const readyEvaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch',
      reason: 'Potential work stall.',
    };
    const notifier = {
      notifyOpenCodeOwners: vi.fn(async () => []),
      notifyLead: vi.fn(async () => undefined),
    };
    const monitor = new TeamTaskStallMonitor(
      registry as never,
      { getSnapshot: vi.fn(async () => snapshot) } as never,
      {
        evaluateWork: vi.fn(() => readyEvaluation),
        evaluateReview: vi.fn(),
      } as never,
      {
        reconcileScan: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([readyEvaluation]),
        markAlerted: vi.fn(async () => undefined),
      } as never,
      notifier as never
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(notifier.notifyLead).toHaveBeenCalledTimes(1);
  });
});
