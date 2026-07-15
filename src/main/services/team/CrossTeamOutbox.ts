import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

import type { CrossTeamMessage } from '@shared/types';

const CROSS_TEAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface CrossTeamDedupeOptions {
  stableIdentity?: boolean;
}

function normalizeForDedupe(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeTaskRefsForDedupe(message: CrossTeamMessage): string {
  return message.taskRefs?.length ? JSON.stringify(message.taskRefs) : '';
}

function buildCrossTeamRouteKey(message: CrossTeamMessage): string[] {
  return [
    normalizeForDedupe(message.fromTeam),
    normalizeForDedupe(message.fromMember),
    normalizeForDedupe(message.toTeam),
    normalizeForDedupe(message.toMember),
  ];
}

function stableMessageId(message: CrossTeamMessage): string {
  return String(message.messageId ?? '').trim();
}

function stableConversationId(message: CrossTeamMessage): string {
  return String(message.conversationId ?? '').trim();
}

function buildCrossTeamDedupeKey(message: CrossTeamMessage): string {
  return [
    ...buildCrossTeamRouteKey(message),
    normalizeForDedupe(message.summary),
    normalizeForDedupe(message.text),
    normalizeTaskRefsForDedupe(message),
  ].join('||');
}

function hasSameRoute(left: CrossTeamMessage, right: CrossTeamMessage): boolean {
  return buildCrossTeamRouteKey(left).join('||') === buildCrossTeamRouteKey(right).join('||');
}

function hasMatchingStableIdentity(left: CrossTeamMessage, right: CrossTeamMessage): boolean {
  const leftMessageId = stableMessageId(left);
  const rightMessageId = stableMessageId(right);
  if (leftMessageId && rightMessageId && leftMessageId === rightMessageId) {
    return true;
  }

  const leftConversationId = stableConversationId(left);
  const rightConversationId = stableConversationId(right);
  return Boolean(
    leftConversationId && rightConversationId && leftConversationId === rightConversationId
  );
}

function isDuplicateCrossTeamMessage(
  entry: CrossTeamMessage,
  message: CrossTeamMessage,
  dedupeKey: string,
  options: CrossTeamDedupeOptions
): boolean {
  if (options.stableIdentity && hasSameRoute(entry, message)) {
    return hasMatchingStableIdentity(entry, message);
  }

  return buildCrossTeamDedupeKey(entry) === dedupeKey;
}

function findRecentDuplicate(
  list: CrossTeamMessage[],
  message: CrossTeamMessage,
  windowMs: number,
  options: CrossTeamDedupeOptions
): CrossTeamMessage | null {
  const dedupeKey = buildCrossTeamDedupeKey(message);
  const cutoff = Date.now() - windowMs;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) {
      continue;
    }
    if (isDuplicateCrossTeamMessage(entry, message, dedupeKey, options)) {
      return entry;
    }
  }

  return null;
}

export class CrossTeamOutbox {
  private getOutboxPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'sent-cross-team.json');
  }

  private async readUnlocked(outboxPath: string): Promise<CrossTeamMessage[]> {
    try {
      const raw = await fs.promises.readFile(outboxPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as CrossTeamMessage[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async append(teamName: string, message: CrossTeamMessage): Promise<void> {
    const outboxPath = this.getOutboxPath(teamName);
    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      list.push(message);
      await atomicWriteAsync(outboxPath, JSON.stringify(list, null, 2));
    });
  }

  async appendIfNotRecent(
    teamName: string,
    message: CrossTeamMessage,
    onBeforeAppend: () => Promise<void>,
    windowMs = CROSS_TEAM_DEDUPE_WINDOW_MS,
    options: CrossTeamDedupeOptions = {}
  ): Promise<{ duplicate: CrossTeamMessage | null }> {
    const outboxPath = this.getOutboxPath(teamName);
    let duplicate: CrossTeamMessage | null = null;

    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      duplicate = findRecentDuplicate(list, message, windowMs, options);
      if (duplicate) return;

      await onBeforeAppend();

      list.push(message);
      await atomicWriteAsync(outboxPath, JSON.stringify(list, null, 2));
    });

    return { duplicate };
  }

  async read(teamName: string): Promise<CrossTeamMessage[]> {
    const outboxPath = this.getOutboxPath(teamName);
    return this.readUnlocked(outboxPath);
  }
}
