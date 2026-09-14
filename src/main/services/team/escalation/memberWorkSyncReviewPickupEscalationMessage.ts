import { createHash } from 'crypto';

export function buildMemberWorkSyncReviewPickupEscalationMessageId(input: {
  teamName: string;
  memberName: string;
  reason: string;
  reviewRequestEventIds?: readonly string[];
  taskRefs: readonly { taskId: string; displayId?: string }[];
}): string {
  const stableKey = JSON.stringify({
    teamName: input.teamName,
    memberName: input.memberName.trim().toLowerCase(),
    reason: input.reason,
    reviewRequestEventIds: [...new Set(input.reviewRequestEventIds ?? [])].sort(),
    taskIds: [...new Set(input.taskRefs.map((taskRef) => taskRef.taskId).filter(Boolean))].sort(),
  });
  const digest = createHash('sha256').update(stableKey).digest('hex').slice(0, 20);
  return `member-work-sync-review-pickup-escalation:${digest}`;
}

export function buildMemberWorkSyncReviewPickupEscalationText(input: {
  memberName: string;
  reason: string;
  diagnostics?: readonly string[];
  taskRefs: readonly { taskId: string; displayId?: string }[];
}): string {
  const taskLines = input.taskRefs.length
    ? input.taskRefs
        .map((taskRef) => `- ${taskRef.displayId ?? taskRef.taskId.slice(0, 8)}`)
        .join('\n')
    : '- No task refs recorded';
  const reasonText = describeMemberWorkSyncReviewPickupEscalationReason(input.reason);
  return [
    'Review pickup needs lead attention.',
    '',
    `Reviewer: ${input.memberName}`,
    reasonText,
    '',
    'Tasks:',
    taskLines,
    '',
    'No review_start, review_approve, or review_request_changes was recorded for the current review request.',
    'Consider reassigning the reviewer or sending a direct instruction.',
  ]
    .filter(Boolean)
    .join('\n');
}

function describeMemberWorkSyncReviewPickupEscalationReason(reason: string): string {
  if (reason.startsWith('provider_not_supported:')) {
    return 'Direct review-pickup wake is not available for this member runtime, so the lead needs to handle the stuck review.';
  }
  if (reason === 'review_pickup_already_delivered_still_stuck') {
    return 'A review-pickup reminder was delivered, but the review is still waiting for a review tool action.';
  }
  if (reason === 'review_pickup_delivery_failed_still_stuck') {
    return 'The review-pickup reminder could not be delivered reliably, and the review is still waiting.';
  }
  if (reason.includes('delivery_port_unavailable')) {
    return 'No reliable review-pickup delivery path is available for this member runtime.';
  }
  return 'The current review request is still waiting for explicit review pickup.';
}
