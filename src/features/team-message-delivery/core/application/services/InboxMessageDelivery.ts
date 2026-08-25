import { projectRuntimeDelivery } from '../../domain/runtimeDeliveryProjection';

import type { SendMessageRequest, TeamProviderId } from '../models/TeamMessageDeliveryModels';
import type {
  ActionModeInstructionsPort,
  MessageAttachmentStorePort,
  MessageDeliveryCompatibilityPort,
  MessageIdGeneratorPort,
  RuntimeDeliveryCompatibilityPort,
  RuntimeDeliveryImpactPort,
  TeamMessageDeliveryResult,
  TeamMessageLoggerPort,
  TeamMessagePersistencePort,
  TeamMessageTransportPort,
} from '../ports/TeamMessageDeliveryPorts';
import type { SendTeamMessageCommand } from '../SendTeamMessageCommand';
import type { RuntimeDeliveryMonitor } from './RuntimeDeliveryMonitor';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export class InboxMessageDelivery {
  constructor(
    private readonly dependencies: {
      persistence: Pick<TeamMessagePersistencePort, 'sendMessage' | 'sendRuntimeRecipientMessage'>;
      messaging: Pick<
        TeamMessageTransportPort,
        'relayRuntimeRecipientInboxMessages' | 'relayLeadInboxMessages'
      >;
      attachments: Pick<MessageAttachmentStorePort, 'saveAttachments'>;
      ids: MessageIdGeneratorPort;
      actionModeInstructions: ActionModeInstructionsPort;
      runtimeDeliveryMonitor: RuntimeDeliveryMonitor;
      runtimeDeliveryImpact: RuntimeDeliveryImpactPort;
      compatibility: Pick<
        MessageDeliveryCompatibilityPort,
        'buildRecipientDeliveryText' | 'requiresGeneratedMessageId'
      > &
        Pick<RuntimeDeliveryCompatibilityPort, 'buildMissingDelivery' | 'formatWarning'>;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async deliver(
    command: SendTeamMessageCommand,
    context: {
      isLeadRecipient: boolean;
      isTeamAlive: boolean;
      requiresRuntimeDelivery: boolean;
      recipientProviderId?: TeamProviderId;
    }
  ): Promise<TeamMessageDeliveryResult> {
    const replyRecipient = command.from?.trim() || 'user';
    const storedFrom = replyRecipient.toLowerCase() === 'user' ? 'user' : replyRecipient;
    const requiresGeneratedMessageId = this.dependencies.compatibility.requiresGeneratedMessageId({
      isLeadRecipient: context.isLeadRecipient,
      replyRecipient,
      ...(context.recipientProviderId ? { providerId: context.recipientProviderId } : {}),
    });
    const messageId =
      requiresGeneratedMessageId || command.attachments?.length
        ? this.dependencies.ids.createMessageId()
        : undefined;
    const baseText = command.text.trim();
    const deliveryText = this.dependencies.compatibility.buildRecipientDeliveryText({
      actionModeBlock: this.dependencies.actionModeInstructions.buildAgentBlock(command.actionMode),
      baseText,
      isLeadRecipient: context.isLeadRecipient,
      memberName: command.memberName,
      replyRecipient,
      teamName: command.teamName,
      ...(context.recipientProviderId ? { providerId: context.recipientProviderId } : {}),
      ...(messageId ? { messageId } : {}),
    });
    const isRuntimeRecipient = context.requiresRuntimeDelivery;
    const inboxText = isRuntimeRecipient ? baseText : deliveryText;

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
    const result = isRuntimeRecipient
      ? await this.dependencies.persistence.sendRuntimeRecipientMessage(command.teamName, request)
      : await this.dependencies.persistence.sendMessage(command.teamName, request);

    if (isRuntimeRecipient) {
      await this.attachRuntimeDelivery(
        result,
        command,
        replyRecipient,
        context.recipientProviderId
      );
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

  private async attachRuntimeDelivery(
    result: TeamMessageDeliveryResult,
    command: SendTeamMessageCommand,
    replyRecipient: string,
    providerId: TeamProviderId | undefined
  ): Promise<void> {
    try {
      const relay = await this.dependencies.runtimeDeliveryMonitor.waitForRelay({
        teamName: command.teamName,
        memberName: command.memberName,
        messageId: result.messageId,
        relayPromise: this.dependencies.messaging.relayRuntimeRecipientInboxMessages(
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
      const delivery =
        relay.lastDelivery ?? this.dependencies.compatibility.buildMissingDelivery(relay);
      if (!providerId) {
        throw new Error('Runtime delivery route is missing its provider identifier');
      }
      result.runtimeDelivery = projectRuntimeDelivery({
        delivery,
        providerId,
        userVisibleImpact:
          delivery.userVisibleImpact ??
          this.dependencies.runtimeDeliveryImpact.buildImpact(delivery),
      });
      if (!delivery.delivered) {
        this.warn({
          kind: 'delivery-failure',
          memberName: command.memberName,
          delivery,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const delivery = { delivered: false, reason, diagnostics: [reason] };
      if (!providerId) throw error;
      result.runtimeDelivery = projectRuntimeDelivery({
        delivery,
        providerId,
        userVisibleImpact: this.dependencies.runtimeDeliveryImpact.buildImpact(delivery),
      });
      this.warn({ kind: 'delivery-crash', memberName: command.memberName, reason });
    }
  }

  private warn(event: Parameters<RuntimeDeliveryCompatibilityPort['formatWarning']>[0]): void {
    const message = this.dependencies.compatibility.formatWarning(event);
    if (message) this.dependencies.logger.warn(message);
  }
}
