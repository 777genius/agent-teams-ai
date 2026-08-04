import { DurableLeadRosterReader } from '../../core/application/services/DurableLeadRosterReader';
import { InboxMessageDelivery } from '../../core/application/services/InboxMessageDelivery';
import { LiveLeadMessageDelivery } from '../../core/application/services/LiveLeadMessageDelivery';
import { RuntimeDeliveryMonitor } from '../../core/application/services/RuntimeDeliveryMonitor';
import { TeamMessagePersistenceCoordinator } from '../../core/application/services/TeamMessagePersistenceCoordinator';
import { GetMessageAttachmentsUseCase } from '../../core/application/use-cases/GetMessageAttachmentsUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/use-cases/GetRuntimeDeliveryStatusUseCase';
import { SendTeamMessageUseCase } from '../../core/application/use-cases/SendTeamMessageUseCase';

import type {
  ActionModeInstructionsPort,
  ClockPort,
  DeadlinePort,
  DurableTeamRosterPort,
  MessageAttachmentStorePort,
  MessageDeliveryCompatibilityPort,
  MessageIdGeneratorPort,
  RuntimeDeliveryCompatibilityPort,
  RuntimeDeliveryImpactPort,
  TeamMessageLoggerPort,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../../core/application/ports/TeamMessageDeliveryPorts';
import type {
  TeamMessageLeadResolutionPort,
  TeamMessagePersistenceCoordinatorPorts,
  TeamMessagePersistenceFacade,
  TeamMessageSystemNotificationPort,
} from '../../core/application/ports/TeamMessagePersistencePorts';

export interface TeamMessageDeliveryFeature {
  sendMessage: SendTeamMessageUseCase;
  getRuntimeDeliveryStatus: GetRuntimeDeliveryStatusUseCase;
  getAttachments: GetMessageAttachmentsUseCase;
  logger: TeamMessageLoggerPort;
}

export interface TeamMessageDeliveryFeatureDependencies {
  persistence: TeamMessagePersistenceFacade;
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

/**
 * Creates the feature-owned persistence facade shared by desktop delivery and
 * legacy main-process collaborators. The coordinator remains internal.
 */
export function createTeamMessagePersistenceFacade(
  ports: TeamMessagePersistenceCoordinatorPorts
): TeamMessagePersistenceFacade {
  return new TeamMessagePersistenceCoordinator(ports);
}

export type {
  TeamMessageLeadResolutionPort,
  TeamMessagePersistenceCoordinatorPorts,
  TeamMessagePersistenceFacade,
  TeamMessageSystemNotificationPort,
};

export function createTeamMessageDeliveryFeature(
  dependencies: TeamMessageDeliveryFeatureDependencies
): TeamMessageDeliveryFeature {
  const runtime = {
    isTeamAlive: (teamName: string) => dependencies.runtime.isTeamAlive(teamName),
  };
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
    persistence: dependencies.persistence,
    messaging: dependencies.messaging,
    runtime,
    attachments: dependencies.attachments,
    ids: dependencies.ids,
    clock: dependencies.clock,
    actionModeInstructions: dependencies.actionModeInstructions,
    logger: dependencies.logger,
  });
  const inboxDelivery = new InboxMessageDelivery({
    persistence: dependencies.persistence,
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
      leadRecipient: dependencies.persistence,
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
