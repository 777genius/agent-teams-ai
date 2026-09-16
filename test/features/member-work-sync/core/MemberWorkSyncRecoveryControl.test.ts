import {
  applyMemberWorkSyncStopLatch,
  clearMemberWorkSyncStopLatch,
  findMemberWorkSyncDurableStopReceipt,
  isMemberWorkSyncStopRetired,
  isStaleMemberWorkSyncRecoveryControlRevision,
  prepareMemberWorkSyncPendingStop,
} from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryControl';
import { MemberWorkSyncRecoveryHealthError } from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryHealth';
import { describe, expect, it } from 'vitest';

describe('member work sync stop latch', () => {
  it.each([
    { length: 256, accepted: true },
    { length: 257, accepted: false },
  ])(
    'enforces the $length-character reason boundary during checkpoint preparation',
    ({ length, accepted }) => {
      const prepare = () =>
        prepareMemberWorkSyncPendingStop({
          previous: { schemaVersion: 1, episodes: [], controlRevision: 3 },
          checkpoint: {
            teamName: 'team-a',
            memberName: 'bob',
            incarnation: 'inc-1',
            runtimeInstanceId: 'runtime-1',
            localStopId: 'stop-1',
            requestId: 'stop-1',
            issuedAt: '2026-09-11T12:00:00.000Z',
            reason: 'r'.repeat(length),
          },
        });

      if (accepted) {
        expect(prepare().pendingRuntimeControl?.reason).toHaveLength(256);
      } else {
        expect(prepare).toThrow(MemberWorkSyncRecoveryHealthError);
      }
    }
  );

  it.each([
    ['a trailing character beyond the boundary', `${'r'.repeat(256)} `],
    ['an oversized whitespace-only value', ' '.repeat(257)],
  ])('rejects %s in direct domain Stop paths', (_label, reason) => {
    expect(() =>
      applyMemberWorkSyncStopLatch({
        nowIso: '2026-09-11T12:00:00.000Z',
        reason,
      })
    ).toThrow(MemberWorkSyncRecoveryHealthError);
    expect(() =>
      prepareMemberWorkSyncPendingStop({
        checkpoint: {
          teamName: 'team-a',
          memberName: 'bob',
          incarnation: 'inc-1',
          runtimeInstanceId: 'runtime-1',
          localStopId: 'stop-1',
          requestId: 'stop-1',
          issuedAt: '2026-09-11T12:00:00.000Z',
          reason,
        },
      })
    ).toThrow(MemberWorkSyncRecoveryHealthError);
  });

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

  it('retires an evicted first localStopId after 65 Stops and Resume', () => {
    const baseScope = {
      teamName: 'team-a',
      memberName: 'bob',
      incarnation: 'inc-1',
      runtimeInstanceId: 'runtime-1',
    };
    let health = applyMemberWorkSyncStopLatch({
      nowIso: '2026-09-11T12:00:00.000Z',
      reason: 'runtime_local_stop',
      durableReceipt: {
        ...baseScope,
        localStopId: 'stop-0',
        appliedAt: '2026-09-11T12:00:00.000Z',
      },
    });
    for (let index = 1; index <= 64; index += 1) {
      health = applyMemberWorkSyncStopLatch({
        previous: clearMemberWorkSyncStopLatch({ previous: health }),
        nowIso: '2026-09-11T12:00:00.000Z',
        reason: 'runtime_local_stop',
        durableReceipt: {
          ...baseScope,
          localStopId: `stop-${index}`,
          appliedAt: '2026-09-11T12:00:00.000Z',
        },
      });
    }
    const resumed = clearMemberWorkSyncStopLatch({ previous: health });
    const first = { ...baseScope, localStopId: 'stop-0' };
    expect(findMemberWorkSyncDurableStopReceipt(resumed, first)).toBeUndefined();
    expect(isMemberWorkSyncStopRetired(resumed, first)).toBe(true);
    expect(resumed?.durableStopReceipts).toHaveLength(64);
    expect(resumed?.retiredStopFilter?.bits).toHaveLength(512);
  });
});
