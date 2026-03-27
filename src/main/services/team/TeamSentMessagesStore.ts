import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { InboxMessage } from '@shared/types';

const MAX_MESSAGES = 200;
const MAX_SENT_MESSAGES_FILE_BYTES = 2 * 1024 * 1024;
const logger = createLogger('TeamSentMessagesStore');

export class TeamSentMessagesStore {
  private getFilePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'sentMessages.json');
  }

  async readMessages(teamName: string): Promise<InboxMessage[]> {
    const filePath = this.getFilePath(teamName);

    let raw: string;
    try {
      const stat = await fs.promises.stat(filePath);
      // Avoid hangs on non-regular files (FIFO, sockets) and huge/binary files.
      if (!stat.isFile() || stat.size > MAX_SENT_MESSAGES_FILE_BYTES) {
        return [];
      }
      raw = await readFileUtf8WithTimeout(filePath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      if (error instanceof FileReadTimeoutError) {
        logger.error(`Timed out reading sent messages for ${teamName}`);
        return [];
      }
      // Bug #4: graceful degradation instead of crashing
      logger.error(`Failed to read sent messages for ${teamName}: ${String(error)}`);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const messages: InboxMessage[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Partial<InboxMessage>;
      if (
        typeof row.from !== 'string' ||
        typeof row.text !== 'string' ||
        typeof row.timestamp !== 'string' ||
        typeof row.messageId !== 'string' ||
        row.messageId.trim().length === 0
      ) {
        continue;
      }
      // Bug #5: preserve optional fields (attachments, color)
      messages.push({
        from: row.from,
        to: typeof row.to === 'string' ? row.to : undefined,
        text: row.text,
        timestamp: row.timestamp,
        read: typeof row.read === 'boolean' ? row.read : true,
        taskRefs: Array.isArray(row.taskRefs) ? row.taskRefs : undefined,
        summary: typeof row.summary === 'string' ? row.summary : undefined,
        messageId: row.messageId,
        relayOfMessageId:
          typeof row.relayOfMessageId === 'string' ? row.relayOfMessageId : undefined,
        color: typeof row.color === 'string' ? row.color : undefined,
        attachments: Array.isArray(row.attachments) ? row.attachments : undefined,
        source: typeof row.source === 'string' ? (row.source as InboxMessage['source']) : undefined,
        leadSessionId: typeof row.leadSessionId === 'string' ? row.leadSessionId : undefined,
        conversationId: typeof row.conversationId === 'string' ? row.conversationId : undefined,
        replyToConversationId:
          typeof row.replyToConversationId === 'string' ? row.replyToConversationId : undefined,
        toolSummary: typeof row.toolSummary === 'string' ? row.toolSummary : undefined,
        toolCalls: Array.isArray(row.toolCalls)
          ? (row.toolCalls as unknown[])
              .filter(
                (tc): tc is { name: string; preview?: string } =>
                  tc != null &&
                  typeof tc === 'object' &&
                  typeof (tc as Record<string, unknown>).name === 'string'
              )
              .map((tc) => ({
                name: tc.name,
                preview: typeof tc.preview === 'string' ? tc.preview : undefined,
              }))
          : undefined,
        messageKind:
          row.messageKind === 'slash_command' || row.messageKind === 'slash_command_result'
            ? row.messageKind
            : row.messageKind === 'default'
              ? 'default'
              : undefined,
        slashCommand:
          row.slashCommand &&
          typeof row.slashCommand === 'object' &&
          typeof row.slashCommand.name === 'string' &&
          typeof row.slashCommand.command === 'string'
            ? {
                name: row.slashCommand.name,
                command: row.slashCommand.command as `/${string}`,
                args: typeof row.slashCommand.args === 'string' ? row.slashCommand.args : undefined,
                knownDescription:
                  typeof row.slashCommand.knownDescription === 'string'
                    ? row.slashCommand.knownDescription
                    : undefined,
              }
            : undefined,
        commandOutput:
          row.commandOutput &&
          typeof row.commandOutput === 'object' &&
          (row.commandOutput.stream === 'stdout' || row.commandOutput.stream === 'stderr') &&
          typeof row.commandOutput.commandLabel === 'string'
            ? {
                stream: row.commandOutput.stream,
                commandLabel: row.commandOutput.commandLabel,
              }
            : undefined,
      });
    }

    return messages;
  }

  async appendMessage(teamName: string, message: InboxMessage): Promise<void> {
    // Bug #6: wrap in try/catch to prevent crash on IO errors
    try {
      const existing = await this.readMessages(teamName);
      existing.push(message);

      // Trim to MAX_MESSAGES (keep newest)
      const trimmed = existing.length > MAX_MESSAGES ? existing.slice(-MAX_MESSAGES) : existing;

      await atomicWriteAsync(this.getFilePath(teamName), JSON.stringify(trimmed, null, 2));
    } catch (error) {
      logger.error(`Failed to append sent message for ${teamName}: ${String(error)}`);
    }
  }
}
