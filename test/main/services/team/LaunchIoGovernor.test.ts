import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cloneLaunchIoGovernorPayload,
  LaunchIoGovernor,
} from '../../../../src/main/services/team/LaunchIoGovernor';

import type { GlobalTask, TeamProvisioningProgress, TeamSummary } from '../../../../src/shared/types';

function team(teamName: string): TeamSummary {
  return { teamName, displayName: teamName } as TeamSummary;
}

function task(id: string): GlobalTask {
  return { id, teamName: 'team-a', subject: id } as GlobalTask;
}

function progress(teamName: string, state: string): TeamProvisioningProgress {
  return {
    runId: `run-${teamName}`,
    teamName,
    state,
    message: state,
    startedAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  } as TeamProvisioningProgress;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('LaunchIoGovernor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs fresh and caches success when there is no launch pressure', async () => {
    const governor = new LaunchIoGovernor();
    const loadFresh = vi.fn(async () => [team('fresh')]);

    const result = await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });

    expect(result).toEqual([team('fresh')]);
    expect(loadFresh).toHaveBeenCalledTimes(1);
  });

  it('returns bounded stale cache under active launch pressure and schedules no duplicate fresh read', async () => {
    vi.useFakeTimers();
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now, quietWindowMs: 100 });
    const loadFresh = vi.fn(async () => [team('old')]);

    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    loadFresh.mockResolvedValue([team('new')]);

    governor.noteLaunchIntent('team-a', 'launch');
    const result = await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });

    expect(result).toEqual([team('old')]);
    expect(loadFresh).toHaveBeenCalledTimes(1);

    now += 99;
    await vi.advanceTimersByTimeAsync(99);
    expect(loadFresh).toHaveBeenCalledTimes(1);
  });

  it('isolates cached payload from caller-side mutations', async () => {
    const governor = new LaunchIoGovernor();
    const loadFresh = vi.fn(async () => [team('old')]);

    const first = await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    first[0]!.displayName = 'mutated';

    governor.noteLaunchIntent('team-a', 'launch');
    const second = await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });

    expect(second).toEqual([team('old')]);
    expect(loadFresh).toHaveBeenCalledTimes(1);
  });

  it('runs one fresh read and coalesces callers when pressure has no cache', async () => {
    const governor = new LaunchIoGovernor();
    const deferred = createDeferred<TeamSummary[]>();
    const loadFresh = vi.fn(() => deferred.promise);

    governor.noteLaunchIntent('team-a', 'launch');
    const first = governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    const second = governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });

    expect(loadFresh).toHaveBeenCalledTimes(1);
    deferred.resolve([team('fresh')]);
    await expect(Promise.all([first, second])).resolves.toEqual([[team('fresh')], [team('fresh')]]);
  });

  it('does not serve cache beyond max stale age during launch pressure', async () => {
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now, maxStaleAgeMs: 100 });
    const loadFresh = vi.fn(async () => [team('old')]);

    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    now = 101;
    loadFresh.mockResolvedValue([team('new')]);
    governor.noteLaunchIntent('team-a', 'launch');

    await expect(
      governor.runSummaryOperation('teams:list', loadFresh, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([team('new')]);
    expect(loadFresh).toHaveBeenCalledTimes(2);
  });

  it('keeps default launch summary cache through a long active startup', async () => {
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now });
    const loadFresh = vi.fn(async () => [task('old-task')]);

    await governor.runSummaryOperation('teams:getAllTasks', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    now = 60_000;
    loadFresh.mockResolvedValue([task('new-task')]);
    governor.noteLaunchIntent('team-a', 'launch');

    await expect(
      governor.runSummaryOperation('teams:getAllTasks', loadFresh, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([task('old-task')]);
    expect(loadFresh).toHaveBeenCalledTimes(1);
  });

  it('does not cache an in-flight result when a dirty generation arrives before it resolves', async () => {
    const governor = new LaunchIoGovernor();
    const deferred = createDeferred<TeamSummary[]>();
    const loadFresh = vi.fn(() => deferred.promise);

    const first = governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    governor.noteLaunchIntent('team-a', 'launch');
    deferred.resolve([team('stale-inflight')]);
    await expect(first).resolves.toEqual([team('stale-inflight')]);

    loadFresh.mockResolvedValue([team('fresh-after-dirty')]);
    await expect(
      governor.runSummaryOperation('teams:list', loadFresh, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([team('fresh-after-dirty')]);
    expect(loadFresh).toHaveBeenCalledTimes(2);
  });

  it('marks config and task changes dirty for the correct summary operations', async () => {
    const governor = new LaunchIoGovernor();
    const loadTeams = vi.fn(async () => [team('team-old')]);
    const loadTasks = vi.fn(async () => [task('task-old')]);

    await governor.runSummaryOperation('teams:list', loadTeams, {
      clone: cloneLaunchIoGovernorPayload,
    });
    await governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
      clone: cloneLaunchIoGovernorPayload,
    });

    loadTeams.mockResolvedValue([team('team-new')]);
    loadTasks.mockResolvedValue([task('task-new')]);
    governor.noteLaunchIntent('team-a', 'launch');
    governor.noteTeamChange({ type: 'task', teamName: 'team-a', detail: 'task.json' });

    await expect(
      governor.runSummaryOperation('teams:list', loadTeams, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([team('team-old')]);
    await expect(
      governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([task('task-old')]);
    expect(loadTeams).toHaveBeenCalledTimes(1);
    expect(loadTasks).toHaveBeenCalledTimes(1);
  });

  it('does not start background refresh for dirty events outside launch pressure', async () => {
    vi.useFakeTimers();
    const governor = new LaunchIoGovernor({ quietWindowMs: 100 });
    const loadTeams = vi.fn(async () => [team('old')]);

    await governor.runSummaryOperation('teams:list', loadTeams, {
      clone: cloneLaunchIoGovernorPayload,
    });
    loadTeams.mockResolvedValue([team('new')]);

    governor.noteTeamChange({ type: 'config', teamName: 'team-a', detail: 'config.json' });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(loadTeams).toHaveBeenCalledTimes(1);

    await expect(
      governor.runSummaryOperation('teams:list', loadTeams, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([team('new')]);
    expect(loadTeams).toHaveBeenCalledTimes(2);
  });

  it('does not mark global tasks dirty from launch intent alone', async () => {
    vi.useFakeTimers();
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now, quietWindowMs: 100 });
    const loadTeams = vi.fn(async () => [team('old-team')]);
    const loadTasks = vi.fn(async () => [task('old-task')]);

    await governor.runSummaryOperation('teams:list', loadTeams, {
      clone: cloneLaunchIoGovernorPayload,
    });
    await governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
      clone: cloneLaunchIoGovernorPayload,
    });
    loadTeams.mockResolvedValue([team('new-team')]);
    loadTasks.mockResolvedValue([task('new-task')]);

    governor.noteLaunchIntent('team-a', 'launch');
    await governor.runSummaryOperation('teams:list', loadTeams, {
      clone: cloneLaunchIoGovernorPayload,
    });
    await governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
      clone: cloneLaunchIoGovernorPayload,
    });
    governor.noteProvisioningProgress(progress('team-a', 'ready'));

    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(loadTeams).toHaveBeenCalledTimes(2);
    expect(loadTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps quiet window after terminal progress and flushes dirty cache once timer expires', async () => {
    vi.useFakeTimers();
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now, quietWindowMs: 100 });
    const loadFresh = vi.fn(async () => [team('old')]);
    const loadTasks = vi.fn(async () => [task('old')]);

    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    await governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
      clone: cloneLaunchIoGovernorPayload,
    });
    loadFresh.mockResolvedValue([team('new')]);
    loadTasks.mockResolvedValue([task('new')]);

    governor.noteLaunchIntent('team-a', 'launch');
    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    await governor.runSummaryOperation('teams:getAllTasks', loadTasks, {
      clone: cloneLaunchIoGovernorPayload,
    });
    governor.noteTeamChange({ type: 'config', teamName: 'team-a', detail: 'config.json' });
    governor.noteProvisioningProgress(progress('team-a', 'ready'));

    now += 99;
    await vi.advanceTimersByTimeAsync(99);
    await flushMicrotasks();
    expect(loadFresh).toHaveBeenCalledTimes(1);
    expect(loadTasks).toHaveBeenCalledTimes(1);

    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(loadFresh).toHaveBeenCalledTimes(2);
    expect(loadTasks).toHaveBeenCalledTimes(2);
  });

  it('keeps launch pressure until all concurrent launches reach terminal states', () => {
    let now = 0;
    const governor = new LaunchIoGovernor({ now: () => now, quietWindowMs: 100 });

    governor.noteLaunchIntent('team-a', 'launch');
    governor.noteLaunchIntent('team-b', 'launch');
    governor.noteProvisioningProgress(progress('team-a', 'failed'));
    expect(governor.hasLaunchPressureForTests()).toBe(true);

    governor.noteProvisioningProgress(progress('team-b', 'ready'));
    expect(governor.hasLaunchPressureForTests()).toBe(true);

    now += 100;
    expect(governor.hasLaunchPressureForTests()).toBe(false);
  });

  it('preserves old cache and dirty state when a deferred refresh fails', async () => {
    vi.useFakeTimers();
    let now = 0;
    const logger = { warn: vi.fn() };
    const governor = new LaunchIoGovernor({ now: () => now, quietWindowMs: 100, logger });
    const loadFresh = vi.fn(async () => [team('old')]);

    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    loadFresh.mockRejectedValueOnce(new Error('worker timeout'));

    governor.noteLaunchIntent('team-a', 'launch');
    governor.noteTeamChange({ type: 'config', teamName: 'team-a', detail: 'config.json' });
    await governor.runSummaryOperation('teams:list', loadFresh, {
      clone: cloneLaunchIoGovernorPayload,
    });
    governor.noteProvisioningProgress(progress('team-a', 'ready'));

    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deferred refresh failed'));
    governor.noteLaunchIntent('team-b', 'launch');
    await expect(
      governor.runSummaryOperation('teams:list', loadFresh, {
        clone: cloneLaunchIoGovernorPayload,
      })
    ).resolves.toEqual([team('old')]);
  });
});
