import { getErrorMessage } from '@shared/utils/errorHandling';

import { buildMessageDeliveryText } from '../../domain/leadMessagePresentation';
import { resolveVisibleDirectReplyProtocol } from '../../domain/messageDeliveryRoutePolicy';
import {
  OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON,
  projectOpenCodeRuntimeDelivery,
} from '../../domain/openCodeDeliveryProjection';

import type {
  ActionModeInstructionsPort,
  MessageAttachmentStorePort,
  MessageIdGeneratorPort,
  OpenCodeDeliveryImpactPort,
  TeamMessageLoggerPort,
  TeamMessagePersistencePort,
  TeamMessageTransportPort,
} from '../ports/TeamMessageDeliveryPorts';
import type { SendTeamMessageCommand } from '../SendTeamMessageCommand';
import type { OpenCodeUiDeliveryMonitor } from './OpenCodeUiDeliveryMonitor';
import type { SendMessageRequest, SendMessageResult, TeamProviderId } from '@shared/types';

export class InboxMessageDelivery {
  constructor(
    private readonly dependencies: {
      persistence: Pick<TeamMessagePersistencePort, 'sendMessage' | 'sendRuntimeRecipientMessage'>;
      messaging: Pick<
        TeamMessageTransportPort,
        'relayOpenCodeMemberInboxMessages' | 'relayLeadInboxMessages'
      >;
      attachments: Pick<MessageAttachmentStorePort, 'saveAttachments'>;
      ids: MessageIdGeneratorPort;
      actionModeInstructions: ActionModeInstructionsPort;
      openCodeMonitor: OpenCodeUiDeliveryMonitor;
      openCodeImpact: OpenCodeDeliveryImpactPort;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async deliver(
    command: SendTeamMessageCommand,
    context: {
      isLeadRecipient: boolean;
      isTeamAlive: boolean;
      recipientProviderId?: TeamProviderId;
    }
  ): Promise<SendMessageResult> {
    const replyRecipient = command.from?.trim() || 'user';
    const storedFrom = replyRecipient.toLowerCase() === 'user' ? 'user' : replyRecipient;
    const directReplyProtocol = resolveVisibleDirectReplyProtocol({
      isLeadRecipient: context.isLeadRecipient,
      replyRecipient,
      ...(context.recipientProviderId ? { providerId: context.recipientProviderId } : {}),
    });
    const messageId =
      directReplyProtocol === 'agent_teams_message_send' || command.attachments?.length
        ? this.dependencies.ids.createMessageId()
        : undefined;
    const baseText = command.text.trim();
    const deliveryText = buildMessageDeliveryText(baseText, {
      actionModeBlock: this.dependencies.actionModeInstructions.buildAgentBlock(command.actionMode),
      isLeadRecipient: context.isLeadRecipient,
      memberName: command.memberName,
      protocol: directReplyProtocol,
      replyRecipient,
      teamName: command.teamName,
      ...(messageId ? { messageId } : {}),
    });
    const isOpenCodeRecipient = context.recipientProviderId === 'opencode';
    const inboxText = isOpenCodeRecipient ? baseText : deliveryText;

    if (command.attachments?.length && messageId) {
      try {
        await this.dependencies.attachments.saveAttachments(
          command.teamName,
          messageId,
          command.attachments
        );
      } catch (error) {
        throw new Error(`Failed to save message attachments: ${getErrorMessage(error)}`);
      }
    }

    const request: SendMessageRequest = {
      member: command.memberName,
      text: inboxText,
      summary: command.summary,
      from: storedFrom,
      actionMode: command.actionMode,
      source: 'user_sent',
      taskRefs: command.taskRefs,
      ...(messageId ? { messageId } : {}),
      ...(command.attachments?.length ? { attachments: command.attachments } : {}),
    };
    const result = isOpenCodeRecipient
      ? await this.dependencies.persistence.sendRuntimeRecipientMessage(command.teamName, request)
      : await this.dependencies.persistence.sendMessage(command.teamName, request);

    if (isOpenCodeRecipient) {
      await this.attachOpenCodeDelivery(result, command, replyRecipient);
    }
    if (context.isLeadRecipient && context.isTeamAlive) {
      void this.dependencies.messaging
        .relayLeadInboxMessages(command.teamName)
        .catch((error: unknown) =>
          this.dependencies.logger.warn(
            `Relay after sendMessage failed for ${command.teamName}: ${String(error)}`
          )
        );
    }
    return result;
  }

  private async attachOpenCodeDelivery(
    result: SendMessageResult,
    command: SendTeamMessageCommand,
    replyRecipient: string
  ): Promise<void> {
    try {
      const relay = await this.dependencies.openCodeMonitor.waitForRelay({
        teamName: command.teamName,
        memberName: command.memberName,
        messageId: result.messageId,
        relayPromise: this.dependencies.messaging.relayOpenCodeMemberInboxMessages(
          command.teamName,
          command.memberName,
          {
            onlyMessageId: result.messageId,
            source: 'ui-send',
            deliveryMetadata: {
              replyRecipient,
              actionMode: command.actionMode,
              taskRefs: command.taskRefs,
            },
          }
        ),
      });
      const delivery = relay.lastDelivery ?? {
        delivered: relay.relayed > 0,
        reason: relay.relayed > 0 ? undefined : 'opencode_message_delivery_not_attempted',
        diagnostics: undefined,
      };
      result.runtimeDelivery = projectOpenCodeRuntimeDelivery({
        delivery,
        userVisibleImpact:
          delivery.userVisibleImpact ?? this.dependencies.openCodeImpact.buildImpact(delivery),
      });
      if (
        !delivery.delivered &&
        delivery.reason !== 'recipient_is_not_opencode' &&
        delivery.reason !== OPENCODE_RUNTIME_DELIVERY_UI_TIMEOUT_PENDING_REASON
      ) {
        this.dependencies.logger.warn(
          `OpenCode runtime delivery after sendMessage failed for teammate "${command.memberName}": ${delivery.reason ?? 'unknown error'}`
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const delivery = { delivered: false, reason, diagnostics: [reason] };
      result.runtimeDelivery = projectOpenCodeRuntimeDelivery({
        delivery,
        userVisibleImpact: this.dependencies.openCodeImpact.buildImpact(delivery),
      });
      this.dependencies.logger.warn(
        `OpenCode runtime delivery after sendMessage crashed for teammate "${command.memberName}": ${reason}`
      );
    }
  }
}
