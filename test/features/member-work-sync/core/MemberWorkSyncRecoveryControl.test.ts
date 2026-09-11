import { describe, expect, it } from 'vitest';

import { applyMemberWorkSyncStopLatch, clearMemberWorkSyncStopLatch } from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryControl';

describe('member work sync stop latch', () => {
  it('increments control revision on stop and resume and keeps the stop durable', () => {
    const stopped = applyMemberWorkSyncStopLatch({
      nowIso: '2026-09-11T12:00:00.000Z',
      reason: 'user_stop',
    });
    expect(stopped.autoResumeStopLatch).toEqual({
      stoppedAt: '2026-09-11T12:00:00.000Z',
      reason: 'user_stop',
      controlRevision: 1,
    });
    expect(stopped.controlRevision).toBe(1);

    const resumed = clearMemberWorkSyncStopLatch({ previous: stopped });
    expect(resumed?.autoResumeStopLatch).toBeUndefined();
    expect(resumed?.controlRevision).toBe(2);

    const stoppedAgain = applyMemberWorkSyncStopLatch({
      previous: resumed,
      nowIso: '2026-09-11T12:01:00.000Z',
      reason: 'user_stop',
    });
    expect(stoppedAgain.controlRevision).toBe(3);
    expect(stoppedAgain.autoResumeStopLatch?.controlRevision).toBe(3);
  });
});
