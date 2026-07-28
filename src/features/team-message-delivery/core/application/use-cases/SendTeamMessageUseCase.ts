import { assertAttachmentsSupported } from '../../domain/messageDeliveryRoutePolicy';

import type { LegacyRuntimeRecipientResolver } from '../../../contracts/compatibility/open-code-delivery';
import type { LeadRecipientPort, TeamRuntimeStatusPort } from '../ports/TeamMessageDeliveryPorts';
import type {
  DelegateRecipientPrevalidation,
  SendTeamMessageCommand,
} from '../SendTeamMessageCommand';
import type { InboxMessageDelivery } from '../services/InboxMessageDelivery';
import type { LiveLeadMessageDelivery } from '../services/LiveLeadMessageDelivery';
import type { SendMessageResult } from '@shared/types';

export class SendTeamMessageUseCase {
  constructor(
    private readonly dependencies: {
      leadRecipient: LeadRecipientPort;
      runtime: TeamRuntimeStatusPort;
      messaging: LegacyRuntimeRecipientResolver;
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
  ): Promise<SendMessageResult> {
    const isTeamAlive = this.dependencies.runtime.isTeamAlive(command.teamName);
    const leadName =
      prevalidatedDelegate?.leadName ??
      (await this.dependencies.leadRecipient.getLeadMemberName(command.teamName));
    const isLeadRecipient =
      prevalidatedDelegate?.isLeadRecipient ??
      (leadName !== null && command.memberName === leadName);
    const recipientProviderId = await this.dependencies.messaging.resolveRuntimeRecipientProviderId(
      command.teamName,
      command.memberName
    );
    const requiresRuntimeDelivery = recipientProviderId === 'opencode';
    assertAttachmentsSupported({
      hasAttachments: Boolean(command.attachments?.length),
      isLeadRecipient,
      isOpenCodeRecipient: requiresRuntimeDelivery,
      isTeamAlive,
    });

    if (isLeadRecipient && isTeamAlive && !requiresRuntimeDelivery) {
      const result = await this.dependencies.liveLeadDelivery.deliver(
        command,
        leadName ?? command.memberName
      );
      if (result) return result;
    }
    return this.dependencies.inboxDelivery.deliver(command, {
      isLeadRecipient,
      isTeamAlive,
      requiresRuntimeDelivery,
      ...(recipientProviderId ? { recipientProviderId } : {}),
    });
  }
}
