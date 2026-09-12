import { describe, expect, it, vi } from 'vitest';

import { createDeferredWorkSyncStallObservation } from '../../src/main/startMemberWorkSyncFeature';

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
          throw new Error('episode_missing');
        }
        recorded.push(input.taskId);
      },
    } as Pick<MemberWorkSyncFeatureFacade, 'recordStallObservation'> as MemberWorkSyncFeatureFacade);

    await vi.waitFor(() => {
      expect(recorded).toEqual(['task-1']);
    });
    expect(attempts).toBe(2);
  });
});
