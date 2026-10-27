import type { OpenCodeDeliveryResponseObservation } from './OpenCodeBridgeCommandContract';

export function createOpenCodeUnobservedDeliveryResponse(
  state: 'not_observed' | 'reconcile_failed',
  reason: string | null
): OpenCodeDeliveryResponseObservation {
  return {
    state,
    deliveredUserMessageId: null,
    assistantMessageId: null,
    toolCallNames: [],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: null,
    reason,
  };
}
