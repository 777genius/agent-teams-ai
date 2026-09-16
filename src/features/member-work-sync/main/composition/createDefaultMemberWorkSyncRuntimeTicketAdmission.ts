import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '../adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  applyOpenCodeWorkSyncLaneControl,
  bindOpenCodeWorkSyncLaneReservationRoot,
  cancelOpenCodeWorkSyncLane,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  readOpenCodeWorkSyncLaneControl,
  reserveOpenCodeWorkSyncLane,
} from '../adapters/output/OpenCodeWorkSyncLaneReservationStore';
import {
  readOpenCodeWorkSyncCurrentRuntimeInstanceId,
  sameOpenCodeWorkSyncRuntimeInstanceId,
} from '../adapters/output/readOpenCodeWorkSyncCurrentRuntimeInstanceId';

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
        const runtimeInstanceId =
          currentRuntimeInstanceId ?? request.runtimeInstanceId?.trim() ?? '';
        if (!runtimeInstanceId) {
          return { ok: false as const, code: 'unknown' as const };
        }
        if (
          currentRuntimeInstanceId &&
          request.runtimeInstanceId &&
          !sameOpenCodeWorkSyncRuntimeInstanceId(
            currentRuntimeInstanceId,
            request.runtimeInstanceId
          )
        ) {
          return { ok: false as const, code: 'instance_mismatch' as const };
        }
        return applyOpenCodeWorkSyncLaneControl({
          teamName: request.teamName,
          memberName: request.memberName,
          runtimeInstanceId: currentRuntimeInstanceId ?? runtimeInstanceId,
          controlRevision: request.controlRevision,
          stopped: request.stopped,
        });
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
