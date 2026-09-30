import type {
  RuntimeDeliveryStatus,
  RuntimeDeliveryUserVisibleImpact,
} from '../../contracts/runtime-delivery';

export interface TeamRosterMember {
  name: string;
  role?: string;
  removedAt?: string | number;
}

export interface RuntimeRelayDelivery {
  delivered: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: RuntimeDeliveryStatus['responseState'];
  ledgerStatus?: RuntimeDeliveryStatus['ledgerStatus'];
  ledgerRecordId?: string;
  laneId?: string;
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?: RuntimeDeliveryStatus['visibleReplyCorrelation'];
  queuedBehindMessageId?: string;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: RuntimeDeliveryUserVisibleImpact;
}

export interface RuntimeRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: RuntimeRelayDelivery;
  diagnostics?: string[];
}

/** @deprecated Use RuntimeRelayDelivery in new application code. */
export type OpenCodeRelayDelivery = RuntimeRelayDelivery;

/** @deprecated Use RuntimeRelayResult in new application code. */
export type OpenCodeRelayResult = RuntimeRelayResult;
