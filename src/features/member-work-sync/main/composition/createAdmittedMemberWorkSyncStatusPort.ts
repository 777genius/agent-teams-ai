import { randomUUID } from 'node:crypto';

import { normalizeMemberWorkSyncTeamOperationKey } from '../../core/application/MemberWorkSyncTeamOperationGate';

import type { MemberWorkSyncConditionalStatusPort } from '../../core/application/MemberWorkSyncConditionalStatusPort';
import type { MemberWorkSyncTeamOperationAdmission } from '../../core/application/MemberWorkSyncTeamOperationGate';
import type {
  MemberWorkSyncPhysicalCall,
  MemberWorkSyncStatusAuthority,
} from '../infrastructure/MemberWorkSyncStatusAuthority';

/** Request-scoped binding: descendants inherit this port, never a mutable current admission. */
export function createAdmittedMemberWorkSyncStatusPort(input: {
  teamName: string;
  authority: Pick<MemberWorkSyncStatusAuthority, 'startRead' | 'startCompareAndWrite'>;
  admission: MemberWorkSyncTeamOperationAdmission;
  trackSettling?: (work: Promise<unknown>) => void;
}): MemberWorkSyncConditionalStatusPort {
  const teamKey = normalizeMemberWorkSyncTeamOperationKey(input.teamName);
  const owns = (teamName: string): boolean => teamName.trim().toLowerCase() === teamKey;
  const track = <T>(call: MemberWorkSyncPhysicalCall<T>): Promise<T> => {
    // Authority defers effects by a microtask. Both owners receive the same physical promise
    // synchronously, before result can resolve (including early commit_unknown).
    input.admission.trackSettling(call.settled);
    input.trackSettling?.(call.settled);
    return call.result;
  };
  return {
    createMutationId: () => randomUUID(),
    readSnapshot: (request) =>
      owns(request.teamName)
        ? track(input.authority.startRead(request))
        : Promise.resolve({ ok: false, reason: 'invalid_token' }),
    compareAndWrite: (request) =>
      owns(request.teamName)
        ? track(input.authority.startCompareAndWrite(request))
        : Promise.resolve({ committed: false, reason: 'invalid_token' }),
  };
}
