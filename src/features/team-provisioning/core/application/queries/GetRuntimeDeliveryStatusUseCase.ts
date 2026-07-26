import type { RuntimeDeliveryStatus } from '../../../contracts/runtime-delivery';
import type { RuntimeDeliveryStatusPort } from '../ports/RuntimeDeliveryPort';

export interface GetRuntimeDeliveryStatusQuery {
  teamName: string;
  messageId: string;
}

export class GetRuntimeDeliveryStatusUseCase {
  constructor(private readonly runtimeDelivery: RuntimeDeliveryStatusPort) {}

  execute(query: GetRuntimeDeliveryStatusQuery): Promise<RuntimeDeliveryStatus | null> {
    return this.runtimeDelivery.getRuntimeDeliveryStatus(query.teamName, query.messageId);
  }
}
