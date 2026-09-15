import {
  consumeOpenCodeWorkSyncLaneForSend,
  gateOpenCodeWorkSyncLaneDelivery,
} from '@features/member-work-sync/main/adapters/output/gateOpenCodeWorkSyncLaneDelivery';
import {
  applyOpenCodeWorkSyncLaneControl,
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

const ticketedInput = {
  teamName: 'team-a',
  memberName: 'bob',
  messageId: 'intent-c1',
  messageKind: 'member_work_sync_nudge',
  workSyncRuntimeTicketId: 'ticket-1',
};

describe('gateOpenCodeWorkSyncLaneDelivery', () => {
  afterEach(() => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
  });

  it('marks a ticketed nudge as consumed when the reservation is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    await expect(gateOpenCodeWorkSyncLaneDelivery(ticketedInput)).resolves.toMatchObject({
      reason: 'work_sync_ticket_consumed',
    });
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
    await expect(gateOpenCodeWorkSyncLaneDelivery(ticketedInput)).resolves.toMatchObject({
      reason: 'work_sync_ticket_consumed',
    });
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
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      true
    );
  });

  it('does not consume the reservation until send, then rejects a second send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        ...ticketedInput,
        workSyncRuntimeTicketId: 'ticket-other',
      })
    ).resolves.toMatchObject({ reason: 'work_sync_ticket_stale' });
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      true
    );
    const inspect = await gateOpenCodeWorkSyncLaneDelivery(ticketedInput);
    expect(inspect.reason).toBeUndefined();
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      true
    );
    expect(consumeOpenCodeWorkSyncLaneForSend(inspect, ticketedInput)).toEqual({});
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      false
    );
    const observe = await gateOpenCodeWorkSyncLaneDelivery(ticketedInput);
    expect(observe.reason).toBe('work_sync_ticket_consumed');
    expect(consumeOpenCodeWorkSyncLaneForSend(observe, ticketedInput)).toEqual({
      reason: 'work_sync_ticket_consumed',
    });
  });

  it('rejects ticketed send after Stop even if a reservation still exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    expect(hasOpenCodeWorkSyncLaneReservation({ teamName: 'team-a', memberName: 'bob' })).toBe(
      false
    );
    await expect(gateOpenCodeWorkSyncLaneDelivery(ticketedInput)).resolves.toMatchObject({
      reason: 'work_sync_ticket_consumed',
    });
  });

  it('rejects an unticketed D0 send after Stop even if inspect already passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 10,
        stopped: false,
      })
    ).toEqual({ ok: true, code: 'open', controlRevision: 10 });
    const inspect = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'd0-nudge',
      messageKind: 'member_work_sync_nudge',
      workSyncControlRevision: 10,
    });
    expect(inspect.reason).toBeUndefined();
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    expect(
      consumeOpenCodeWorkSyncLaneForSend(inspect, {
        messageKind: 'member_work_sync_nudge',
      })
    ).toEqual({ reason: 'work_sync_admission_stopped' });
  });

  it('still delivers a user DM after Stop of automatic continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    const userDm = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'user-dm',
      foreground: true,
    });
    expect(userDm.reason).toBeUndefined();
  });

  it('rejects an old D0 send after Stop then Resume even if inspect already passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 16,
        stopped: false,
      })
    ).toEqual({ ok: true, code: 'open', controlRevision: 16 });
    const inspect = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'd0-nudge',
      messageKind: 'member_work_sync_nudge',
      workSyncControlRevision: 16,
    });
    expect(inspect.reason).toBeUndefined();
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 17,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 17 });
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 18,
        stopped: false,
      })
    ).toEqual({ ok: true, code: 'open', controlRevision: 18 });
    expect(
      consumeOpenCodeWorkSyncLaneForSend(inspect, {
        messageKind: 'member_work_sync_nudge',
      })
    ).toEqual({ reason: 'work_sync_ticket_stale' });
    await expect(
      gateOpenCodeWorkSyncLaneDelivery({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'd0-nudge',
        messageKind: 'member_work_sync_nudge',
        workSyncControlRevision: 16,
      })
    ).resolves.toMatchObject({ reason: 'work_sync_ticket_stale' });
  });

  it('still admits a D0 at the live control revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 18,
        stopped: false,
      })
    ).toEqual({ ok: true, code: 'open', controlRevision: 18 });
    const inspect = await gateOpenCodeWorkSyncLaneDelivery({
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'd0-continue',
      messageKind: 'member_work_sync_nudge',
      workSyncControlRevision: 18,
    });
    expect(inspect.reason).toBeUndefined();
    expect(
      consumeOpenCodeWorkSyncLaneForSend(inspect, {
        messageKind: 'member_work_sync_nudge',
      })
    ).toEqual({});
  });

  it('keeps observe of an accepted ticket after Stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-gate-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    const inspect = await gateOpenCodeWorkSyncLaneDelivery(ticketedInput);
    expect(consumeOpenCodeWorkSyncLaneForSend(inspect, ticketedInput)).toEqual({});
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    await expect(gateOpenCodeWorkSyncLaneDelivery(ticketedInput)).resolves.toMatchObject({
      reason: 'work_sync_ticket_consumed',
    });
  });
});
