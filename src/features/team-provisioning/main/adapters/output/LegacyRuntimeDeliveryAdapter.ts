import type { TeamProvisioningRuntimeDeliveryApi } from '../../../contracts/runtime-delivery';
import type { RuntimeDeliveryPort } from '../../../core/application/ports/RuntimeDeliveryPort';
import type { OpenCodeRuntimeControlAck } from '@main/services/team/runtime-control';
import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types/team';

declare module '../../../contracts/runtime-delivery' {
  interface TeamProvisioningRuntimeDeliveryApi {
    deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
    getOpenCodeRuntimeDeliveryStatus(
      teamName: string,
      messageId: string
    ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
  }
}

export interface LegacyRuntimeDeliveryAdapterDeps {
  readonly deliverOpenCodeRuntimeMessage: (raw: unknown) => Promise<OpenCodeRuntimeControlAck>;
  readonly getOpenCodeRuntimeDeliveryStatus: (
    teamName: string,
    messageId: string
  ) => Promise<OpenCodeRuntimeDeliveryStatus | null>;
}

export type LegacyRuntimeDeliveryCompatibilityApi = Pick<
  TeamProvisioningRuntimeDeliveryApi,
  'deliverOpenCodeRuntimeMessage' | 'getOpenCodeRuntimeDeliveryStatus'
>;

export class LegacyRuntimeDeliveryAdapter implements RuntimeDeliveryPort<
  unknown,
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeDeliveryStatus
> {
  constructor(private readonly deps: LegacyRuntimeDeliveryAdapterDeps) {}

  deliverRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.deps.deliverOpenCodeRuntimeMessage(raw);
  }

  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    return this.deps.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
  }
}
