import type { MemberWorkSyncStatus } from '../../contracts';

export function isStrictReviewPickupItem(
  item: MemberWorkSyncStatus['agenda']['items'][number]
): boolean {
  return (
    item.kind === 'review' &&
    item.evidence.reviewObligation === 'review_pickup_required' &&
    item.evidence.canBypassDeliveryReadiness === true &&
    typeof item.evidence.reviewRequestEventId === 'string' &&
    item.evidence.reviewRequestEventId.length > 0 &&
    (item.evidence.reviewDiagnostics?.length ?? 0) === 0
  );
}

export function isReviewPickupAgenda(status: MemberWorkSyncStatus): boolean {
  return status.agenda.items.length > 0 && status.agenda.items.every(isStrictReviewPickupItem);
}
