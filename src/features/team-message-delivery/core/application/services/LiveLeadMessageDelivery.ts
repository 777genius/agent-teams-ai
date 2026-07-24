import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';

import { formatAttachmentDeliveryFailure } from '../../domain/attachmentPayloadPolicy';
import {
  buildLeadDirectDelegateAckBlock,
  buildLeadRosterContextBlock,
  buildLiveLeadDeliveryText,
} from '../../domain/leadMessagePresentation';

import type {
  ActionModeInstructionsPort,
  ClockPort,
  MessageAttachmentStorePort,
  MessageIdGeneratorPort,
  TeamMessageLoggerPort,
  TeamMessagePersistencePort,
  TeamMessageTransportPort,
  TeamRuntimeStatusPort,
} from '../ports/TeamMessageDeliveryPorts';
import type { SendTeamMessageCommand } from '../SendTeamMessageCommand';
import type { DurableLeadRosterReader } from './DurableLeadRosterReader';
import type { AttachmentMeta, SendMessageResult } from '@shared/types';

export class LiveLeadMessageDelivery {
  constructor(
    private readonly dependencies: {
      roster: DurableLeadRosterReader;
      persistence: Pick<TeamMessagePersistencePort, 'sendDirectToLead'>;
      messaging: Pick<TeamMessageTransportPort, 'sendMessageToTeam' | 'pushLiveLeadProcessMessage'>;
      runtime: TeamRuntimeStatusPort;
      attachments: Pick<MessageAttachmentStorePort, 'saveAttachments'>;
      ids: MessageIdGeneratorPort;
      clock: ClockPort;
      actionModeInstructions: ActionModeInstructionsPort;
      logger: TeamMessageLoggerPort;
    }
  ) {}

  async deliver(
    command: SendTeamMessageCommand,
    leadName: string
  ): Promise<SendMessageResult | null> {
    const teammateRoster = await this.dependencies.roster.read(command.teamName, leadName);
    const messageId = this.dependencies.ids.createMessageId();
    const standaloneSlashCommand = command.attachments?.length
      ? null
      : parseStandaloneSlashCommand(command.text);
    const slashCommandMeta = standaloneSlashCommand
      ? buildStandaloneSlashCommandMeta(standaloneSlashCommand.raw)
      : null;
    const rawSlashCommandText = standaloneSlashCommand?.raw;
    const stdinText = rawSlashCommandText
      ? rawSlashCommandText
      : buildLiveLeadDeliveryText({
          messageId,
          text: command.text,
          actionModeBlock: this.dependencies.actionModeInstructions.buildAgentBlock(
            command.actionMode
          ),
          rosterContextBlock: buildLeadRosterContextBlock(
            command.teamName,
            leadName,
            teammateRoster
          ),
          delegateAckBlock: buildLeadDirectDelegateAckBlock(command.actionMode),
        });
    try {
      await this.dependencies.messaging.sendMessageToTeam(
        command.teamName,
        stdinText,
        rawSlashCommandText ? undefined : command.attachments
      );
    } catch (error) {
      if (command.attachments?.length) {
        throw new Error(
          formatAttachmentDeliveryFailure(
            error,
            this.dependencies.runtime.isTeamAlive(command.teamName)
          )
        );
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      this.dependencies.logger.warn(`stdin fallback for ${command.teamName}: ${message}`);
      return null;
    }

    let attachmentFilePaths: Map<string, string> | undefined;
    if (command.attachments?.length) {
      try {
        attachmentFilePaths = await this.dependencies.attachments.saveAttachments(
          command.teamName,
          messageId,
          command.attachments
        );
      } catch (error) {
        this.dependencies.logger.warn(`Failed to save attachments: ${String(error)}`);
      }
    }
    const attachmentMeta: AttachmentMeta[] | undefined = command.attachments?.map((attachment) => {
      const filePath = attachmentFilePaths?.get(attachment.id);
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        ...(filePath ? { filePath } : {}),
      };
    });

    let result: SendMessageResult;
    const persistText = rawSlashCommandText ?? command.text;
    try {
      result = await this.dependencies.persistence.sendDirectToLead(
        command.teamName,
        leadName,
        persistText,
        command.summary,
        attachmentMeta,
        command.taskRefs,
        messageId
      );
    } catch (error) {
      this.dependencies.logger.warn(
        `Persistence failed after stdin delivery for ${command.teamName}: ${String(error)}`
      );
      result = { deliveredToInbox: false, messageId };
    }

    this.dependencies.messaging.pushLiveLeadProcessMessage(command.teamName, {
      from: 'user',
      to: leadName,
      text: persistText,
      timestamp: this.dependencies.clock.nowIso(),
      read: true,
      summary: command.summary,
      messageId: result.messageId,
      source: 'user_sent',
      attachments: attachmentMeta,
      taskRefs: command.taskRefs,
      ...(slashCommandMeta
        ? { messageKind: 'slash_command' as const, slashCommand: slashCommandMeta }
        : {}),
    });
    return result;
  }
}
