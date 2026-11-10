import { createAdmittedMemberWorkSyncStatusPort } from './createAdmittedMemberWorkSyncStatusPort';

import type { MemberWorkSyncUseCaseDeps } from '../../core/application';
import type { MemberWorkSyncTeamOperationAdmission } from '../../core/application/MemberWorkSyncTeamOperationGate';
import type { MemberWorkSyncStatusAuthority } from '../infrastructure/MemberWorkSyncStatusAuthority';

/** Request-scoped CAS binding. Never store admission on a singleton field. */
export function bindMemberWorkSyncUseCaseDeps(input: {
  base: MemberWorkSyncUseCaseDeps;
  teamName: string;
  admission: MemberWorkSyncTeamOperationAdmission;
  authority: MemberWorkSyncStatusAuthority;
  trackSettling?: (work: Promise<unknown>) => void;
}): MemberWorkSyncUseCaseDeps {
  return {
    ...input.base,
    statusMutations: createAdmittedMemberWorkSyncStatusPort({
      teamName: input.teamName,
      admission: input.admission,
      authority: input.authority,
      ...(input.trackSettling ? { trackSettling: input.trackSettling } : {}),
    }),
  };
}
