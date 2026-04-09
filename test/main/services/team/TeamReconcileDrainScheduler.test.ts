import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockYieldToEventLoop } = vi.hoisted(() => ({
  mockYieldToEventLoop: vi.fn<() => Promise<void>>(),
}));

vi.mock('@main/utils/asyncYield', () => ({
  yieldToEventLoop: mockYieldToEventLoop,
}));

import {
  createTeamReconcileDrainScheduler,
  type TeamReconcileTrigger,
} from '../../../../src/main/services/team/TeamReconcileDrainScheduler';

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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TeamReconcileDrainScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockYieldToEventLoop.mockReset();
  });

  it('runs exactly one pass for a single scheduled event', async () => {
    mockYieldToEventLoop.mockResolvedValue(undefined);
    const calls: Array<{ teamName: string; trigger: TeamReconcileTrigger }> = [];
    const scheduler = createTeamReconcileDrainScheduler({
      run: vi.fn(async (teamName, trigger) => {
        calls.push({ teamName, trigger });
      }),
    });

    scheduler.schedule('team-a', { source: 'inbox', detail: 'inboxes/alice.json' });
    await flushAsyncWork();

    expect(calls).toEqual([
      {
        teamName: 'team-a',
        trigger: { source: 'inbox', detail: 'inboxes/alice.json' },
      },
    ]);

    scheduler.dispose();
  });

  it('collapses a burst for the same team into a trailing pass with the latest trigger', async () => {
    mockYieldToEventLoop.mockResolvedValue(undefined);
    const firstPass = createDeferred<void>();
    const calls: TeamReconcileTrigger[] = [];
    const scheduler = createTeamReconcileDrainScheduler({
      run: vi.fn(async (_teamName, trigger) => {
        calls.push(trigger);
        if (calls.length === 1) {
          await firstPass.promise;
        }
      }),
    });

    scheduler.schedule('team-a', { source: 'inbox', detail: 'inboxes/alice.json' });
    await flushAsyncWork();
    expect(calls).toEqual([{ source: 'inbox', detail: 'inboxes/alice.json' }]);

    scheduler.schedule('team-a', { source: 'task', detail: 'task-1.json' });
    scheduler.schedule('team-a', { source: 'task', detail: 'task-2.json' });
    await flushAsyncWork();
    expect(calls).toHaveLength(1);

    firstPass.resolve(undefined as void);
    await flushAsyncWork();

    expect(calls).toEqual([
      { source: 'inbox', detail: 'inboxes/alice.json' },
      { source: 'task', detail: 'task-2.json' },
    ]);

    scheduler.dispose();
  });

  it('does not lose a new event that arrives while the scheduler is yielding back to the event loop', async () => {
    const yieldGate = createDeferred<void>();
    mockYieldToEventLoop.mockImplementationOnce(() => yieldGate.promise).mockResolvedValue(undefined);
    const calls: TeamReconcileTrigger[] = [];
    const scheduler = createTeamReconcileDrainScheduler({
      run: vi.fn(async (_teamName, trigger) => {
        calls.push(trigger);
      }),
    });

    scheduler.schedule('team-a', { source: 'inbox', detail: 'inboxes/alice.json' });
    await flushAsyncWork();
    expect(calls).toEqual([{ source: 'inbox', detail: 'inboxes/alice.json' }]);

    scheduler.schedule('team-a', { source: 'task', detail: 'task-3.json' });
    await flushAsyncWork();
    expect(calls).toHaveLength(1);

    yieldGate.resolve(undefined as void);
    await flushAsyncWork();

    expect(calls).toEqual([
      { source: 'inbox', detail: 'inboxes/alice.json' },
      { source: 'task', detail: 'task-3.json' },
    ]);

    scheduler.dispose();
  });

  it('runs different teams independently', async () => {
    mockYieldToEventLoop.mockResolvedValue(undefined);
    const teamADeferred = createDeferred<void>();
    const teamBDeferred = createDeferred<void>();
    const calls: Array<{ teamName: string; trigger: TeamReconcileTrigger }> = [];
    const scheduler = createTeamReconcileDrainScheduler({
      run: vi.fn(async (teamName, trigger) => {
        calls.push({ teamName, trigger });
        if (teamName === 'team-a') {
          await teamADeferred.promise;
          return;
        }
        await teamBDeferred.promise;
      }),
    });

    scheduler.schedule('team-a', { source: 'inbox', detail: 'inboxes/a.json' });
    scheduler.schedule('team-b', { source: 'task', detail: 'task-b.json' });
    await flushAsyncWork();

    expect(calls).toEqual([
      { teamName: 'team-a', trigger: { source: 'inbox', detail: 'inboxes/a.json' } },
      { teamName: 'team-b', trigger: { source: 'task', detail: 'task-b.json' } },
    ]);

    teamADeferred.resolve(undefined as void);
    teamBDeferred.resolve(undefined as void);
    await flushAsyncWork();

    scheduler.dispose();
  });

  it('does not wedge scheduler state after a failed run', async () => {
    mockYieldToEventLoop.mockResolvedValue(undefined);
    const run = vi
      .fn<(teamName: string, trigger: TeamReconcileTrigger) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const scheduler = createTeamReconcileDrainScheduler({ run });

    scheduler.schedule('team-a', { source: 'task', detail: 'task-1.json' });
    await flushAsyncWork();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule('team-a', { source: 'task', detail: 'task-2.json' });
    await flushAsyncWork();
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('does not lose a new event that arrives while a failed pass is yielding', async () => {
    const yieldGate = createDeferred<void>();
    mockYieldToEventLoop.mockImplementationOnce(() => yieldGate.promise).mockResolvedValue(undefined);
    const run = vi
      .fn<(teamName: string, trigger: TeamReconcileTrigger) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const scheduler = createTeamReconcileDrainScheduler({ run });

    scheduler.schedule('team-a', { source: 'task', detail: 'task-1.json' });
    await flushAsyncWork();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule('team-a', { source: 'task', detail: 'task-2.json' });
    await flushAsyncWork();
    expect(run).toHaveBeenCalledTimes(1);

    yieldGate.resolve(undefined as void);
    await flushAsyncWork();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, 'team-a', {
      source: 'task',
      detail: 'task-2.json',
    });

    scheduler.dispose();
  });

  it('stops accepting future schedules after dispose without interrupting an active run', async () => {
    mockYieldToEventLoop.mockResolvedValue(undefined);
    const firstPass = createDeferred<void>();
    const calls: TeamReconcileTrigger[] = [];
    const scheduler = createTeamReconcileDrainScheduler({
      run: vi.fn(async (_teamName, trigger) => {
        calls.push(trigger);
        await firstPass.promise;
      }),
    });

    scheduler.schedule('team-a', { source: 'inbox', detail: 'inboxes/alice.json' });
    await flushAsyncWork();
    expect(calls).toEqual([{ source: 'inbox', detail: 'inboxes/alice.json' }]);

    scheduler.dispose();
    scheduler.schedule('team-a', { source: 'task', detail: 'task-9.json' });
    firstPass.resolve(undefined as void);
    await flushAsyncWork();

    expect(calls).toEqual([{ source: 'inbox', detail: 'inboxes/alice.json' }]);
  });
});
