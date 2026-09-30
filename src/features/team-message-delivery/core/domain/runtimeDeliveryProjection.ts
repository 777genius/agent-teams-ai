import type {
  RuntimeDeliveryAttempt,
  RuntimeDeliveryUserVisibleImpact,
} from '../../contracts/runtime-delivery';
import type { RuntimeRelayDelivery } from './messageDeliveryModels';
import type { TeamProviderId } from '@shared/types';

export function projectRuntimeDelivery(input: {
  delivery: RuntimeRelayDelivery;
  providerId: TeamProviderId;
  userVisibleImpact: RuntimeDeliveryUserVisibleImpact;
}): RuntimeDeliveryAttempt {
  const { delivery } = input;
  return {
    providerId: input.providerId,
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
