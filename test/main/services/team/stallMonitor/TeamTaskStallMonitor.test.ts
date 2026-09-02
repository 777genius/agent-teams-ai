import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskStallJournal } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';

import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '../../../../../src/main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';

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
        epochKey: 'work-a:epoch',
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
            epochKey: 'work-a:epoch',
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
    expect(journal.markAlerted).toHaveBeenCalledWith('demo', 'work-a:epoch', expect.any(String));
  });

  it('times out a hung scan so later stall scans continue', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const hungSnapshot = createDeferred<null>();
    const snapshotSource = {
      getSnapshot: vi
        .fn()
        .mockImplementationOnce(() => hungSnapshot.promise)
        .mockResolvedValueOnce(null),
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

    hungSnapshot.resolve(null);
    await flushAsyncWork();
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
    const stuckSnapshot = createDeferred<null>();
    const snapshotSource = {
      getSnapshot: vi.fn(async (teamName: string) => {
        if (teamName === 'stuck') {
          return stuckSnapshot.promise;
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

    stuckSnapshot.resolve(null);
    await flushAsyncWork();
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
      taskId: 'work-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'work-a:epoch',
      reason: 'Potential work stall.',
    };
    const task = { id: 'work-a', displayId: 'abcd1234', subject: 'Work A' };
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
          allTasksById: new Map([['work-a', task]]),
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

  it('idempotently waits for a timed-out scan body before stop resolves', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');

    const pendingJournalWrite = createDeferred<unknown[]>();
    const registry = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => ['demo']),
    };
    const task = { id: 'work-a', displayId: 'abcd1234', subject: 'Work A' };
    const monitor = new TeamTaskStallMonitor(
      registry as never,
      {
        getSnapshot: vi.fn(async () => ({
          teamName: 'demo',
          inProgressTasks: [task],
          reviewOpenTasks: [],
          allTasksById: new Map([['work-a', task]]),
        })),
      } as never,
      {
        evaluateWork: vi.fn(() => ({
          status: 'alert',
          taskId: 'work-a',
          branch: 'work',
          signal: 'turn_ended_after_touch',
          epochKey: 'work-a:epoch',
          reason: 'Potential work stall.',
        })),
        evaluateReview: vi.fn(),
      } as never,
      {
        reconcileScan: vi.fn(() => pendingJournalWrite.promise),
        markAlerted: vi.fn(async () => undefined),
      } as never,
      { notifyLead: vi.fn(), notifyOpenCodeOwners: vi.fn() } as never,
      { scanTimeoutMs: 10 }
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(3_010);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'task stall monitor scan timed out after 10ms'
    );
    vi.mocked(console.warn).mockClear();

    let stopped = false;
    const firstStop = monitor.stop();
    const secondStop = monitor.stop();
    void firstStop.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(secondStop).toBe(firstStop);
    expect(registry.stop).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);

    pendingJournalWrite.resolve([]);
    await firstStop;
    expect(stopped).toBe(true);
    expect(monitor.stop()).toBe(firstStop);

    monitor.start();
    expect(registry.start).toHaveBeenCalledOnce();
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
      epochKey: 'work-a:epoch',
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
    expect(journal.markAlerted).toHaveBeenCalledWith('demo', 'work-a:epoch', expect.any(String));
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
      epochKey: 'work-a:epoch',
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
    expect(journal.markAlerted).toHaveBeenCalledWith('demo', 'work-a:epoch', expect.any(String));
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

  describe('pending pickup escalation', () => {
    const pickupTask = {
      id: 'task-pickup',
      displayId: 'feed9999',
      subject: 'Summarize the top-3 risks',
      owner: 'Scout',
      status: 'pending',
    };
    const startedTask = { ...pickupTask, status: 'in_progress' };
    const pickupEvaluation = {
      status: 'alert',
      taskId: 'task-pickup',
      memberName: 'Scout',
      branch: 'work',
      signal: 'pending_pickup_after_unblock',
      remediationKind: 'pending_pickup',
      epochKey: 'task-pickup:work:pending_pickup_after_unblock:Scout:2026-04-19T12:00:00.000Z',
      reason: 'Potential pickup stall.',
    } as const;

    /** One completed scan per advance after the initial 2 s start delay. */
    const SCAN_ADVANCE_MS = 1_100;

    function createMemoryJournalStore(): TaskStallJournalStore & {
      readEntries: () => TaskStallJournalEntry[];
    } {
      let stored: TaskStallJournalEntry[] = [];
      return {
        readEntries: () => stored,
        async update<T>(
          _teamName: string,
          mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
        ): Promise<T> {
          const mutation = mutate(stored.map((entry) => ({ ...entry })));
          stored = mutation.entries;
          return mutation.result;
        },
      };
    }

    function stubScanEnv(): void {
      vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
      vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
      vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');
    }

    function createRegistry() {
      return {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        noteTeamChange: vi.fn(),
        listActiveTeams: vi.fn(async () => ['demo']),
      };
    }

    function createSnapshot(task: typeof pickupTask) {
      const isPending = task.status === 'pending';
      return {
        teamName: 'demo',
        inProgressTasks: isPending ? [] : [task],
        reviewOpenTasks: [],
        pendingPickupTasks: isPending ? [task] : [],
        allTasksById: new Map([[task.id, task]]),
        providerByMemberName: new Map([['scout', 'opencode']]),
      };
    }

    it('nudges the OpenCode owner exactly once, only after the second scan', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const store = createMemoryJournalStore();
      const journal = new TeamTaskStallJournal({ store });
      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        { getSnapshot: vi.fn(async () => createSnapshot(pickupTask)) } as never,
        {
          evaluateWork: vi.fn(),
          evaluatePendingPickup: vi.fn(() => pickupEvaluation),
          evaluateReview: vi.fn(),
        } as never,
        journal as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      // The two-scan rule holds the first alert, and the pending task id must be
      // in activeTaskIds or the journal would prune the entry on every scan.
      expect(notifier.notifyOpenCodeOwners).not.toHaveBeenCalled();
      expect(store.readEntries()).toEqual([
        expect.objectContaining({
          taskId: 'task-pickup',
          memberName: 'Scout',
          signal: 'pending_pickup_after_unblock',
          state: 'suspected',
          consecutiveScans: 1,
        }),
      ]);

      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledWith('demo', [
        expect.objectContaining({
          taskId: 'task-pickup',
          owner: 'Scout',
          ownerProviderId: 'opencode',
          branch: 'work',
          signal: 'pending_pickup_after_unblock',
          remediationKind: 'pending_pickup',
        }),
      ]);
      expect(notifier.notifyLead).not.toHaveBeenCalled();
      expect(store.readEntries()).toEqual([
        expect.objectContaining({ state: 'alerted', consecutiveScans: 2 }),
      ]);

      // A third scan stays inside the alert cooldown: still exactly one nudge.
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).not.toHaveBeenCalled();

      await monitor.stop();
    });

    it('sends nothing when the owner starts the task between the two scans', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const store = createMemoryJournalStore();
      const journal = new TeamTaskStallJournal({ store });
      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        {
          getSnapshot: vi
            .fn()
            .mockResolvedValueOnce(createSnapshot(pickupTask))
            .mockResolvedValue(createSnapshot(startedTask)),
        } as never,
        {
          evaluateWork: vi.fn(() => ({
            status: 'skip',
            taskId: 'task-pickup',
            reason: 'Work touch is still below the configured stall threshold',
            skipReason: 'below_threshold',
          })),
          evaluatePendingPickup: vi.fn(() => pickupEvaluation),
          evaluateReview: vi.fn(),
        } as never,
        journal as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      expect(store.readEntries()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyOpenCodeOwners).not.toHaveBeenCalled();
      expect(notifier.notifyLead).not.toHaveBeenCalled();
      expect(store.readEntries()).toEqual([]);

      await monitor.stop();
    });

    it('falls back to the lead when the pickup nudge is not accepted', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async () => []),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        { getSnapshot: vi.fn(async () => createSnapshot(pickupTask)) } as never,
        {
          evaluateWork: vi.fn(),
          evaluatePendingPickup: vi.fn(() => pickupEvaluation),
          evaluateReview: vi.fn(),
        } as never,
        new TeamTaskStallJournal({ store: createMemoryJournalStore() }) as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyLead).toHaveBeenCalledWith('demo', [
        expect.objectContaining({ taskId: 'task-pickup', remediationKind: 'pending_pickup' }),
      ]);

      await monitor.stop();
    });

    it('escalates the pickup alert from the owner to the lead and then goes silent', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const store = createMemoryJournalStore();
      // A 1 ms cooldown makes every later scan a fresh escalation attempt.
      const journal = new TeamTaskStallJournal({ store, alertCooldownMs: 1 });
      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        { getSnapshot: vi.fn(async () => createSnapshot(pickupTask)) } as never,
        {
          evaluateWork: vi.fn(),
          evaluatePendingPickup: vi.fn(() => pickupEvaluation),
          evaluateReview: vi.fn(),
        } as never,
        journal as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      // Second rung: the owner was already nudged for this epoch, so the lead
      // takes over instead of the owner being nudged again.
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).toHaveBeenCalledWith('demo', [
        expect.objectContaining({ taskId: 'task-pickup', remediationKind: 'pending_pickup' }),
      ]);

      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      // Third rung and beyond: nobody is told again, and the ladder announces
      // itself spent exactly once rather than on every later scan.
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual([
        expect.stringContaining('pickup_escalation_exhausted'),
      ]);
      vi.mocked(console.warn).mockClear();
      // The cooldown keeps running so the silenced epoch is not re-examined on
      // every scan.
      expect(store.readEntries()).toEqual([
        expect.objectContaining({ state: 'alerted', alertCount: 4 }),
      ]);

      await monitor.stop();
    });

    it('respects the alert cooldown between escalation rungs', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        { getSnapshot: vi.fn(async () => createSnapshot(pickupTask)) } as never,
        {
          evaluateWork: vi.fn(),
          evaluatePendingPickup: vi.fn(() => pickupEvaluation),
          evaluateReview: vi.fn(),
        } as never,
        new TeamTaskStallJournal({
          store: createMemoryJournalStore(),
          alertCooldownMs: 10 * 60_000,
        }) as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      for (let scan = 0; scan < 8; scan += 1) {
        await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      }

      // Nine scans inside one 10-minute cooldown: the owner is nudged once and
      // the lead is never reached, because the second rung is not yet due.
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyLead).not.toHaveBeenCalled();

      await monitor.stop();
    });

    it('nudges only the oldest pending task per member and keeps the rest for a later scan', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const olderTask = { ...pickupTask };
      const newerTask = {
        ...pickupTask,
        id: 'task-pickup-newer',
        displayId: 'feed8888',
        subject: 'Second unblocked task',
      };
      const evaluationByTaskId = {
        [olderTask.id]: { ...pickupEvaluation, readyAt: '2026-04-19T12:00:00.000Z' },
        [newerTask.id]: {
          ...pickupEvaluation,
          taskId: newerTask.id,
          readyAt: '2026-04-19T12:03:00.000Z',
          epochKey:
            'task-pickup-newer:work:pending_pickup_after_unblock:Scout:2026-04-19T12:03:00.000Z',
        },
      };
      const notifier = {
        notifyLead: vi.fn(async () => undefined),
        notifyOpenCodeOwners: vi.fn(async (_teamName: string, alerts: unknown[]) => alerts),
      };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        {
          getSnapshot: vi.fn(async () => ({
            teamName: 'demo',
            inProgressTasks: [],
            reviewOpenTasks: [],
            // Newest first: the cap must order by the pickup clock, not by the
            // order the snapshot happens to list the tasks in.
            pendingPickupTasks: [newerTask, olderTask],
            allTasksById: new Map([
              [olderTask.id, olderTask],
              [newerTask.id, newerTask],
            ]),
            providerByMemberName: new Map([['scout', 'opencode']]),
          })),
        } as never,
        {
          evaluateWork: vi.fn(),
          evaluatePendingPickup: vi.fn(
            ({ task }: { task: { id: keyof typeof evaluationByTaskId } }) =>
              evaluationByTaskId[task.id]
          ),
          evaluateReview: vi.fn(),
        } as never,
        new TeamTaskStallJournal({ store: createMemoryJournalStore() }) as never,
        notifier as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(1);
      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledWith('demo', [
        expect.objectContaining({ taskId: olderTask.id }),
      ]);
      // The held-back task must not leak to the lead either.
      expect(notifier.notifyLead).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(notifier.notifyOpenCodeOwners).toHaveBeenCalledTimes(2);
      expect(notifier.notifyOpenCodeOwners).toHaveBeenLastCalledWith('demo', [
        expect.objectContaining({ taskId: newerTask.id }),
      ]);
      expect(notifier.notifyLead).not.toHaveBeenCalled();

      await monitor.stop();
    });

    it('leaves snapshots without pending pickup candidates untouched', async () => {
      vi.useFakeTimers();
      stubScanEnv();

      const evaluatePendingPickup = vi.fn();
      const reconcileScan = vi.fn(async () => []);
      const task = { id: 'task-a', displayId: 'abcd1234', subject: 'Task A' };
      const monitor = new TeamTaskStallMonitor(
        createRegistry() as never,
        {
          getSnapshot: vi.fn(async () => ({
            teamName: 'demo',
            inProgressTasks: [task],
            reviewOpenTasks: [],
            allTasksById: new Map([['task-a', task]]),
          })),
        } as never,
        {
          evaluateWork: vi.fn(() => ({
            status: 'skip',
            taskId: 'task-a',
            reason: 'Task has no open work interval',
            skipReason: 'no_open_work_interval',
          })),
          evaluatePendingPickup,
          evaluateReview: vi.fn(),
        } as never,
        { reconcileScan, markAlerted: vi.fn(async () => undefined) } as never,
        { notifyLead: vi.fn(), notifyOpenCodeOwners: vi.fn() } as never
      );

      monitor.start();
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(SCAN_ADVANCE_MS);

      expect(evaluatePendingPickup).not.toHaveBeenCalled();
      expect(reconcileScan).toHaveBeenCalledWith(
        expect.objectContaining({ activeTaskIds: ['task-a'] })
      );

      await monitor.stop();
    });
  });
});
