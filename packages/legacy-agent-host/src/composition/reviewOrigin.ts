import type {
  ReviewWriterRequest,
  ReviewOriginScope,
} from '@agent-teams/task-change-ledger/review-transport';

/** Cross-checks the immutable originating view against every existing identity-bearing DTO. */
export function assertReviewOrigin(request: ReviewWriterRequest, origin: ReviewOriginScope): void {
  if (!origin || (!origin.taskId && !origin.memberName))
    throw new Error('Review origin is required');
  for (const value of [origin.taskId, origin.memberName])
    if (
      value !== undefined &&
      (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0'))
    )
      throw new Error('Invalid review origin');
  const check = (scope: ReviewOriginScope) => {
    if (
      scope.taskId !== origin.taskId ||
      (scope.memberName && scope.memberName !== origin.memberName)
    )
      throw new Error('Review scope differs from originating view');
  };
  switch (request.method) {
    case 'checkConflict':
    case 'rejectHunks':
    case 'rejectFile':
    case 'saveEditedFile':
    case 'deleteEditedFile':
    case 'restoreRejectedRename':
    case 'reapplyRejectedRename':
      check(request.args[0]);
      return;
    case 'applyDecisions':
      check(request.args[0]);
      return;
    case 'executeReviewMutation':
    case 'restoreReviewHistory':
    case 'retryReviewMutationRecovery':
      check(request.args[0].scope);
      return;
    case 'getFileContent':
      if (request.args[1] && request.args[1] !== origin.memberName)
        throw new Error('Review member differs from originating view');
      return;
    case 'previewReject':
      return;
    default: {
      const expected = origin.taskId ? `task-${origin.taskId}` : `agent-${origin.memberName}`;
      if (request.args[1] !== expected)
        throw new Error('Review persistence scope differs from originating view');
    }
  }
}
