import { describe, expect, it } from 'vitest';

import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '@features/member-work-sync/main/adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  consumeOpenCodeWorkSyncLane,
  hasOpenCodeWorkSyncLaneReservation,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';

describe('OpenCode work-sync lane reservation', () => {
  it('reserves once and lets a matching inbox delivery consume without a second send token', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const admission = createOpenCodeMemberWorkSyncRuntimeTicketAdmission({
      reserve: async (ticket) => {
        const { reserveOpenCodeWorkSyncLane } = await import(
          '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore'
        );
        return reserveOpenCodeWorkSyncLane(ticket);
      },
      cancel: async (ticket) => {
        const { cancelOpenCodeWorkSyncLane } = await import(
          '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore'
        );
        cancelOpenCodeWorkSyncLane(ticket);
      },
    });
    const admitted = await admission.admit({
      teamName: 'team-a',
      memberName: 'bob',
      teamIncarnation: 'inc-1',
      intentId: 'intent-c1',
      admissionPayloadHash: 'hash-a',
      expectedGeneration: 3,
      controlRevision: 1,
      providerId: 'opencode',
    });
    expect(admitted.admitted).toBe(true);
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(true);
    expect(
      consumeOpenCodeWorkSyncLane({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'other-nudge',
      })
    ).toBe('absent');
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(true);
    expect(
      consumeOpenCodeWorkSyncLane({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'intent-c1',
      })
    ).toBe('consumed');
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(false);
  });

  it('lets a foreground send win a pending continuation reservation', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const { reserveOpenCodeWorkSyncLane } = await import(
      '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore'
    );
    reserveOpenCodeWorkSyncLane({
      teamName: 'team-a',
      teamIncarnation: 'inc-1',
      memberName: 'bob',
      runtimeInstanceId: 'opencode-lane',
      expectedGeneration: 1,
      ticketId: 'ticket-1',
      intentId: 'intent-c1',
      controlRevision: 1,
      admissionPayloadHash: 'hash-a',
    });
    expect(
      consumeOpenCodeWorkSyncLane({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'user-msg',
        foreground: true,
      })
    ).toBe('user_wins');
  });
});
