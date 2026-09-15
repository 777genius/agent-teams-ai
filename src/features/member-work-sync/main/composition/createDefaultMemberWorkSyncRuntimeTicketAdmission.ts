import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '../adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  bindOpenCodeWorkSyncLaneReservationRoot,
  cancelOpenCodeWorkSyncLane,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  readOpenCodeWorkSyncLaneControl,
  reserveOpenCodeWorkSyncLane,
  writeOpenCodeWorkSyncLaneControl,
} from '../adapters/output/OpenCodeWorkSyncLaneReservationStore';
import { readOpenCodeWorkSyncCurrentRuntimeInstanceId } from '../adapters/output/readOpenCodeWorkSyncCurrentRuntimeInstanceId';

import { createMemberWorkSyncRuntimeTicketAdmissionRouter } from './createMemberWorkSyncRuntimeTicketAdmissionRouter';

import type { MemberWorkSyncRuntimeTicketAdmissionPort } from '../../core/application';

export function createDefaultMemberWorkSyncRuntimeTicketAdmission(
  teamsBasePath: string
): MemberWorkSyncRuntimeTicketAdmissionPort {
  bindOpenCodeWorkSyncLaneReservationRoot(teamsBasePath);
  return createMemberWorkSyncRuntimeTicketAdmissionRouter({
    teamsBasePath,
    opencodeAdmission: createOpenCodeMemberWorkSyncRuntimeTicketAdmission({
      reserve: async (ticket) => reserveOpenCodeWorkSyncLane(ticket),
      cancel: async (ticket) => {
        cancelOpenCodeWorkSyncLane(ticket);
      },
      readCurrentRuntimeInstanceId: ({ teamName, memberName }) =>
        readOpenCodeWorkSyncCurrentRuntimeInstanceId({
          teamsBasePath,
          teamName,
          memberName,
        }),
      confirmReserved: async (ticket) => {
        await hydrateOpenCodeWorkSyncLaneReservation(ticket);
        const existing = peekOpenCodeWorkSyncLane(ticket);
        if (
          !existing ||
          existing.ticketId !== ticket.ticketId ||
          existing.intentId !== ticket.intentId ||
          existing.runtimeInstanceId !== ticket.runtimeInstanceId
        ) {
          return { ok: false as const, code: 'stale' as const };
        }
        return { ok: true as const };
      },
      syncControl: async (request) => {
        const currentRuntimeInstanceId = await readOpenCodeWorkSyncCurrentRuntimeInstanceId({
          teamsBasePath,
          teamName: request.teamName,
          memberName: request.memberName,
        });
        if (!currentRuntimeInstanceId) {
          return { ok: false as const, code: 'unknown' as const };
        }
        if (request.runtimeInstanceId && request.runtimeInstanceId !== currentRuntimeInstanceId) {
          return { ok: false as const, code: 'instance_mismatch' as const };
        }
        writeOpenCodeWorkSyncLaneControl({
          teamName: request.teamName,
          memberName: request.memberName,
          control: {
            runtimeInstanceId: currentRuntimeInstanceId,
            controlRevision: request.controlRevision,
            stopped: request.stopped,
            handshakeCompleted: true,
          },
        });
        return {
          ok: true as const,
          code: request.stopped ? ('closed' as const) : ('open' as const),
          controlRevision: request.controlRevision,
        };
      },
      readLiveControl: async ({ teamName, memberName }) => {
        const control = readOpenCodeWorkSyncLaneControl({ teamName, memberName });
        if (!control) {
          return null;
        }
        return {
          runtimeInstanceId: control.runtimeInstanceId,
          controlRevision: control.controlRevision,
          stopped: control.stopped,
          handshakeCompleted: true,
        };
      },
    }),
  });
}
