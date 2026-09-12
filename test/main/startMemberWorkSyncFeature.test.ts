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
});
