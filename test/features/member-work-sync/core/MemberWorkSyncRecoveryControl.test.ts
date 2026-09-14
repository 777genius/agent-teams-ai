import {
  applyMemberWorkSyncStopLatch,
  clearMemberWorkSyncStopLatch,
  isStaleMemberWorkSyncRecoveryControlRevision,
} from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryControl';
import { describe, expect, it } from 'vitest';

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

  it('treats a reservation from before the current control revision as stale', () => {
    const health = applyMemberWorkSyncStopLatch({
      previous: {
        schemaVersion: 1,
        episodes: [],
        unresolvedIntentId: 'intent-1',
        controlRevision: 1,
        reservations: [
          {
            intentId: 'intent-1',
            episodeId: 'episode-1',
            trigger: 'automatic',
            reservedAt: '2026-09-11T12:00:00.000Z',
            state: 'reserved',
            payloadHash: 'hash-1',
            controlRevision: 1,
          },
        ],
      },
      nowIso: '2026-09-11T12:01:00.000Z',
      reason: 'user_stop',
    });
    const resumed = clearMemberWorkSyncStopLatch({ previous: health });
    expect(
      isStaleMemberWorkSyncRecoveryControlRevision({
        health: resumed,
        intentId: 'intent-1',
      })
    ).toBe(true);
    expect(
      isStaleMemberWorkSyncRecoveryControlRevision({
        health: resumed,
        intentId: 'intent-other',
      })
    ).toBe(false);
  });
});
