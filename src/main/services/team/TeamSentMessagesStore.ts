import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { InboxMessage } from '@shared/types';

const MAX_MESSAGES = 200;
const logger = createLogger('TeamSentMessagesStore');

export class TeamSentMessagesStore {
  private getFilePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'sentMessages.json');
  }

  async readMessages(teamName: string): Promise<InboxMessage[]> {
    const filePath = this.getFilePath(teamName);

    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
        typeof row.timestamp !== 'string'
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
        summary: typeof row.summary === 'string' ? row.summary : undefined,
        messageId: typeof row.messageId === 'string' ? row.messageId : undefined,
        color: typeof row.color === 'string' ? row.color : undefined,
        attachments: Array.isArray(row.attachments) ? row.attachments : undefined,
        source: typeof row.source === 'string' ? (row.source as InboxMessage['source']) : undefined,
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
