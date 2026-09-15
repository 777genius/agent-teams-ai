import type {
  MemberWorkSyncRuntimeTicket,
  MemberWorkSyncRuntimeTicketAdmissionPort,
} from '../../../core/application';

/**
 * OpenCode D1 admission reserves the existing delivery lane without sending a
 * second prompt. Consume/send stays on the inbox wake path after persist.
 */
export function createOpenCodeMemberWorkSyncRuntimeTicketAdmission(input: {
  reserve: (
    ticket: MemberWorkSyncRuntimeTicket
  ) => Promise<{ ok: true } | { ok: false; code: 'busy' | 'user_input' | 'unknown' }>;
  cancel: (ticket: MemberWorkSyncRuntimeTicket) => Promise<void>;
  isForegroundBusy?: (input: {
    teamName: string;
    memberName: string;
  }) => Promise<boolean> | boolean;
  readCurrentRuntimeInstanceId?: (input: {
    teamName: string;
    memberName: string;
  }) => Promise<string | null> | string | null;
  confirmReserved?: MemberWorkSyncRuntimeTicketAdmissionPort['confirmReserved'];
}): MemberWorkSyncRuntimeTicketAdmissionPort {
  return {
    async admit(request) {
      if (request.providerId !== 'opencode') {
        return { admitted: false, code: 'not_early' };
      }
      const currentRuntimeInstanceId = await input.readCurrentRuntimeInstanceId?.({
        teamName: request.teamName,
        memberName: request.memberName,
      });
      if (
        currentRuntimeInstanceId &&
        request.runtimeInstanceId &&
        currentRuntimeInstanceId !== request.runtimeInstanceId
      ) {
        return { admitted: false, code: 'instance_mismatch' };
      }
      const ticket: MemberWorkSyncRuntimeTicket = {
        teamName: request.teamName,
        teamIncarnation: request.teamIncarnation,
        memberName: request.memberName,
        runtimeInstanceId: request.runtimeInstanceId ?? currentRuntimeInstanceId ?? 'opencode-lane',
        expectedGeneration: request.expectedGeneration,
        ticketId: `${request.intentId}:${request.expectedGeneration}`,
        intentId: request.intentId,
        controlRevision: request.controlRevision,
        admissionPayloadHash: request.admissionPayloadHash,
      };
      if (
        await input.isForegroundBusy?.({
          teamName: request.teamName,
          memberName: request.memberName,
        })
      ) {
        return { admitted: false, code: 'user_input' };
      }
      const reserved = await input.reserve(ticket);
      if (!reserved.ok) {
        return { admitted: false, code: reserved.code };
      }
      return { admitted: true, ticket };
    },
    cancel: (ticket) => input.cancel(ticket),
    ...(input.confirmReserved ? { confirmReserved: input.confirmReserved } : {}),
  };
}
