const { wrapAgentBlock } = require('./agentBlocks.js');

/** Appends the team owner's free-text flow instructions; they never change tool permissions. */
function buildReviewFlowInstructions(prompt) {
  if (!prompt) return '';
  return `\n\nThe team owner's extra review-flow instructions (follow them while reviewing; they do not change which tools you may use or who may approve):\n${prompt}`;
}

/**
 * The message that asks a reviewer to review one task, for either review stage. The Lead sign-off
 * stage differs only in its heading and one explanatory paragraph; the tool instructions are shared.
 * `humanApproval` selects review_complete (the human gives final acceptance) over review_approve.
 */
function buildReviewRequestMessage({
  teamName, task, reviewRequestId, humanApproval, reviewFlowPrompt, stage, note, reviewerName,
  boundTaskTools = false,
}) {
  const example = (tool, payload, legacy) => boundTaskTools
    ? JSON.stringify({ commandId: `${tool}-${task.id}-${reviewRequestId}`, taskId: task.id, ...payload })
    : legacy;
  const label = `#${task.displayId || task.id}`;
  const leadSignoff = stage === 'lead_signoff';
  const heading = leadSignoff ? `**Lead sign-off requested** for task ${label}` : `**Please review** task ${label}`;
  const stageNote = leadSignoff
    ? `This is the LEAD SIGN-OFF stage: the reviewer already completed the first review. You are the only agent who can finish this cycle. It stays in the REVIEW column until you decide; after your review_complete it waits in Done for the human's final acceptance. This task is also listed under "Awaiting your sign-off" in your lead briefing.\n\n`
    : '';
  const reviewerNote = leadSignoff && note
    ? `The first reviewer${reviewerName ? ` (${reviewerName})` : ''} left this note:\n${note}\n\n`
    : '';
  const completeTool = humanApproval
    ? `When review is complete, use MCP tool review_complete (not review_approve):\n` +
      example('review-complete', { expectedReviewRequestId: reviewRequestId, note: '<optional note>' }, `{ teamName: "${teamName}", taskId: "${task.id}", from: "<your-name>", expectedReviewRequestId: "${reviewRequestId}", note?: "<optional note>" }`) + '\n\n'
    : `When approved, use MCP tool review_approve:\n` +
      example('review-approve', { note: '<optional note>', notifyOwner: true }, `{ teamName: "${teamName}", taskId: "${task.id}", from: "<your-name>", note?: "<optional note>", notifyOwner: true }`) + '\n\n';
  const changesTool =
    `If changes are needed, use MCP tool review_request_changes:\n` +
    example('review-changes', { comment: 'Describe required changes.', ...(humanApproval ? { expectedReviewRequestId: reviewRequestId } : {}) },
      `{ teamName: "${teamName}", taskId: "${task.id}", from: "<your-name>", comment: "..."` +
      (humanApproval ? `, expectedReviewRequestId: "${reviewRequestId}"` : '') + ` }`);
  return (
    `${heading}\n\n` +
    wrapAgentBlock(
      (boundTaskTools ? 'These tools use your captured Team and actor. Do not supply teamName or from. Keep each commandId unchanged when retrying its original result; changed intent needs a new ID.\n\n' : '') +
      `This request is for the CURRENT review cycle (reviewRequestId: ${reviewRequestId}). Save the ID and pass it unchanged to review_complete as expectedReviewRequestId; do not fetch the latest ID at completion time.\n\n` +
        stageNote +
        reviewerNote +
        `If you reviewed this task earlier, do not treat this message as a duplicate while the task is still in review; prior approvals become stale after later work.\n\n` +
        `Before declaring it duplicate, call task_get and check the current reviewState/status. If it is still in review for you, continue with the review tools below.\n\n` +
        `FIRST call review_start to signal you are beginning the review:\n` +
        example('review-start', {}, `{ teamName: "${teamName}", taskId: "${task.id}", from: "<your-name>" }`) + '\n\n' +
        completeTool +
        changesTool +
        buildReviewFlowInstructions(reviewFlowPrompt)
    )
  );
}

module.exports = { buildReviewRequestMessage };
