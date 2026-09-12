import { describe, expect, it, vi } from 'vitest';

import {
  createDeferredWorkSyncStallObservation,
  runShutdownBackupAfterWorkSyncDrain,
} from '../../src/main/startMemberWorkSyncFeature';

import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';

describe('createDeferredWorkSyncStallObservation', () => {
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
});

describe('runShutdownBackupAfterWorkSyncDrain', () => {
  it('drains work-sync writers before copying backup state', async () => {
    const order: string[] = [];
    await runShutdownBackupAfterWorkSyncDrain({
      drainWorkSync: async () => {
        order.push('drain');
      },
      backup: {
        runShutdownBackupSync: () => {
          order.push('backup');
        },
      },
    });
    expect(order).toEqual(['drain', 'backup']);
  });
});
