import type { SendMessageResult } from '@shared/types';

export interface OpenCodeRuntimeDeliveryDebugDetails {
  messageId: string;
  providerId: string;
  delivered: boolean | null;
  responsePending: boolean | null;
  responseState: string | null;
  ledgerStatus: string | null;
  acceptanceUnknown: boolean | null;
  reason: string | null;
  diagnostics: string[];
}

interface OpenCodeRuntimeDeliveryDiagnostics {
  warning: string | null;
  debugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
}

const PENDING_WARNING =
  'OpenCode runtime delivery is still being checked. Message was saved and will be retried if needed.';
const FAILED_WARNING =
  'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.';

function formatOpenCodeRuntimeDeliveryFailureReason(reason: string | null | undefined): string {
  const normalized = reason?.trim();
  if (!normalized) {
    return '';
  }
  if (normalized === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (normalized === 'prompt_delivered_no_assistant_message') {
    return 'OpenCode accepted the prompt, but no assistant turn was recorded.';
  }
  if (
    normalized === 'visible_reply_still_required' ||
    normalized === 'visible_reply_ack_only_still_requires_answer' ||
    normalized === 'plain_text_ack_only_still_requires_answer'
  ) {
    return 'OpenCode responded, but did not create a visible message_send reply.';
  }
  if (
    normalized === 'visible_reply_destination_not_found_yet' ||
    normalized === 'visible_reply_missing_relayOfMessageId'
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (normalized === 'visible_reply_missing_task_refs') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (normalized === 'visible_reply_missing_task_refs_after_merge') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (normalized === 'visible_reply_task_refs_merge_failed') {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (normalized === 'non_visible_tool_without_task_progress') {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
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

  const isFailed = runtimeDelivery.delivered === false;
  const isPending = runtimeDelivery.responsePending === true;
  if (!isFailed && !isPending) {
    return { warning: null, debugDetails: null };
  }

  const failureReason = isFailed
    ? formatOpenCodeRuntimeDeliveryFailureReason(
        runtimeDelivery.reason ?? runtimeDelivery.diagnostics?.[0]
      )
    : '';

  return {
    warning:
      isFailed && failureReason
        ? `${FAILED_WARNING} Reason: ${failureReason}`
        : isFailed
          ? FAILED_WARNING
          : PENDING_WARNING,
    debugDetails: {
      messageId: result.messageId,
      providerId: runtimeDelivery.providerId,
      delivered: typeof runtimeDelivery.delivered === 'boolean' ? runtimeDelivery.delivered : null,
      responsePending:
        typeof runtimeDelivery.responsePending === 'boolean'
          ? runtimeDelivery.responsePending
          : null,
      responseState: runtimeDelivery.responseState ?? null,
      ledgerStatus: runtimeDelivery.ledgerStatus ?? null,
      acceptanceUnknown:
        typeof runtimeDelivery.acceptanceUnknown === 'boolean'
          ? runtimeDelivery.acceptanceUnknown
          : null,
      reason: runtimeDelivery.reason ?? null,
      diagnostics: runtimeDelivery.diagnostics ?? [],
    },
  };
}

export function formatOpenCodeRuntimeDeliveryDebugDetails(
  details: OpenCodeRuntimeDeliveryDebugDetails
): string {
  return JSON.stringify(
    {
      messageId: details.messageId,
      providerId: details.providerId,
      delivered: details.delivered,
      responsePending: details.responsePending,
      responseState: details.responseState,
      ledgerStatus: details.ledgerStatus,
      acceptanceUnknown: details.acceptanceUnknown,
      reason: details.reason,
      diagnostics: details.diagnostics,
    },
    null,
    2
  );
}
