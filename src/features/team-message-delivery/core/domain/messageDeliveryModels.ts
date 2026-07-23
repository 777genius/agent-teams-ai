import type {
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
} from '@shared/types';

export interface TeamRosterMember {
  name: string;
  role?: string;
  removedAt?: string | number;
}

export interface OpenCodeRelayDelivery {
  delivered: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  acceptanceUnknown?: boolean;
  responseState?: OpenCodeRuntimeDeliveryStatus['responseState'];
  ledgerStatus?: OpenCodeRuntimeDeliveryStatus['ledgerStatus'];
  ledgerRecordId?: string;
  laneId?: string;
  visibleReplyMessageId?: string;
  visibleReplyCorrelation?: OpenCodeRuntimeDeliveryStatus['visibleReplyCorrelation'];
  queuedBehindMessageId?: string;
  reason?: string;
  diagnostics?: string[];
  userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
}

export interface OpenCodeRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: OpenCodeRelayDelivery;
  diagnostics?: string[];
}
