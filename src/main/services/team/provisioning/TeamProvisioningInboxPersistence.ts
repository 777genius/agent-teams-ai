import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { lstat } from 'fs/promises';
import * as path from 'path';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';
import { withInboxLock } from '../inboxLock';
import { getEffectiveInboxMessageId } from '../inboxMessageIdentity';

import { tryReadRegularFileUtf8 } from './TeamProvisioningRegularFileRead';
import { TEAM_JSON_READ_TIMEOUT_MS } from './TeamProvisioningRunModel';

// TeamInboxReader can surface messages from inbox files up to 10 MiB. Read-mark persistence
// must accept the same files or delivered messages remain unread and are relayed repeatedly.
const TEAM_INBOX_MARK_READ_MAX_BYTES = 10 * 1024 * 1024;

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

function resolveSafeInboxPath(input: MarkTeamInboxMessagesReadInput): string | null {
  const teamName = input.teamName.trim();
  const member = input.member.trim();
  if (!validateFileName(teamName).valid || !validateFileName(member).valid) {
    return null;
  }

  const teamsBasePath = input.teamsBasePath ?? getTeamsBasePath();
  const inboxDir = path.join(teamsBasePath, teamName, 'inboxes');
  const inboxPath = path.join(inboxDir, `${member}.json`);
  if (!isPathWithinRoot(inboxDir, teamsBasePath) || !isPathWithinRoot(inboxPath, inboxDir)) {
    return null;
  }
  return inboxPath;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function shouldSkipNonRegularInboxFile(inboxPath: string): Promise<boolean> {
  const stat = await lstat(inboxPath).catch((error: unknown) =>
    isNotFoundError(error) ? null : false
  );
  return stat === false || (stat !== null && !stat.isFile());
}

export async function markTeamInboxMessagesRead(
  input: MarkTeamInboxMessagesReadInput
): Promise<void> {
  const inboxPath = resolveSafeInboxPath(input);
  if (!inboxPath) {
    return;
  }

  await withFileLock(inboxPath, async () => {
    await withInboxLock(inboxPath, async () => {
      if (await shouldSkipNonRegularInboxFile(inboxPath)) {
        return;
      }

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

export type MarkTeamInboxMessagesReadWithDefaultsInput = Pick<
  MarkTeamInboxMessagesReadInput,
  'teamName' | 'member' | 'messages'
> &
  Pick<Partial<MarkTeamInboxMessagesReadInput>, 'teamsBasePath'>;

export function markTeamInboxMessagesReadWithDefaults(
  input: MarkTeamInboxMessagesReadWithDefaultsInput
): Promise<void> {
  return markTeamInboxMessagesRead({
    ...input,
    readRegularFileUtf8: tryReadRegularFileUtf8,
    timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
    maxBytes: TEAM_INBOX_MARK_READ_MAX_BYTES,
  });
}
