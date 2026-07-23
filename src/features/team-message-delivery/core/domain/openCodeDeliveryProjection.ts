import type { OpenCodeRelayDelivery, OpenCodeRelayResult } from './messageDeliveryModels';
import type {
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  SendMessageResult,
} from '@shared/types';

export const OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON =
  'opencode_runtime_delivery_ui_timeout_pending';

export function shouldLookupOpenCodeRuntimeDeliveryStatusAfterRelay(
  relay: OpenCodeRelayResult
): boolean {
  const delivery = relay.lastDelivery;
  if (!delivery?.delivered) return false;
  return (
    typeof delivery.accepted !== 'boolean' &&
    typeof delivery.responsePending !== 'boolean' &&
    !delivery.responseState &&
    !delivery.ledgerStatus &&
    !delivery.ledgerRecordId &&
    !delivery.laneId &&
    !delivery.userVisibleImpact
  );
}

export function openCodeRuntimeDeliveryStatusToRelayResult(
  status: OpenCodeRuntimeDeliveryStatus
): OpenCodeRelayResult {
  const lastDelivery: OpenCodeRelayDelivery = {
    delivered: status.delivered,
    ...(typeof status.accepted === 'boolean' ? { accepted: status.accepted } : {}),
    ...(typeof status.responsePending === 'boolean'
      ? { responsePending: status.responsePending }
      : {}),
    ...(typeof status.acceptanceUnknown === 'boolean'
      ? { acceptanceUnknown: status.acceptanceUnknown }
      : {}),
    ...(status.responseState ? { responseState: status.responseState } : {}),
    ...(status.ledgerStatus ? { ledgerStatus: status.ledgerStatus } : {}),
    ...(status.visibleReplyMessageId
      ? { visibleReplyMessageId: status.visibleReplyMessageId }
      : {}),
    ...(status.visibleReplyCorrelation
      ? { visibleReplyCorrelation: status.visibleReplyCorrelation }
      : {}),
    ...(status.ledgerRecordId ? { ledgerRecordId: status.ledgerRecordId } : {}),
    ...(status.laneId ? { laneId: status.laneId } : {}),
    ...(status.queuedBehindMessageId
      ? { queuedBehindMessageId: status.queuedBehindMessageId }
      : {}),
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
    ...(shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(status)
      ? { userVisibleImpact: status.userVisibleImpact }
      : {}),
  };
  return {
    relayed: 0,
    attempted: 1,
    delivered: status.delivered && status.responsePending !== true ? 1 : 0,
    failed: status.delivered ? 0 : 1,
    lastDelivery,
    diagnostics: status.diagnostics,
  };
}

export function buildOpenCodeRuntimeDeliveryUiTimeoutRelayResult(
  extraDiagnostics: string[] = []
): OpenCodeRelayResult {
  const diagnostics = [OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON, ...extraDiagnostics];
  return {
    relayed: 0,
    attempted: 1,
    delivered: 0,
    failed: 1,
    lastDelivery: {
      delivered: true,
      accepted: false,
      responsePending: true,
      acceptanceUnknown: true,
      responseState: 'not_observed',
      reason: OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
      diagnostics,
    },
  };
}

export function projectOpenCodeRuntimeDelivery(input: {
  delivery: OpenCodeRelayDelivery;
  userVisibleImpact: OpenCodeRuntimeDeliveryUserVisibleImpact;
}): NonNullable<SendMessageResult['runtimeDelivery']> {
  const { delivery } = input;
  return {
    providerId: 'opencode',
    attempted: true,
    delivered: delivery.delivered,
    accepted: delivery.accepted,
    responsePending: delivery.responsePending,
    acceptanceUnknown: delivery.acceptanceUnknown,
    responseState: delivery.responseState,
    ledgerStatus: delivery.ledgerStatus,
    visibleReplyMessageId: delivery.visibleReplyMessageId,
    visibleReplyCorrelation: delivery.visibleReplyCorrelation,
    ledgerRecordId: delivery.ledgerRecordId,
    laneId: delivery.laneId,
    queuedBehindMessageId: delivery.queuedBehindMessageId,
    reason: delivery.reason,
    diagnostics: delivery.diagnostics,
    userVisibleImpact: input.userVisibleImpact,
  };
}

function shouldPreserveOpenCodeRuntimeDeliveryStatusImpact(
  status: OpenCodeRuntimeDeliveryStatus
): boolean {
  if (!status.userVisibleImpact) return false;
  if (
    status.userVisibleImpact.state === 'none' &&
    (status.responsePending === true ||
      status.acceptanceUnknown === true ||
      Boolean(status.queuedBehindMessageId))
  ) {
    return false;
  }
  return true;
}
