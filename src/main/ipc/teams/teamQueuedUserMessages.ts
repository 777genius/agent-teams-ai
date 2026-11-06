import {
  discardQueuedUserMessagesFromRows,
  listQueuedUserMessagesFromRows,
} from '@agent-teams/legacy-agent-host/lifecycle';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteInboxAsync } from '../../services/team/atomicWrite';
import { withFileLock } from '../../services/team/fileLock';
import { withInboxLock } from '../../services/team/inboxLock';

import type { DiscardQueuedUserMessagesResult, QueuedUserMessageSummary } from '@shared/types';
export {
  discardQueuedUserMessagesFromRows,
  isQueuedUserInboxRow,
  listQueuedUserMessagesFromRows,
} from '@agent-teams/legacy-agent-host/lifecycle';

function realpathIfExists(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/**
 * Same symlink-escape defense as TeamInboxWriter.resolveInboxPath: a segment
 * that lexically stays under teamsBasePath can still resolve outside it
 * through a symlink, so every existing path segment is re-checked against
 * its own realpath once the lexical check passes.
 */
function resolveSafeInboxPath(
  teamsBasePath: string,
  teamName: string,
  member: string
): string | null {
  const safeTeamName = teamName.trim();
  const safeMember = member.trim();
  if (!validateFileName(safeTeamName).valid || !validateFileName(safeMember).valid) {
    return null;
  }
  const teamDir = path.join(teamsBasePath, safeTeamName);
  const inboxDir = path.join(teamDir, 'inboxes');
  const inboxPath = path.join(inboxDir, `${safeMember}.json`);
  if (
    !isPathWithinRoot(teamDir, teamsBasePath) ||
    !isPathWithinRoot(inboxDir, teamDir) ||
    !isPathWithinRoot(inboxPath, inboxDir)
  ) {
    return null;
  }

  const realTeamsBasePath = realpathIfExists(teamsBasePath) ?? path.resolve(teamsBasePath);
  const realTeamDir = realpathIfExists(teamDir);
  if (realTeamDir && !isPathWithinRoot(realTeamDir, realTeamsBasePath)) {
    return null;
  }

  const teamRootForRealCheck = realTeamDir ?? path.resolve(teamDir);
  const realInboxDir = realpathIfExists(inboxDir);
  if (
    realInboxDir &&
    (!isPathWithinRoot(realInboxDir, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxDir, realTeamsBasePath))
  ) {
    return null;
  }

  const inboxRootForRealCheck = realInboxDir ?? path.resolve(inboxDir);
  const realInboxPath = realpathIfExists(inboxPath);
  if (
    realInboxPath &&
    (!isPathWithinRoot(realInboxPath, inboxRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, teamRootForRealCheck) ||
      !isPathWithinRoot(realInboxPath, realTeamsBasePath))
  ) {
    return null;
  }

  return inboxPath;
}

async function readInboxRows(inboxPath: string): Promise<unknown[] | null> {
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
    return null;
  }
  return Array.isArray(parsed) ? (parsed as unknown[]) : null;
}

export async function listQueuedUserMessages(
  teamsBasePath: string,
  teamName: string,
  member: string
): Promise<QueuedUserMessageSummary[]> {
  const inboxPath = resolveSafeInboxPath(teamsBasePath, teamName, member);
  if (!inboxPath) {
    throw new Error('Invalid inbox path');
  }
  const rows = await readInboxRows(inboxPath);
  // An inbox that cannot be parsed is not an empty inbox. The listing gates a
  // permanent-delete confirmation, so it has to fail the way the discard does
  // instead of reporting "nothing queued" for a queue it could not read.
  if (!rows) {
    throw new Error(`Inbox file for "${member}" is not a valid JSON message list`);
  }
  return listQueuedUserMessagesFromRows(rows);
}

/**
 * Deletes the named queued user messages from a member inbox under the inbox
 * lock and reports what changed: `discarded` is how many of the named rows were
 * still there, `remainingQueued` how many queued rows the inbox still holds -
 * which, because only named rows are removed, is the count that arrived while
 * the user was deciding.
 */
export async function discardQueuedUserMessages(
  teamsBasePath: string,
  teamName: string,
  member: string,
  messageIds: readonly string[]
): Promise<DiscardQueuedUserMessagesResult> {
  const inboxPath = resolveSafeInboxPath(teamsBasePath, teamName, member);
  if (!inboxPath) {
    throw new Error('Invalid inbox path');
  }

  let result: DiscardQueuedUserMessagesResult = { discarded: 0, remainingQueued: 0 };
  await withFileLock(inboxPath, async () => {
    await withInboxLock(inboxPath, async () => {
      const rows = await readInboxRows(inboxPath);
      if (!rows) {
        throw new Error(`Inbox file for "${member}" is not a valid JSON message list`);
      }
      const { kept, discarded } = discardQueuedUserMessagesFromRows(rows, messageIds);
      const remainingQueued = listQueuedUserMessagesFromRows(kept).length;
      if (discarded > 0) {
        await atomicWriteInboxAsync(inboxPath, JSON.stringify(kept, null, 2));
      }
      result = { discarded, remainingQueued };
    });
  });
  return result;
}
