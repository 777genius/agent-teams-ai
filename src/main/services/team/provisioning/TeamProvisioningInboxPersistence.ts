import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'path';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';
import { withInboxLock } from '../inboxLock';
import { getEffectiveInboxMessageId } from '../inboxMessageIdentity';

export interface TeamInboxReadFileOptions {
  timeoutMs: number;
  maxBytes: number;
}

export type TeamInboxReadFile = (
  filePath: string,
  opts: TeamInboxReadFileOptions
) => Promise<string | null>;

export interface MarkTeamInboxMessagesReadInput {
  teamName: string;
  member: string;
  messages: { messageId: string }[];
  readRegularFileUtf8: TeamInboxReadFile;
  timeoutMs: number;
  maxBytes: number;
  teamsBasePath?: string;
}

export async function markTeamInboxMessagesRead(
  input: MarkTeamInboxMessagesReadInput
): Promise<void> {
  const inboxPath = path.join(
    input.teamsBasePath ?? getTeamsBasePath(),
    input.teamName,
    'inboxes',
    `${input.member}.json`
  );

  await withFileLock(inboxPath, async () => {
    await withInboxLock(inboxPath, async () => {
      const raw = await input.readRegularFileUtf8(inboxPath, {
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
      });
      if (!raw) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;

      const ids = new Set(
        input.messages.map((message) => message.messageId).filter((id) => id.trim().length > 0)
      );

      let changed = false;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const messageId = getEffectiveInboxMessageId(row);
        if (!messageId || !ids.has(messageId)) continue;

        if (row.read !== true) {
          row.read = true;
          changed = true;
        }
      }

      if (!changed) return;
      await atomicWriteAsync(inboxPath, JSON.stringify(parsed, null, 2));
    });
  });
}
