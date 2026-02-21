import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type { InboxMessage } from '@shared/types';

export class TeamInboxReader {
  async listInboxNames(teamName: string): Promise<string[]> {
    const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');

    let entries: string[];
    try {
      entries = await fs.promises.readdir(inboxDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return entries
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => name.replace(/\.json$/, ''));
  }

  async getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> {
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${member}.json`);

    let raw: string;
    try {
      raw = await fs.promises.readFile(inboxPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
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
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as Partial<InboxMessage>;
      if (
        typeof row.from !== 'string' ||
        typeof row.text !== 'string' ||
        typeof row.timestamp !== 'string'
      ) {
        continue;
      }
      messages.push({
        from: row.from,
        to: typeof row.to === 'string' ? row.to : undefined,
        text: row.text,
        timestamp: row.timestamp,
        read: typeof row.read === 'boolean' ? row.read : false,
        summary: typeof row.summary === 'string' ? row.summary : undefined,
        color: typeof row.color === 'string' ? row.color : undefined,
        messageId: typeof row.messageId === 'string' ? row.messageId : undefined,
      });
    }

    messages.sort((a, b) => {
      const bt = Date.parse(b.timestamp);
      const at = Date.parse(a.timestamp);
      if (Number.isNaN(bt) || Number.isNaN(at)) {
        return 0;
      }
      return bt - at;
    });

    return messages;
  }

  async getMessages(teamName: string): Promise<InboxMessage[]> {
    const members = await this.listInboxNames(teamName);
    const chunks = await Promise.all(
      members.map(async (member) => {
        try {
          const msgs = await this.getMessagesFor(teamName, member);
          for (const msg of msgs) {
            if (!msg.to) {
              msg.to = member;
            }
          }
          return msgs;
        } catch {
          return [] as InboxMessage[];
        }
      })
    );

    const merged = chunks.flat();
    merged.sort((a, b) => {
      const bt = Date.parse(b.timestamp);
      const at = Date.parse(a.timestamp);
      if (Number.isNaN(bt) || Number.isNaN(at)) {
        return 0;
      }
      return bt - at;
    });
    return merged;
  }
}
