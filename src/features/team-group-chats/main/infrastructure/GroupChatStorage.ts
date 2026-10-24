import { parseGroupRegistry } from '@agent-teams/legacy-agent-host/group-chats/policy';
import { atomicWriteAsync } from '@main/services/team/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { withInboxLock } from '@main/services/team/inboxLock';
import { MAX_INBOX_FILE_BYTES } from '@main/services/team/TeamInboxReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { promises as fs } from 'fs';
import * as path from 'path';

import { assertValidGroupInboxRows, hasGroupChatEnvelopeMarker } from '../../contracts';
import { GroupChatError } from '../../core/domain/groupChat';
import { parseGroupReactions } from '../../core/domain/groupReactions';

import type { GroupChat } from '../../core/domain/groupChat';
import type { GroupMessageReactions } from '../../core/domain/groupReactions';
import type { InboxMessage } from '@shared/types';

export async function safeGroupTeamPath(teamName: string, ...parts: string[]): Promise<string> {
  if (!validateFileName(teamName).valid || parts.some((part) => !validateFileName(part).valid)) {
    throw new GroupChatError('invalid-input', 'Invalid group chat path');
  }
  const base = getTeamsBasePath();
  const root = path.join(base, teamName);
  const realBase = await fs.realpath(base);
  const realRoot = await fs.realpath(root);
  if (!isPathWithinRoot(realRoot, realBase))
    throw new GroupChatError('invalid-input', 'Invalid team directory');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new GroupChatError('storage-unavailable', 'Group storage cannot be a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

async function readBounded(file: string): Promise<unknown> {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INBOX_FILE_BYTES)
      throw new Error('Invalid storage file');
    handle = await fs.open(file, 'r');
    const bytes = Buffer.alloc(MAX_INBOX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_INBOX_FILE_BYTES) throw new Error('Storage file too large');
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead)
      )
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new GroupChatError('storage-unavailable', `Cannot read group storage: ${String(error)}`);
  } finally {
    await handle?.close();
  }
}

export async function writeGroupStorage(file: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(raw, 'utf8') > MAX_INBOX_FILE_BYTES)
    throw new GroupChatError('storage-unavailable', 'Group storage size limit reached');
  await atomicWriteAsync(file, raw);
}

export class GroupChatStorage {
  teamRoot(teamName: string): Promise<string> {
    return safeGroupTeamPath(teamName);
  }
  logicalPost<T>(key: string, action: () => Promise<T>): Promise<T> {
    return withInboxLock(key, action);
  }
  /** Exact raw originals only; unreadable/ambiguous stores must never become authorization. */
  async readCreationOriginal(
    teamName: string,
    from: string,
    messageId: string
  ): Promise<Record<string, unknown>> {
    const files = [
      await safeGroupTeamPath(teamName, 'sentMessages.json'),
      await safeGroupTeamPath(teamName, 'inboxes', `${from}.json`),
      await safeGroupTeamPath(teamName, 'inboxes', 'user.json'),
    ];
    const matches: Record<string, unknown>[] = [];
    for (const file of files) {
      const raw = await readBounded(file);
      if (raw === undefined) continue;
      try {
        assertValidGroupInboxRows(raw);
      } catch {
        throw new GroupChatError('storage-unavailable', 'Malformed original message storage');
      }
      for (const row of raw) {
        if (
          row &&
          typeof row === 'object' &&
          (row as Record<string, unknown>).messageId === messageId
        ) {
          // Canonical group originals live only in the human inbox; direct originals do not.
          if (hasGroupChatEnvelopeMarker(row) !== (file === files[2]))
            throw new GroupChatError(
              'invalid-user-request',
              'Original is in the wrong conversation store'
            );
          matches.push(row as Record<string, unknown>);
        }
      }
    }
    if (matches.length !== 1)
      throw new GroupChatError('invalid-user-request', 'Original request is missing or ambiguous');
    return matches[0];
  }

  async readReactions(teamName: string): Promise<GroupMessageReactions[]> {
    const file = await safeGroupTeamPath(teamName, 'group-chat-reactions.json');
    return parseGroupReactions(await readBounded(file));
  }

  async withReactions<T>(
    teamName: string,
    action: (entries: GroupMessageReactions[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const file = await safeGroupTeamPath(teamName, 'group-chat-reactions.json');
    return withFileLock(file, async () => {
      const entries = parseGroupReactions(await readBounded(file));
      return action(entries, async () => {
        try {
          await writeGroupStorage(file, { version: 1, entries });
        } catch (error) {
          throw new GroupChatError(
            'storage-unavailable',
            `Cannot save reactions: ${String(error)}`
          );
        }
      });
    });
  }

  async withRegistry<T>(
    teamName: string,
    action: (groups: GroupChat[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const file = await safeGroupTeamPath(teamName, 'group-chats.json');
    return withFileLock(file, async () => {
      const raw = await readBounded(file);
      const groups = parseGroupRegistry(raw);
      return action(groups, () => writeGroupStorage(file, { version: 1, groups }));
    });
  }

  async withInbox<T>(
    teamName: string,
    member: string,
    action: (rows: InboxMessage[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const file = await safeGroupTeamPath(teamName, 'inboxes', `${member}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withFileLock(file, () =>
      withInboxLock(file, async () => {
        const raw = await readBounded(file);
        const rows = raw === undefined ? [] : raw;
        assertValidGroupInboxRows(rows);
        // Retain unrelated legacy entries byte-for-byte in value; never normalize/filter a writer source.
        return action(rows as InboxMessage[], () => writeGroupStorage(file, rows));
      })
    );
  }
}
