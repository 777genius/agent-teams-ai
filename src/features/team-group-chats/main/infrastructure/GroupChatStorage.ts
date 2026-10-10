import { atomicWriteAsync } from '@main/services/team/atomicWrite';
import { withFileLock } from '@main/services/team/fileLock';
import { withInboxLock } from '@main/services/team/inboxLock';
import { MAX_INBOX_FILE_BYTES } from '@main/services/team/TeamInboxReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { promises as fs } from 'fs';
import * as path from 'path';

import { assertValidGroupInboxRows } from '../../contracts';
import { GroupChatError } from '../../core/domain/groupChat';

import type { GroupChat } from '../../core/domain/groupChat';
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

function isNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === 'string' && name.trim() === name && !!name) &&
    new Set(value).size === value.length
  );
}

export class GroupChatStorage {
  async withRegistry<T>(
    teamName: string,
    action: (groups: GroupChat[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const file = await safeGroupTeamPath(teamName, 'group-chats.json');
    return withFileLock(file, async () => {
      const raw = await readBounded(file);
      let groups: GroupChat[] = [];
      if (raw !== undefined) {
        const document = raw as { version?: unknown; groups?: unknown };
        if (document?.version !== 1 || !Array.isArray(document.groups))
          throw new GroupChatError('storage-unavailable', 'Unsupported group registry');
        const ids = new Set<string>();
        for (const row of document.groups as GroupChat[]) {
          if (
            !row ||
            typeof row.id !== 'string' ||
            !row.id ||
            ids.has(row.id) ||
            typeof row.name !== 'string' ||
            !row.name.trim() ||
            typeof row.createdAt !== 'string' ||
            (row.archivedAt !== null && typeof row.archivedAt !== 'string') ||
            !row.membership ||
            (row.membership.kind === 'fixed'
              ? !isNames(row.membership.memberNames)
              : row.membership.kind !== 'auto' || !isNames(row.membership.excludedMemberNames))
          ) {
            throw new GroupChatError('storage-unavailable', 'Malformed group registry');
          }
          ids.add(row.id);
        }
        groups = document.groups as GroupChat[];
      }
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
