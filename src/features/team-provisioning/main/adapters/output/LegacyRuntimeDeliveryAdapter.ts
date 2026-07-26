import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
} from '../../../contracts/runtime-delivery';
import type { RuntimeDeliveryPort } from '../../../core/application/ports/RuntimeDeliveryPort';

export interface LegacyRuntimeDeliveryAdapterDeps {
  readonly deliverOpenCodeRuntimeMessage: (raw: unknown) => Promise<RuntimeMessageDeliveryAck>;
  readonly getOpenCodeRuntimeDeliveryStatus: (
    teamName: string,
    messageId: string
  ) => Promise<RuntimeDeliveryStatus | null>;
}

export class LegacyRuntimeDeliveryAdapter implements RuntimeDeliveryPort {
  constructor(private readonly deps: LegacyRuntimeDeliveryAdapterDeps) {}

  deliverRuntimeMessage(raw: unknown): Promise<RuntimeMessageDeliveryAck> {
    return this.deps.deliverOpenCodeRuntimeMessage(raw);
  }

  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null> {
    return this.deps.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
  }
}
