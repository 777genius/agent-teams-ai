import type { SendMessageResult } from '@shared/types';

export interface OpenCodeRuntimeDeliveryDebugDetails {
  messageId: string;
  statusMessageId?: string;
  providerId: string;
  delivered: boolean | null;
  accepted?: boolean | null;
  responsePending: boolean | null;
  responseState: string | null;
  ledgerStatus: string | null;
  ledgerRecordId?: string | null;
  laneId?: string | null;
  visibleReplyMessageId?: string | null;
  visibleReplyCorrelation?: string | null;
  queuedBehindMessageId?: string | null;
  acceptanceUnknown: boolean | null;
  reason: string | null;
  diagnostics: string[];
  userVisibleState?: string | null;
  userVisibleReasonCode?: string | null;
  userVisibleMessage?: string | null;
  userVisibleNextReviewAt?: string | null;
}

interface OpenCodeRuntimeDeliveryDiagnostics {
  warning: string | null;
  debugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
}

const PENDING_WARNING =
  'OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.';
const PROOF_WARNING =
  'OpenCode reply could not be verified. Message was saved to inbox, but no visible reply or task progress proof was found.';
const FAILED_WARNING =
  'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.';
const ATTACHMENT_FAILED_WARNING =
  'OpenCode attachment was not sent. Message was saved to inbox, but live delivery cannot include this attachment.';
const OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE =
  'OpenCode bridge outcome unknown after timeout, retrying/observing.';

function isOpenCodeAttachmentDeliveryFailureReason(reason: string | null | undefined): boolean {
  const normalized = reason?.trim().toLowerCase();
  return (
    normalized === 'opencode_attachment_delivery_prepare_failed' ||
    normalized?.startsWith('attachment_') === true ||
    normalized?.startsWith('opencode_attachment_delivery_prepare_failed:') === true
  );
}

