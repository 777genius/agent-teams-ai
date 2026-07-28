import { toOpenCodeRuntimeDeliveryStatus } from '../../../contracts/compatibility/open-code-delivery';

import type { OpenCodeRuntimeDeliveryStatus } from '../../../contracts/compatibility/open-code-delivery';
import type { GetRuntimeDeliveryStatusUseCase } from './GetRuntimeDeliveryStatusUseCase';

/** Desktop compatibility facade over the provider-neutral query. */
export class GetOpenCodeRuntimeDeliveryStatusUseCase {
  constructor(private readonly runtimeDeliveryStatus: GetRuntimeDeliveryStatusUseCase) {}

  async execute(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    const status = await this.runtimeDeliveryStatus.execute(teamName, messageId);
    return status ? toOpenCodeRuntimeDeliveryStatus(status) : null;
  }
}
