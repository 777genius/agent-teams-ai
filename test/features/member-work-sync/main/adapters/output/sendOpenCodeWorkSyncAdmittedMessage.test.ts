import { gateOpenCodeWorkSyncLaneDelivery } from '@features/member-work-sync/main/adapters/output/gateOpenCodeWorkSyncLaneDelivery';
import {
  applyOpenCodeWorkSyncLaneControl,
  bindOpenCodeWorkSyncLaneReservationRoot,
  reserveOpenCodeWorkSyncLane,
  resetOpenCodeWorkSyncLaneReservationsForTests,
} from '@features/member-work-sync/main/adapters/output/OpenCodeWorkSyncLaneReservationStore';
import { sendOpenCodeWorkSyncAdmittedMessage } from '@features/member-work-sync/main/adapters/output/sendOpenCodeWorkSyncAdmittedMessage';
import { OpenCodeMemberSendSerializer } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberSendSerialization';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { OpenCodeTeamRuntimeMessageResult } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sendOpenCodeWorkSyncAdmittedMessage', () => {
  afterEach(() => {
    resetOpenCodeWorkSyncLaneReservationsForTests();
  });

  it('does not send a ticketed nudge after Stop while the lane serializer is waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-send-admit-'));
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
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 1,
        stopped: false,
      })
    ).toEqual({ ok: true, code: 'open', controlRevision: 1 });
    const hold = deferred();
    const inFlight = new Map<string, Promise<OpenCodeTeamRuntimeMessageResult>>();
    const serializer = new OpenCodeMemberSendSerializer({
      inFlightByLane: inFlight,
    });
    const okResult = (
      memberName: string
    ): OpenCodeTeamRuntimeMessageResult => ({
      ok: true,
      providerId: 'opencode',
      memberName,
      diagnostics: [],
    });
    const first = serializer.sendSerialized({
      teamName: 'team-a',
      laneId: 'lane-jack',
      send: async () => {
        await hold.promise;
        return okResult('hold');
      },
    });
    const ticketed = {
      teamName: 'team-a',
      memberName: 'bob',
      messageId: 'intent-c1',
      messageKind: 'member_work_sync_nudge',
      workSyncRuntimeTicketId: 'ticket-1',
    };
    const lane = await gateOpenCodeWorkSyncLaneDelivery(ticketed);
    let sends = 0;
    const pending = sendOpenCodeWorkSyncAdmittedMessage({
      lane,
      message: ticketed,
      restore: lane.restore,
      checkpoint: async () => undefined,
      serialize: (send) =>
        serializer.sendSerialized({
          teamName: 'team-a',
          laneId: 'lane-jack',
          send,
        }),
      sendMessage: async () => {
        sends += 1;
        return okResult('bob');
      },
    });
    await Promise.resolve();
    expect(
      applyOpenCodeWorkSyncLaneControl({
        teamName: 'team-a',
        memberName: 'bob',
        runtimeInstanceId: 'opencode:lane-jack:ses-1',
        controlRevision: 11,
        stopped: true,
      })
    ).toEqual({ ok: true, code: 'closed', controlRevision: 11 });
    hold.resolve();
    await first;
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'work_sync_admission_stopped',
    });
    expect(sends).toBe(0);
  });
});
