import type { OpenCodeRuntimeDeliveryStatus } from './team';

/** Observation of the original Host input; never a legacy OpenCode ledger result. */
export interface HostMessageDeliveryStatus {
  source: 'captured-host';
  messageId: string;
  confirmation: 'pending' | 'confirmed' | 'unconfirmed';
  responsePending: boolean;
  phase: string;
}

export interface TeamMessageDeliveryApi {
  getOpenCodeRuntimeDeliveryStatus: (
    teamName: string,
    messageId: string
  ) => Promise<OpenCodeRuntimeDeliveryStatus | null>;
  /** Renderer adapter over the existing authorized Host command/runtime reads. */
  getHostMessageDeliveryStatus?: (
    teamName: string,
    messageId: string
  ) => Promise<HostMessageDeliveryStatus>;
}
