import type { RuntimeDeliveryStatus } from '../../../contracts/runtime-delivery';

export interface RuntimeDeliveryStatusReaderPort {
  getRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<RuntimeDeliveryStatus | null>;
}

export class GetRuntimeDeliveryStatusUseCase {
  constructor(private readonly deliveryStatus: RuntimeDeliveryStatusReaderPort) {}

  execute(teamName: string, messageId: string): Promise<RuntimeDeliveryStatus | null> {
    return this.deliveryStatus.getRuntimeDeliveryStatus(teamName, messageId);
  }
}
