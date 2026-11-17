import { MemberWorkSyncStatusDecodeError } from './decodeMemberWorkSyncStoredStatus';

/**
 * A stored status was written under another lifecycle identity of the same-named team
 * (recreated or restored without a purge). Authority preparation runs inside the lifecycle
 * fence, so the requested incarnation is the current one and the stored rows are stale.
 */
export function isStaleIncarnationError(error: unknown): error is MemberWorkSyncStatusDecodeError {
  return (
    error instanceof MemberWorkSyncStatusDecodeError && error.reason === 'incarnation_mismatch'
  );
}
