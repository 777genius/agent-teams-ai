import { gateOpenCodeWorkSyncLaneDelivery } from '@features/member-work-sync/main/adapters/output/gateOpenCodeWorkSyncLaneDelivery';
import {
  bindOpenCodeWorkSyncLaneReservationRoot,
  hasOpenCodeWorkSyncLaneReservation,
  reserveOpenCodeWorkSyncLane,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const ticket = {
  teamName: 'team-a',
  teamIncarnation: 'inc-1',
  memberName: 'bob',
  runtimeInstanceId: 'opencode:lane-jack:ses-1',
  expectedGeneration: 3,
  ticketId: 'ticket-1',
  intentId: 'intent-c1',
  controlRevision: 1,
  admissionPayloadHash: 'hash-a',
};

describe('gateOpenCodeWorkSyncLaneDelivery', () => {
  afterEach(() => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
  });

  it('rejects a ticketed nudge when the reservation is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'intent-c1',
        messageKind: 'member_work_sync_nudge',
        workSyncRuntimeTicketId: 'ticket-1',
      })
    ).resolves.toMatchObject({ reason: 'work_sync_ticket_stale' });
  });

  it('rejects a ticketed nudge after cancel or user-wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    const userWins = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'user-msg',
      foreground: true,
    });
    expect(userWins.reason).toBeUndefined();
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      false
    );
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'intent-c1',
        messageKind: 'member_work_sync_nudge',
        workSyncRuntimeTicketId: 'ticket-1',
      })
    ).resolves.toMatchObject({ reason: 'work_sync_ticket_stale' });
  });

  it('rejects an unticketed D0 nudge while a reservation exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'd0-nudge',
        messageKind: 'member_work_sync_nudge',
      })
    ).resolves.toMatchObject({ reason: 'work_sync_lane_reserved' });
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(true);
  });

  it('consumes only the exact reserved ticket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'intent-c1',
        messageKind: 'member_work_sync_nudge',
        workSyncRuntimeTicketId: 'ticket-other',
      })
    ).resolves.toMatchObject({ reason: 'work_sync_ticket_stale' });
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(true);
    const consumed = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'intent-c1',
      messageKind: 'member_work_sync_nudge',
      workSyncRuntimeTicketId: 'ticket-1',
    });
    expect(consumed.reason).toBeUndefined();
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      false
    );
  });
});
