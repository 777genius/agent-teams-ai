import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '../adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  bindOpenCodeWorkSyncLaneReservationRoot,
  cancelOpenCodeWorkSyncLane,
  hydrateOpenCodeWorkSyncLaneReservation,
  peekOpenCodeWorkSyncLane,
  reserveOpenCodeWorkSyncLane,
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
    }),
  });
}
