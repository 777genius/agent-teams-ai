import type { TeamMessageLoggerPort } from '../../../../core/application/ports/TeamMessageDeliveryPorts';
import type { GetMessageAttachmentsUseCase } from '../../../../core/application/use-cases/GetMessageAttachmentsUseCase';
import type { GetRuntimeDeliveryStatusUseCase } from '../../../../core/application/use-cases/GetRuntimeDeliveryStatusUseCase';
import type { GetTeamProcessAliveUseCase } from '../../../../core/application/use-cases/GetTeamProcessAliveUseCase';
import type { SendTeamMessageUseCase } from '../../../../core/application/use-cases/SendTeamMessageUseCase';
import type { SendTeamProcessMessageUseCase } from '../../../../core/application/use-cases/SendTeamProcessMessageUseCase';

export interface TeamMessageDeliveryIpcDependencies {
  sendMessage: SendTeamMessageUseCase;
  getRuntimeDeliveryStatus: GetRuntimeDeliveryStatusUseCase;
  sendProcessMessage: SendTeamProcessMessageUseCase;
  getProcessAlive: GetTeamProcessAliveUseCase;
  getAttachments: GetMessageAttachmentsUseCase;
  logger: TeamMessageLoggerPort;
}
