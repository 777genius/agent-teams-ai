import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { randomUUID } from 'crypto';

import { DurableLeadRosterReader } from '../../core/application/services/DurableLeadRosterReader';
import { InboxMessageDelivery } from '../../core/application/services/InboxMessageDelivery';
import { LiveLeadMessageDelivery } from '../../core/application/services/LiveLeadMessageDelivery';
import { OpenCodeUiDeliveryMonitor } from '../../core/application/services/OpenCodeUiDeliveryMonitor';
import { GetMessageAttachmentsUseCase } from '../../core/application/use-cases/GetMessageAttachmentsUseCase';
import { GetOpenCodeRuntimeDeliveryStatusUseCase } from '../../core/application/use-cases/GetOpenCodeRuntimeDeliveryStatusUseCase';
import { GetTeamProcessAliveUseCase } from '../../core/application/use-cases/GetTeamProcessAliveUseCase';
import { SendTeamMessageUseCase } from '../../core/application/use-cases/SendTeamMessageUseCase';
import { SendTeamProcessMessageUseCase } from '../../core/application/use-cases/SendTeamProcessMessageUseCase';
import { LegacyActionModeInstructions } from '../adapters/output/LegacyActionModeInstructions';
import { OpenCodeDeliveryImpactAdapter } from '../adapters/output/OpenCodeDeliveryImpactAdapter';
import { MainProcessDeadline } from '../infrastructure/MainProcessDeadline';

import type {
  ActionModeInstructionsPort,
  ClockPort,
  DeadlinePort,
  DurableTeamRosterPort,
  LeadRecipientPort,
  MessageAttachmentStorePort,
  MessageIdGeneratorPort,
  OpenCodeDeliveryImpactPort,
  TeamMessageLoggerPort,
  TeamMessagePersistencePort,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../../core/application/ports/TeamMessageDeliveryPorts';
import type { TeamRosterMember } from '../../core/domain/messageDeliveryModels';
import type { TeamMessageDeliveryIpcDependencies } from '../adapters/input/ipc/TeamMessageDeliveryIpcDependencies';

export type TeamMessageDeliveryFeature = TeamMessageDeliveryIpcDependencies;

export interface TeamMessageDeliveryRepositoryPort
  extends LeadRecipientPort, TeamMessagePersistencePort {
  getTeamData(teamName: string): Promise<{ members: TeamRosterMember[] }>;
}

export function createTeamMessageDeliveryFeature(dependencies: {
  repository: TeamMessageDeliveryRepositoryPort;
  messaging: TeamMessageTransportPort;
  runtime: TeamRuntimeStatusPort;
  logger: TeamMessageLoggerPort;
  attachments?: MessageAttachmentStorePort;
  roster?: DurableTeamRosterPort;
  deadline?: DeadlinePort;
  ids?: MessageIdGeneratorPort;
  clock?: ClockPort;
  actionModeInstructions?: ActionModeInstructionsPort;
  openCodeImpact?: OpenCodeDeliveryImpactPort;
}): TeamMessageDeliveryFeature {
  const attachmentStore = dependencies.attachments ?? createAttachmentStore();
  const roster = dependencies.roster ?? createRoster(dependencies.repository);
  const deadline = dependencies.deadline ?? new MainProcessDeadline();
  const ids = dependencies.ids ?? { createMessageId: randomUUID };
  const clock = dependencies.clock ?? { nowIso: () => new Date().toISOString() };
  const actionModeInstructions =
    dependencies.actionModeInstructions ?? new LegacyActionModeInstructions();
  const openCodeImpact = dependencies.openCodeImpact ?? new OpenCodeDeliveryImpactAdapter();
  const messaging = bindMessaging(dependencies.messaging);
  const runtime = {
    isTeamAlive: (teamName: string) => dependencies.runtime.isTeamAlive(teamName),
  };
  const repository = bindRepository(dependencies.repository);

  const rosterReader = new DurableLeadRosterReader({
    roster,
    logger: dependencies.logger,
  });
  const monitor = new OpenCodeUiDeliveryMonitor({
    messaging,
    deadline,
    logger: dependencies.logger,
  });
  const liveLeadDelivery = new LiveLeadMessageDelivery({
    roster: rosterReader,
    persistence: repository,
    messaging,
    runtime,
    attachments: attachmentStore,
    ids,
    clock,
    actionModeInstructions,
    logger: dependencies.logger,
  });
  const inboxDelivery = new InboxMessageDelivery({
    persistence: repository,
    messaging,
    attachments: attachmentStore,
    ids,
    actionModeInstructions,
    openCodeMonitor: monitor,
    openCodeImpact,
    logger: dependencies.logger,
  });

  return {
    sendMessage: new SendTeamMessageUseCase({
      leadRecipient: repository,
      runtime,
      messaging,
      liveLeadDelivery,
      inboxDelivery,
    }),
    getOpenCodeRuntimeDeliveryStatus: new GetOpenCodeRuntimeDeliveryStatusUseCase(messaging),
    sendProcessMessage: new SendTeamProcessMessageUseCase(messaging),
    getProcessAlive: new GetTeamProcessAliveUseCase(runtime),
    getAttachments: new GetMessageAttachmentsUseCase(attachmentStore),
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

function bindMessaging(messaging: TeamMessageTransportPort): TeamMessageTransportPort {
  return {
    sendMessageToTeam: (teamName, message, attachments) =>
      messaging.sendMessageToTeam(teamName, message, attachments),
    resolveRuntimeRecipientProviderId: (teamName, memberName) =>
      messaging.resolveRuntimeRecipientProviderId(teamName, memberName),
    relayOpenCodeMemberInboxMessages: (teamName, memberName, options) =>
      messaging.relayOpenCodeMemberInboxMessages(teamName, memberName, options),
    relayLeadInboxMessages: (teamName) => messaging.relayLeadInboxMessages(teamName),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      messaging.getOpenCodeRuntimeDeliveryStatus(teamName, messageId),
    pushLiveLeadProcessMessage: (teamName, message) =>
      messaging.pushLiveLeadProcessMessage(teamName, message),
  };
}

function createAttachmentStore(): MessageAttachmentStorePort {
  const store = new TeamAttachmentStore();
  return {
    saveAttachments: (teamName, messageId, attachments) =>
      store.saveAttachments(teamName, messageId, attachments),
    getAttachments: (teamName, messageId) => store.getAttachments(teamName, messageId),
  };
}

function createRoster(repository: TeamMessageDeliveryRepositoryPort): DurableTeamRosterPort {
  const store = new TeamMembersMetaStore();
  return {
    getMembers: (teamName) => store.getMembers(teamName),
    getFallbackMembers: async (teamName) => (await repository.getTeamData(teamName)).members,
  };
}
