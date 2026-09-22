import type { MemberWorkSyncReconcileContext } from '../../core/application';

export function preferLaterMemberWorkSyncSettlement(
  current: MemberWorkSyncReconcileContext['settlement'],
  next: MemberWorkSyncReconcileContext['settlement']
): MemberWorkSyncReconcileContext['settlement'] {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  return Date.parse(next.recordedAt) >= Date.parse(current.recordedAt) ? next : current;
}
