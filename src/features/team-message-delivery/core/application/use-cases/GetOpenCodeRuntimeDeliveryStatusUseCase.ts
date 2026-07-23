import type { TeamMessageTransportPort } from '../ports/TeamMessageDeliveryPorts';
import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types';

export class GetOpenCodeRuntimeDeliveryStatusUseCase {
  constructor(
    private readonly messaging: Pick<TeamMessageTransportPort, 'getOpenCodeRuntimeDeliveryStatus'>
  ) {}

  execute(teamName: string, messageId: string): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    return this.messaging.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
  }
}
