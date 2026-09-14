import { createOpenCodeMemberWorkSyncRuntimeTicketAdmission } from '../adapters/output/OpenCodeMemberWorkSyncRuntimeTicketAdmission';
import {
  cancelOpenCodeWorkSyncLane,
  reserveOpenCodeWorkSyncLane,
} from '../adapters/output/OpenCodeWorkSyncLaneReservationStore';

import { createMemberWorkSyncRuntimeTicketAdmissionRouter } from './createMemberWorkSyncRuntimeTicketAdmissionRouter';

import type { MemberWorkSyncRuntimeTicketAdmissionPort } from '../../core/application';

export function createDefaultMemberWorkSyncRuntimeTicketAdmission(
  teamsBasePath: string
): MemberWorkSyncRuntimeTicketAdmissionPort {
  return createMemberWorkSyncRuntimeTicketAdmissionRouter({
    teamsBasePath,
    opencodeAdmission: createOpenCodeMemberWorkSyncRuntimeTicketAdmission({
      reserve: async (ticket) => reserveOpenCodeWorkSyncLane(ticket),
      cancel: async (ticket) => {
        cancelOpenCodeWorkSyncLane(ticket);
      },
    }),
  });
}
