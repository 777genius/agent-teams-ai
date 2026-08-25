import type { RuntimeDeliveryStatusPort } from '../ports/RuntimeDeliveryPort';

export interface GetRuntimeDeliveryStatusQuery {
  teamName: string;
  messageId: string;
}

export class GetRuntimeDeliveryStatusUseCase<Status = unknown> {
  constructor(private readonly runtimeDelivery: RuntimeDeliveryStatusPort<Status>) {}

  execute(query: GetRuntimeDeliveryStatusQuery): Promise<Status | null> {
    return this.runtimeDelivery.getRuntimeDeliveryStatus(query.teamName, query.messageId);
  }
}
