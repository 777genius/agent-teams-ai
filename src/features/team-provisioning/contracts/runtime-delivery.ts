import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types/team';

export type RuntimeMessageDeliveryAckState = 'accepted' | 'delivered' | 'duplicate' | 'recorded';

export type RuntimeMessageDeliveryAckLocation = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * Browser-safe structural contract for the acknowledgement returned by the
 * existing OpenCode runtime-control boundary.
 */
export interface RuntimeMessageDeliveryAck {
  ok: true;
  providerId: 'opencode';
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

export type RuntimeDeliveryStatus = OpenCodeRuntimeDeliveryStatus;

export interface TeamProvisioningRuntimeDeliveryApi {
  deliverOpenCodeRuntimeMessage(raw: unknown): Promise<RuntimeMessageDeliveryAck>;
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null>;
}