function formatOpenCodeRuntimeDeliveryFailureReason(reason: string | null | undefined): string {
  const normalized = reason?.trim();
  if (!normalized) {
    return '';
  }
  const normalizedLower = normalized.toLowerCase();
  if (normalizedLower === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (normalizedLower === 'prompt_delivered_no_assistant_message') {
    return 'OpenCode accepted the prompt, but no assistant turn was recorded.';
  }
  if (normalizedLower === 'opencode_prompt_acceptance_unknown_after_bridge_timeout') {
    return OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE;
  }
  if (
    normalizedLower === 'visible_reply_still_required' ||
    normalizedLower === 'visible_reply_ack_only_still_requires_answer' ||
    normalizedLower === 'plain_text_ack_only_still_requires_answer'
  ) {
    return 'OpenCode responded, but did not create a visible message_send reply.';
  }
  if (
    normalizedLower === 'visible_reply_destination_not_found_yet' ||
    normalizedLower === 'visible_reply_missing_relayofmessageid'
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (normalizedLower === 'visible_reply_missing_task_refs') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (normalizedLower === 'visible_reply_missing_task_refs_after_merge') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (normalizedLower === 'visible_reply_task_refs_merge_failed') {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (normalizedLower === 'non_visible_tool_without_task_progress') {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
  }
  if (normalizedLower === 'attachment_model_unsupported') {
    return 'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.';
  }
  if (normalizedLower === 'attachment_type_unsupported') {
    return 'This OpenCode model cannot receive this attachment type. Remove the attachment or choose a supported image model.';
  }
  if (normalizedLower === 'attachment_too_large') {
    return 'The attachment is too large for live OpenCode delivery. Reduce the image size or remove the attachment.';
  }
  if (
    normalizedLower === 'attachment_artifact_missing' ||
    normalizedLower === 'attachment_artifact_path_unsafe'
  ) {
    return 'The attachment file is not available for live OpenCode delivery. Reattach the file and try again.';
  }
  if (normalizedLower === 'attachment_optimization_failed') {
    return 'The attachment could not be optimized for live OpenCode delivery. Try a smaller image or remove the attachment.';
  }
  if (normalizedLower === 'attachment_provider_rejected') {
    return 'The OpenCode provider rejected the attachment. Choose a different model or remove the attachment.';
  }
  if (normalizedLower === 'attachment_runtime_transport_failed') {
    return 'OpenCode could not transport the attachment to the runtime. Try again or remove the attachment.';
  }
  if (normalizedLower.startsWith('opencode_attachment_delivery_prepare_failed:')) {
    return normalized.slice('opencode_attachment_delivery_prepare_failed:'.length).trim();
  }
  return '';
}

export function buildOpenCodeRuntimeDeliveryDiagnostics(
  result: SendMessageResult
): OpenCodeRuntimeDeliveryDiagnostics {
  const runtimeDelivery = result.runtimeDelivery;
  if (runtimeDelivery?.attempted !== true) {
    return { warning: null, debugDetails: null };
  }

  const userVisibleState = runtimeDelivery.userVisibleImpact?.state;
  const isFailed =
    userVisibleState === 'error' || (!userVisibleState && runtimeDelivery.delivered === false);
  const isWarning = userVisibleState === 'warning';
  const isPending =
    userVisibleState === 'checking' ||
    (!userVisibleState && runtimeDelivery.responsePending === true);
  if (!isFailed && !isPending) {
    if (!isWarning) {
      return { warning: null, debugDetails: null };
    }
  }

  const userVisibleMessage = runtimeDelivery.userVisibleImpact?.message?.trim();
  const candidateFailureReason =
    userVisibleMessage ?? runtimeDelivery.reason ?? runtimeDelivery.diagnostics?.[0];
  const mappedFailureReason =
    isFailed || isWarning ? formatOpenCodeRuntimeDeliveryFailureReason(candidateFailureReason) : '';
  const failureReason = mappedFailureReason || (isFailed || isWarning ? userVisibleMessage : '');
  const isAttachmentFailure =
    isFailed &&
    (isOpenCodeAttachmentDeliveryFailureReason(runtimeDelivery.reason) ||
      isOpenCodeAttachmentDeliveryFailureReason(runtimeDelivery.diagnostics?.[0]) ||
      isOpenCodeAttachmentDeliveryFailureReason(candidateFailureReason));
  const statusMessageId = runtimeDelivery.queuedBehindMessageId ?? result.messageId;

  return {
    warning:
      isWarning && failureReason
        ? `${PROOF_WARNING} Reason: ${failureReason}`
        : isWarning
          ? PROOF_WARNING
          : isAttachmentFailure && failureReason
            ? `${ATTACHMENT_FAILED_WARNING} Reason: ${failureReason}`
            : isAttachmentFailure
              ? ATTACHMENT_FAILED_WARNING
              : isFailed && failureReason
                ? `${FAILED_WARNING} Reason: ${failureReason}`
                : isFailed
                  ? FAILED_WARNING
                  : PENDING_WARNING,
    debugDetails: {
      messageId: result.messageId,
      statusMessageId,
      providerId: runtimeDelivery.providerId,
      delivered: typeof runtimeDelivery.delivered === 'boolean' ? runtimeDelivery.delivered : null,
      accepted: typeof runtimeDelivery.accepted === 'boolean' ? runtimeDelivery.accepted : null,
      responsePending:
        typeof runtimeDelivery.responsePending === 'boolean'
          ? runtimeDelivery.responsePending
          : null,
      responseState: runtimeDelivery.responseState ?? null,
      ledgerStatus: runtimeDelivery.ledgerStatus ?? null,
      ledgerRecordId: runtimeDelivery.ledgerRecordId ?? null,
      laneId: runtimeDelivery.laneId ?? null,
      visibleReplyMessageId: runtimeDelivery.visibleReplyMessageId ?? null,
      visibleReplyCorrelation: runtimeDelivery.visibleReplyCorrelation ?? null,
      queuedBehindMessageId: runtimeDelivery.queuedBehindMessageId ?? null,
      acceptanceUnknown:
        typeof runtimeDelivery.acceptanceUnknown === 'boolean'
          ? runtimeDelivery.acceptanceUnknown
          : null,
      reason: runtimeDelivery.reason ?? null,
      diagnostics: runtimeDelivery.diagnostics ?? [],
      userVisibleState: runtimeDelivery.userVisibleImpact?.state ?? null,
      userVisibleReasonCode: runtimeDelivery.userVisibleImpact?.reasonCode ?? null,
      userVisibleMessage: runtimeDelivery.userVisibleImpact?.message ?? null,
      userVisibleNextReviewAt: runtimeDelivery.userVisibleImpact?.nextReviewAt ?? null,
    },
  };
}

export function isOpenCodeRuntimeDeliveryHardUxFailure(
  runtimeDelivery: SendMessageResult['runtimeDelivery'] | null | undefined
): boolean {
  if (runtimeDelivery?.attempted !== true) {
    return false;
  }
  const userVisibleState = runtimeDelivery.userVisibleImpact?.state;
  if (userVisibleState) {
    return userVisibleState === 'error';
  }
  return runtimeDelivery.delivered === false;
}

export function isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails(
  details: OpenCodeRuntimeDeliveryDebugDetails | null | undefined
): boolean {
  if (!details) {
    return false;
  }
  if (details.userVisibleState) {
    return details.userVisibleState === 'error';
  }
  return details.delivered === false;
}

export function shouldClearPendingReplyForOpenCodeRuntimeDelivery(
  runtimeDelivery: SendMessageResult['runtimeDelivery'] | null | undefined
): boolean {
  if (runtimeDelivery?.attempted !== true) {
    return false;
  }
  const userVisibleState = runtimeDelivery.userVisibleImpact?.state;
  if (userVisibleState === 'none') {
    return true;
  }
  if (userVisibleState === 'warning' || userVisibleState === 'error') {
    return true;
  }
  if (userVisibleState === 'checking') {
    return false;
  }
  return runtimeDelivery.responsePending !== true;
}

export function formatOpenCodeRuntimeDeliveryDebugDetails(
  details: OpenCodeRuntimeDeliveryDebugDetails
): string {
  return JSON.stringify(
    {
      messageId: details.messageId,
      statusMessageId: details.statusMessageId,
      providerId: details.providerId,
      delivered: details.delivered,
      accepted: details.accepted,
      responsePending: details.responsePending,
      responseState: details.responseState,
      ledgerStatus: details.ledgerStatus,
      ledgerRecordId: details.ledgerRecordId,
      laneId: details.laneId,
      visibleReplyMessageId: details.visibleReplyMessageId,
      visibleReplyCorrelation: details.visibleReplyCorrelation,
      queuedBehindMessageId: details.queuedBehindMessageId,
      acceptanceUnknown: details.acceptanceUnknown,
      reason: details.reason,
      diagnostics: details.diagnostics,
      userVisibleState: details.userVisibleState,
      userVisibleReasonCode: details.userVisibleReasonCode,
      userVisibleMessage: details.userVisibleMessage,
      userVisibleNextReviewAt: details.userVisibleNextReviewAt,
    },
    null,
    2
  );
}
