import type { TeamProviderId } from '@shared/types';

export type RuntimeMessageDeliveryAckState = 'accepted' | 'delivered' | 'duplicate' | 'recorded';

export type RuntimeMessageDeliveryAckLocation = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface RuntimeMessageDeliveryAck<ProviderId extends string = TeamProviderId> {
  ok: true;
  providerId: ProviderId;
  teamName: string;
  runId: string;
  state: RuntimeMessageDeliveryAckState;
  memberName?: string;
  runtimeSessionId?: string;
  idempotencyKey?: string;
  location?: RuntimeMessageDeliveryAckLocation;
  diagnostics: string[];
  observedAt: string;
}

export interface RuntimeDeliveryStatus<ProviderId extends string = TeamProviderId> {
  providerId: ProviderId;
  attempted: boolean;
  delivered: boolean;
  messageId: string;
  accepted?: boolean;
  responsePending?: boolean;
  reason?: string;
  diagnostics?: string[];
}

export interface RuntimeDeliveryApi {
  deliverRuntimeMessage(input: unknown): Promise<RuntimeMessageDeliveryAck>;
  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null>;
}

/**
 * Internal composition hook retained for the desktop compatibility adapter.
 * Browser consumers use RuntimeDeliveryApi from the feature root.
 */
export interface TeamProvisioningRuntimeDeliveryApi {
  deliverRuntimeMessage: RuntimeDeliveryApi['deliverRuntimeMessage'];
  getRuntimeDeliveryStatus: RuntimeDeliveryApi['getRuntimeDeliveryStatus'];
}
