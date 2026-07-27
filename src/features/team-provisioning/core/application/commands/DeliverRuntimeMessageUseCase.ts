import type { RuntimeMessageDeliveryAck } from '../../../contracts/runtime-delivery';
import type { RuntimeMessageDeliveryPort } from '../ports/RuntimeDeliveryPort';

export interface DeliverRuntimeMessageCommand {
  raw: unknown;
}

export class DeliverRuntimeMessageUseCase {
  constructor(private readonly runtimeDelivery: RuntimeMessageDeliveryPort) {}

  execute(command: DeliverRuntimeMessageCommand): Promise<RuntimeMessageDeliveryAck> {
    return this.runtimeDelivery.deliverRuntimeMessage(command.raw);
  }
}
