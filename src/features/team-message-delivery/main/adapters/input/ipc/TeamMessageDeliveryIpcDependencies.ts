import type { TeamMessageLoggerPort } from '../../../../core/application/ports/TeamMessageDeliveryPorts';
import type { GetMessageAttachmentsUseCase } from '../../../../core/application/use-cases/GetMessageAttachmentsUseCase';
import type { GetOpenCodeRuntimeDeliveryStatusUseCase } from '../../../../core/application/use-cases/GetOpenCodeRuntimeDeliveryStatusUseCase';
import type { GetTeamProcessAliveUseCase } from '../../../../core/application/use-cases/GetTeamProcessAliveUseCase';
import type { SendTeamMessageUseCase } from '../../../../core/application/use-cases/SendTeamMessageUseCase';
import type { SendTeamProcessMessageUseCase } from '../../../../core/application/use-cases/SendTeamProcessMessageUseCase';

export interface TeamMessageDeliveryIpcDependencies {
  sendMessage: SendTeamMessageUseCase;
  getOpenCodeRuntimeDeliveryStatus: GetOpenCodeRuntimeDeliveryStatusUseCase;
  sendProcessMessage: SendTeamProcessMessageUseCase;
  getProcessAlive: GetTeamProcessAliveUseCase;
  getAttachments: GetMessageAttachmentsUseCase;
  logger: TeamMessageLoggerPort;
}
