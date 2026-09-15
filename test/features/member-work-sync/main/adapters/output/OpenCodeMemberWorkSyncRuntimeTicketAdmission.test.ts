import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '@features/member-work-sync/main/adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  bindOpenCodeWorkSyncLaneReservationRoot,
  cancelOpenCodeWorkSyncLane,
  consumeOpenCodeWorkSyncLane,
  hasOpenCodeWorkSyncLaneReservation,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  reserveOpenCodeWorkSyncLane,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';
import { readOpenCodeWorkSyncCurrentRuntimeInstanceId } from '@features/member-work-sync/main/adapters/output/readOpenCodeWorkSyncCurrentRuntimeInstanceId';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('OpenCode work-sync lane reservation', () => {
  it('reserves once and lets a matching inbox delivery consume without a second send token', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const admission = createOpenCodeMemberWorkSyncRuntimeTicketAdmission({
      reserve: async (ticket) => reserveOpenCodeWorkSyncLane(ticket),
      cancel: async (ticket) => {
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

  it('rejects a settlement identity that does not match the current lane', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const admission = createOpenCodeMemberWorkSyncRuntimeTicketAdmission({
      reserve: async () => ({ ok: true }),
      cancel: async () => undefined,
      readCurrentRuntimeInstanceId: () => 'opencode:lane-jack:ses-new',
    });
    await expect(
      admission.admit({
        teamName: 'team-a',
        memberName: 'bob',
        teamIncarnation: 'inc-1',
        intentId: 'intent-c1',
        admissionPayloadHash: 'hash-a',
        expectedGeneration: 3,
        runtimeInstanceId: 'opencode:lane-jack:ses-old',
        controlRevision: 1,
        providerId: 'opencode',
      })
    ).resolves.toEqual({ admitted: false, code: 'instance_mismatch' });
  });

  it('hydrates a durable OpenCode reservation after an in-memory restart', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const root = await mkdtemp(join(tmpdir(), 'opencode-lane-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
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
    expect(reserveOpenCodeWorkSyncLane(ticket)).toEqual({ ok: true });
    resetOpenCodeWorkSyncLaneReservationsForTests();
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    await expect(hydrateOpenCodeWorkSyncLaneReservation(ticket)).resolves.toBe(true);
    expect(peekOpenCodeWorkSyncLane(ticket)).toMatchObject({
      ticketId: 'ticket-1',
      runtimeInstanceId: 'opencode:lane-jack:ses-1',
    });
  });

  it('consumes a persisted OpenCode reservation after an in-memory restart', async () => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
    const root = await mkdtemp(join(tmpdir(), 'opencode-lane-'));
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      reserveOpenCodeWorkSyncLane({
        teamName: 'team-a',
        teamIncarnation: 'inc-1',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        expectedGeneration: 3,
        ticketId: 'ticket-1',
        intentId: 'intent-c1',
        controlRevision: 1,
        admissionPayloadHash: 'hash-a',
      })
    ).toEqual({ ok: true });
    resetOpenCodeWorkSyncLaneReservationsForTests();
    bindOpenCodeWorkSyncLaneReservationRoot(root);
    expect(
      consumeOpenCodeWorkSyncLane({
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'intent-c1',
      })
    ).toBe('consumed');
  });

  it('fences admission to the current OpenCode lane session on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-current-'));
    const laneDir = join(root, 'team-a', '.opencode-runtime', 'lanes', 'lane-jack');
    await mkdir(laneDir, { recursive: true });
    await writeFile(
      join(laneDir, 'opencode-sessions.json'),
      `${JSON.stringify({
        updatedAt: '2026-09-15T00:00:00.000Z',
        sessions: [
          {
            id: 'ses-new',
            teamName: 'team-a',
            memberName: 'bob',
            laneId: 'lane-jack',
          },
        ],
      })}\n`
    );
    await expect(
      readOpenCodeWorkSyncCurrentRuntimeInstanceId({
        teamsBasePath: root,
        teamName: 'team-a',
        memberName: 'bob',
      })
    ).resolves.toBe('opencode:lane-jack:ses-new');
  });
});
