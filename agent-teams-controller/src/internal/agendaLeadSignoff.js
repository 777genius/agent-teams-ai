const reviewStateHelpers = require('./reviewState.js');

/** Fields that identify the open review cycle of an agenda item (empty when none is open). */
function reviewCycleFields(task, reviewState) {
  if (reviewState !== 'review') return {};
  const request = reviewStateHelpers.getCurrentReviewRequest(task);
  if (!request) return {};
  return {
    reviewStage: request.stage === 'lead_signoff' ? 'lead_signoff' : 'reviewer',
    ...(request.id ? { reviewRequestId: request.id } : {}),
  };
}

/** A task waiting for the Lead's own sign-off decision. */
function isLeadSignoffItem(item) {
  return item.reviewStage === 'lead_signoff' &&
    item.nextAction === 'review' && Boolean(item.actionOwner) && item.actionOwner.kind === 'lead';
}

/** Extra briefing lines that let the Lead act on a sign-off without any earlier message. */
function leadSignoffLineSuffix(item) {
  if (!isLeadSignoffItem(item) || !item.reviewRequestId) return '';
  return `\n  Sign-off: call review_start, then review_complete (or review_request_changes) with expectedReviewRequestId="${item.reviewRequestId}". Only the human gives final acceptance.`;
}

module.exports = { isLeadSignoffItem, leadSignoffLineSuffix, reviewCycleFields };
