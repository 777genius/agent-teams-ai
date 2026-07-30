import { DurableLeadRosterReader } from '../../core/application/services/DurableLeadRosterReader';
import { InboxMessageDelivery } from '../../core/application/services/InboxMessageDelivery';
import { LiveLeadMessageDelivery } from '../../core/application/services/LiveLeadMessageDelivery';
import { RuntimeDeliveryMonitor } from '../../core/application/services/RuntimeDeliveryMonitor';
import { GetMessageAttachmentsUseCase } from '../../core/application/use-cases/GetMessageAttachmentsUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/use-cases/GetRuntimeDeliveryStatusUseCase';
import { SendTeamMessageUseCase } from '../../core/application/use-cases/SendTeamMessageUseCase';

import type {
  ActionModeInstructionsPort,
  ClockPort,
  DeadlinePort,
  DurableTeamRosterPort,
  LeadRecipientPort,
  MessageAttachmentStorePort,
  MessageDeliveryCompatibilityPort,
  MessageIdGeneratorPort,
  RuntimeDeliveryCompatibilityPort,
  RuntimeDeliveryImpactPort,
  TeamMessageLoggerPort,
  TeamMessagePersistencePort,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../../core/application/ports/TeamMessageDeliveryPorts';
import type { TeamRosterMember } from '../../core/domain/messageDeliveryModels';

export interface TeamMessageDeliveryFeature {
  sendMessage: SendTeamMessageUseCase;
  getRuntimeDeliveryStatus: GetRuntimeDeliveryStatusUseCase;
  getAttachments: GetMessageAttachmentsUseCase;
  logger: TeamMessageLoggerPort;
}

export interface TeamMessageDeliveryRepositoryPort
  extends LeadRecipientPort, TeamMessagePersistencePort {
  getTeamData(teamName: string): Promise<{ members: TeamRosterMember[] }>;
}

export interface TeamMessageDeliveryFeatureDependencies {
  repository: TeamMessageDeliveryRepositoryPort;
  messaging: TeamMessageTransportPort;
  runtime: TeamRuntimeStatusPort;
  logger: TeamMessageLoggerPort;
  attachments: MessageAttachmentStorePort;
  roster: DurableTeamRosterPort;
  deadline: DeadlinePort;
  ids: MessageIdGeneratorPort;
  clock: ClockPort;
  actionModeInstructions: ActionModeInstructionsPort;
  runtimeDeliveryImpact: RuntimeDeliveryImpactPort;
  compatibility: MessageDeliveryCompatibilityPort & RuntimeDeliveryCompatibilityPort;
}

export function createTeamMessageDeliveryFeature(
  dependencies: TeamMessageDeliveryFeatureDependencies
): TeamMessageDeliveryFeature {
  const runtime = {
    isTeamAlive: (teamName: string) => dependencies.runtime.isTeamAlive(teamName),
  };
  const repository = bindRepository(dependencies.repository);
  const rosterReader = new DurableLeadRosterReader({
    roster: dependencies.roster,
    logger: dependencies.logger,
  });
  const monitor = new RuntimeDeliveryMonitor({
    messaging: dependencies.messaging,
    deadline: dependencies.deadline,
    compatibility: dependencies.compatibility,
    logger: dependencies.logger,
  });
  const liveLeadDelivery = new LiveLeadMessageDelivery({
    roster: rosterReader,
    persistence: repository,
    messaging: dependencies.messaging,
    runtime,
    attachments: dependencies.attachments,
    ids: dependencies.ids,
    clock: dependencies.clock,
    actionModeInstructions: dependencies.actionModeInstructions,
    logger: dependencies.logger,
  });
  const inboxDelivery = new InboxMessageDelivery({
    persistence: repository,
    messaging: dependencies.messaging,
    attachments: dependencies.attachments,
    ids: dependencies.ids,
    actionModeInstructions: dependencies.actionModeInstructions,
    runtimeDeliveryMonitor: monitor,
    runtimeDeliveryImpact: dependencies.runtimeDeliveryImpact,
    compatibility: dependencies.compatibility,
    logger: dependencies.logger,
  });

  return {
    sendMessage: new SendTeamMessageUseCase({
      leadRecipient: repository,
      runtime,
      messaging: dependencies.messaging,
      compatibility: dependencies.compatibility,
      liveLeadDelivery,
      inboxDelivery,
    }),
    getRuntimeDeliveryStatus: new GetRuntimeDeliveryStatusUseCase(dependencies.messaging),
    getAttachments: new GetMessageAttachmentsUseCase(dependencies.attachments),
    logger: dependencies.logger,
  };
}

function bindRepository(
  repository: TeamMessageDeliveryRepositoryPort
): LeadRecipientPort & TeamMessagePersistencePort {
  return {
    getLeadMemberName: (teamName) => repository.getLeadMemberName(teamName),
    sendMessage: (teamName, request) => repository.sendMessage(teamName, request),
    sendRuntimeRecipientMessage: (teamName, request) =>
      repository.sendRuntimeRecipientMessage(teamName, request),
    sendDirectToLead: (teamName, leadName, text, summary, attachments, taskRefs, messageId) =>
      repository.sendDirectToLead(
        teamName,
        leadName,
        text,
        summary,
        attachments,
        taskRefs,
        messageId
      ),
  };
}
