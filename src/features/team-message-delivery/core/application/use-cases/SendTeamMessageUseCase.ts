import { getAttachmentSupportFailure } from '../../domain/messageDeliveryRoutePolicy';

import type {
  LeadRecipientPort,
  MessageDeliveryCompatibilityPort,
  TeamMessageDeliveryResult,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../ports/TeamMessageDeliveryPorts';
import type {
  DelegateRecipientPrevalidation,
  SendTeamMessageCommand,
} from '../SendTeamMessageCommand';
import type { InboxMessageDelivery } from '../services/InboxMessageDelivery';
import type { LiveLeadMessageDelivery } from '../services/LiveLeadMessageDelivery';

export class SendTeamMessageUseCase {
  constructor(
    private readonly dependencies: {
      leadRecipient: LeadRecipientPort;
      runtime: TeamRuntimeStatusPort;
      messaging: Pick<TeamMessageTransportPort, 'resolveRecipientRoute'>;
      compatibility: Pick<MessageDeliveryCompatibilityPort, 'attachmentSupportError'>;
      liveLeadDelivery: LiveLeadMessageDelivery;
      inboxDelivery: InboxMessageDelivery;
    }
  ) {}

  async prevalidateDelegate(
    command: SendTeamMessageCommand
  ): Promise<DelegateRecipientPrevalidation | null> {
    if (command.actionMode !== 'delegate') return null;
    const leadName = await this.dependencies.leadRecipient.getLeadMemberName(command.teamName);
    return {
      leadName,
      isLeadRecipient: leadName !== null && command.memberName === leadName,
    };
  }

  async execute(
    command: SendTeamMessageCommand,
    prevalidatedDelegate: DelegateRecipientPrevalidation | null
  ): Promise<TeamMessageDeliveryResult> {
    const isTeamAlive = this.dependencies.runtime.isTeamAlive(command.teamName);
    const leadName =
      prevalidatedDelegate?.leadName ??
      (await this.dependencies.leadRecipient.getLeadMemberName(command.teamName));
    const isLeadRecipient =
      prevalidatedDelegate?.isLeadRecipient ??
      (leadName !== null && command.memberName === leadName);
    const recipientRoute = await this.dependencies.messaging.resolveRecipientRoute(
      command.teamName,
      command.memberName
    );
    const attachmentSupportFailure = getAttachmentSupportFailure({
      hasAttachments: Boolean(command.attachments?.length),
      isLeadRecipient,
      isRuntimeRecipient: recipientRoute.requiresRuntimeDelivery,
      isTeamAlive,
    });
    if (attachmentSupportFailure) {
      throw new Error(
        this.dependencies.compatibility.attachmentSupportError(attachmentSupportFailure)
      );
    }

    if (isLeadRecipient && isTeamAlive && !recipientRoute.requiresRuntimeDelivery) {
      const result = await this.dependencies.liveLeadDelivery.deliver(
        command,
        leadName ?? command.memberName
      );
      if (result) return result;
    }
    return this.dependencies.inboxDelivery.deliver(command, {
      isLeadRecipient,
      isTeamAlive,
      requiresRuntimeDelivery: recipientRoute.requiresRuntimeDelivery,
      ...(recipientRoute.providerId ? { recipientProviderId: recipientRoute.providerId } : {}),
    });
  }
}
