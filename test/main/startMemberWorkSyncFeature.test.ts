import { describe, expect, it, vi } from 'vitest';

import {
  createDeferredWorkSyncStallObservation,
  runShutdownBackupAfterWorkSyncDrain,
  startPreparedMemberWorkSyncFeature,
} from '../../src/main/startMemberWorkSyncFeature';

import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';

describe('createDeferredWorkSyncStallObservation', () => {
  it('is attached only while a live work-sync feature is bound', () => {
    const observation = createDeferredWorkSyncStallObservation();
    expect(observation.isAttached()).toBe(false);

    observation.attach({
      recordStallObservation: async () => undefined,
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);
    expect(observation.isAttached()).toBe(true);

    observation.attach(null);
    expect(observation.isAttached()).toBe(false);

    observation.attach({
      recordStallObservation: async () => undefined,
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);
    observation.dispose();
    expect(observation.isAttached()).toBe(false);
  });

  it('buffers stall observations until work-sync attaches and then flushes them', async () => {
    const recorded: string[] = [];
    const observation = createDeferredWorkSyncStallObservation();
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(recorded).toEqual([]);

    observation.attach({
      recordStallObservation: async (input: { taskId: string }) => {
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-1']);
    });
  });

  it('keeps buffered observations when the first flush fails and retries them later', async () => {
    const recorded: string[] = [];
    const observation = createDeferredWorkSyncStallObservation();
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    let attempts = 0;
    observation.attach({
      recordStallObservation: async (input: { taskId: string }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('status_missing');
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(attempts).toBe(1);
    });
    expect(recorded).toEqual([]);

    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-2',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:01:00.000Z',
    });
    expect(recorded).toEqual(['task-1', 'task-2']);
  });

  it('retries a failed buffered observation without another stall alert', async () => {
    const recorded: string[] = [];
    const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 20 });
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    let attempts = 0;
    observation.attach({
      recordStallObservation: async (input: { taskId: string }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('status_missing');
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-1']);
    });
    expect(attempts).toBe(2);
  });

  it('drops permanently stale episode_missing observations and continues the queue', async () => {
    const recorded: string[] = [];
    const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 20 });
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    await observation.record({
      teamName: 'team-a',
      memberName: 'alice',
      taskId: 'task-2',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:01:00.000Z',
    });
    observation.attach({
      recordStallObservation: async (input: { taskId: string }) => {
        if (input.taskId === 'task-1') {
          const error = new Error('episode_missing');
          error.name = 'MemberWorkSyncStallEpisodeMissingError';
          throw error;
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-2']);
    });
  });

  it('materializes missing episodes and records the stall on retry', async () => {
    const recorded: string[] = [];
    const refreshed: string[] = [];
    const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 20 });
    const missing = new Set(['task-1']);
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    observation.attach({
      refreshStatus: async (input: { memberName: string }) => {
        refreshed.push(input.memberName);
        missing.clear();
        return {} as never;
      },
      recordStallObservation: async (input: { taskId: string }) => {
        if (missing.has(input.taskId)) {
          const error = new Error('episode_missing');
          error.name = 'MemberWorkSyncStallEpisodeMissingError';
          throw error;
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation' | 'refreshStatus'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-1']);
    });
    expect(refreshed).toEqual(['bob']);
  });

  it('drops episode_missing only after a failed materialize retry and continues the queue', async () => {
    const recorded: string[] = [];
    const refreshed: string[] = [];
    const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 20 });
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-1',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    await observation.record({
      teamName: 'team-a',
      memberName: 'alice',
      taskId: 'task-2',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:01:00.000Z',
    });
    observation.attach({
      refreshStatus: async (input: { memberName: string }) => {
        refreshed.push(input.memberName);
        return {} as never;
      },
      recordStallObservation: async (input: { taskId: string }) => {
        if (input.taskId === 'task-1') {
          const error = new Error('episode_missing');
          error.name = 'MemberWorkSyncStallEpisodeMissingError';
          throw error;
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation' | 'refreshStatus'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-2']);
    });
    expect(refreshed).toEqual(['bob']);
  });

  it('retries one team without blocking another team stall observation', async () => {
    const recorded: string[] = [];
    const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 50 });
    await observation.record({
      teamName: 'team-a',
      memberName: 'bob',
      taskId: 'task-a',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:00:00.000Z',
    });
    observation.attach({
      recordStallObservation: async (input: { teamName: string; taskId: string }) => {
        if (input.teamName === 'team-a') {
          throw new Error('status_missing');
        }
        recorded.push(`${input.teamName}:${input.taskId}`);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await observation.record({
      teamName: 'team-b',
      memberName: 'alice',
      taskId: 'task-b',
      reason: 'no_progress_deadline',
      observedAt: '2026-09-12T00:01:00.000Z',
    });

    expect(recorded).toEqual(['team-b:task-b']);
  });

  it('cancels stall-observation retries on dispose', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const observation = createDeferredWorkSyncStallObservation({ retryDelayMs: 20 });
      await observation.record({
        teamName: 'team-a',
        memberName: 'bob',
        taskId: 'task-1',
        reason: 'no_progress_deadline',
        observedAt: '2026-09-12T00:00:00.000Z',
      });
      observation.attach({
        recordStallObservation: async () => {
          attempts += 1;
          throw new Error('status_missing');
        },
      } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      observation.dispose();
      await vi.advanceTimersByTimeAsync(50);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runShutdownBackupAfterWorkSyncDrain', () => {
  it('closes ingress, then drains work-sync writers, then copies backup state', async () => {
    const order: string[] = [];
    await runShutdownBackupAfterWorkSyncDrain({
      closeIngress: async () => {
        order.push('close-ingress');
      },
      drainWorkSync: async () => {
        order.push('drain');
      },
      backup: {
        runShutdownBackupSync: () => {
          order.push('backup');
        },
      },
    });
    expect(order).toEqual(['close-ingress', 'drain', 'backup']);
  });

  it('drains work-sync and copies backup when ingress close fails', async () => {
    const order: string[] = [];
    await runShutdownBackupAfterWorkSyncDrain({
      closeIngress: async () => {
        order.push('close-ingress');
        throw new Error('server already closed');
      },
      drainWorkSync: async () => {
        order.push('drain');
      },
      backup: {
        runShutdownBackupSync: () => {
          order.push('backup');
        },
      },
    });
    expect(order).toEqual(['close-ingress', 'drain', 'backup']);
    vi.mocked(console.warn).mockClear();
  });
});

describe('startPreparedMemberWorkSyncFeature', () => {
  it('keeps desktop startup alive when backup initialization fails', async () => {
    const dispose = vi.fn(async () => undefined);
    const startBackground = vi.fn();
    const attach = vi.fn();
    const prepared = { dispose, startBackground };
    await expect(
      startPreparedMemberWorkSyncFeature({
        backup: {
          initialize: async () => {
            throw new Error('registry.json malformed');
          },
        } as never,
        prepared: prepared as never,
        stallObservation: { attach },
      })
    ).resolves.toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(startBackground).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockClear();
  });

  it('starts work-sync after a successful backup initialize', async () => {
    const dispose = vi.fn(async () => undefined);
    const startBackground = vi.fn();
    const attach = vi.fn();
    const prepared = { dispose, startBackground };
    await expect(
      startPreparedMemberWorkSyncFeature({
        backup: { initialize: async () => undefined } as never,
        prepared: prepared as never,
        stallObservation: { attach },
      })
    ).resolves.toBe(prepared);
    expect(dispose).not.toHaveBeenCalled();
    expect(startBackground).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
  });
});
