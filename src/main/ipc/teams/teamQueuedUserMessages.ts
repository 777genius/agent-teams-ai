import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import * as fs from 'fs';
import * as path from 'path';

import { withFileLock } from '../../services/team/fileLock';
import { withInboxLock } from '../../services/team/inboxLock';
import { getEffectiveInboxMessageId } from '../../services/team/inboxMessageIdentity';

import type { DiscardQueuedUserMessagesResult, QueuedUserMessageSummary } from '@shared/types';

/**
 * A queued user message is an inbox row the runtime has not consumed yet:
 * `read: false` and `from: "user"`. Delivered messages (read: true) and
 * agent-to-agent messages must never be touched by discard operations.
 */
export function isQueuedUserInboxRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') {
    return false;
  }
  const record = row as Record<string, unknown>;
  return (
    record.read === false &&
    typeof record.from === 'string' &&
    record.from.trim().toLowerCase() === 'user'
  );
}

export function listQueuedUserMessagesFromRows(
  rows: readonly unknown[]
): QueuedUserMessageSummary[] {
  const queued: QueuedUserMessageSummary[] = [];
  for (const row of rows) {
    if (!isQueuedUserInboxRow(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const messageId = getEffectiveInboxMessageId(record);
    if (!messageId) {
      continue;
    }
    queued.push({
      messageId,
      text: typeof record.text === 'string' ? record.text : '',
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
      ...(typeof record.summary === 'string' && record.summary.trim()
        ? { summary: record.summary }
        : {}),
    });
  }
  return queued;
}

/**
 * Removes exactly the queued user rows named by `messageIds`.
 *
 * The ids are the ones the caller listed and had confirmed, so a queued row
 * that reached the inbox after that listing is not named and survives. There is
 * deliberately no "discard everything" form: it would delete rows nobody was
 * shown. Ids that no longer match a row are ignored - the runtime consuming a
 * message first is a normal race, not a failure.
 */
export function discardQueuedUserMessagesFromRows(
  rows: readonly unknown[],
  messageIds: readonly string[]
): { kept: unknown[]; discarded: number } {
  const targeted = new Set(messageIds);
  const kept: unknown[] = [];
  let discarded = 0;
  for (const row of rows) {
    if (isQueuedUserInboxRow(row)) {
      const rowMessageId = getEffectiveInboxMessageId(row as Record<string, unknown>);
      if (rowMessageId !== null && targeted.has(rowMessageId)) {
        discarded += 1;
        continue;
      }
    }
    kept.push(row);
  }
  return { kept, discarded };
}

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
  const inboxDir = path.join(teamsBasePath, safeTeamName, 'inboxes');
  const inboxPath = path.join(inboxDir, `${safeMember}.json`);
  if (!isPathWithinRoot(inboxDir, teamsBasePath) || !isPathWithinRoot(inboxPath, inboxDir)) {
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
        await atomicWriteAsync(inboxPath, JSON.stringify(kept, null, 2));
      }
      result = { discarded, remainingQueued };
    });
  });
  return result;
}
