import type { MemberRuntimeAdvisory, TeamProviderId } from '@shared/types';

export type RuntimeDeliveryUserVisibleState = 'none' | 'checking' | 'warning' | 'error';

export interface RuntimeDeliveryUserVisibleImpact {
  state: RuntimeDeliveryUserVisibleState;
  reasonCode?: MemberRuntimeAdvisory['reasonCode'];
  message?: string;
  observedAt?: string;
  nextReviewAt?: string;
}

export interface RuntimeDeliveryStatus {
  providerId: TeamProviderId;
  attempted: boolean;
  delivered: boolean;
  messageId: string;
  accepted?: boolean;
  responsePending?: boolean;
  responseState?:
    | 'not_observed'
    | 'pending'
    | 'prompt_not_indexed'
    | 'responded_tool_call'
    | 'responded_visible_message'
    | 'responded_non_visible_tool'
    | 'responded_plain_text'
    | 'permission_blocked'
    | 'tool_error'
    | 'empty_assistant_turn'
    | 'prompt_delivered_no_assistant_message'
    | 'session_stale'
    | 'session_error'
    | 'reconcile_failed';
  ledgerStatus?:
    | 'pending'
    | 'accepted'
    | 'responded'
    | 'unanswered'
    | 'retry_scheduled'
    | 'retried'
    | 'failed_retryable'
    | 'failed_terminal';
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?:
    | 'relayOfMessageId'
    | 'direct_child_message_send'
    | 'plain_assistant_text';
  ledgerRecordId?: string;
  laneId?: string;
  acceptanceUnknown?: boolean;
  queuedBehindMessageId?: string;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: RuntimeDeliveryUserVisibleImpact;
}
