import type { MemberWorkSyncRuntimeTicketAdmissionPort } from '../../core/application';

/**
 * Protocol-2 desktop gate when the live runtime has not advertised
 * ticket/generation admission. `not_early` falls through to ordinary D0.
 */
export function createUnsupportedMemberWorkSyncRuntimeTicketAdmission(): MemberWorkSyncRuntimeTicketAdmissionPort {
  return {
    admit: async () => ({ admitted: false, code: 'not_early' }),
  };
}
