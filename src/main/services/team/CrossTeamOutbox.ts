import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

import type { CrossTeamMessage, TaskRef } from '@shared/types';

const CROSS_TEAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export interface CrossTeamDedupeOptions {
  stableIdentity?: boolean;
  /** Trimmed caller-supplied ID; omit for generated IDs so conversation fallback remains active. */
  callerMessageId?: string;
  legacyToMember?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isTaskRef(value: unknown): value is TaskRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === 'string' &&
    value.taskId.trim().length > 0 &&
    typeof value.displayId === 'string' &&
    value.displayId.trim().length > 0 &&
    typeof value.teamName === 'string' &&
    value.teamName.trim().length > 0
  );
}

function normalizePersistedTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const taskRefs = value.filter(isTaskRef).map((taskRef) => ({
    taskId: taskRef.taskId.trim(),
    displayId: taskRef.displayId.trim(),
    teamName: taskRef.teamName.trim(),
  }));
  return taskRefs.length ? taskRefs : undefined;
}

function normalizePersistedMessage(value: unknown): CrossTeamMessage | null {
  if (!isRecord(value)) return null;

  const messageId = readRequiredString(value, 'messageId');
  const fromTeam = readRequiredString(value, 'fromTeam');
  const fromMember = readRequiredString(value, 'fromMember');
  const toTeam = readRequiredString(value, 'toTeam');
  const text = readRequiredString(value, 'text');
  const timestamp = readRequiredString(value, 'timestamp');
  if (!messageId || !fromTeam || !fromMember || !toTeam || !text || !timestamp) {
    return null;
  }

  const chainDepth =
    typeof value.chainDepth === 'number' && Number.isFinite(value.chainDepth)
      ? value.chainDepth
      : 0;
  const toMember = readOptionalString(value, 'toMember');
  const conversationId = readOptionalString(value, 'conversationId');
  const replyToConversationId = readOptionalString(value, 'replyToConversationId');
  const summary = readOptionalString(value, 'summary');
  const taskRefs = normalizePersistedTaskRefs(value.taskRefs);

  return {
    messageId,
    fromTeam,
    fromMember,
    toTeam,
    ...(toMember ? { toMember } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(replyToConversationId ? { replyToConversationId } : {}),
    text,
    ...(taskRefs ? { taskRefs } : {}),
    ...(summary ? { summary } : {}),
    chainDepth,
    timestamp,
  };
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

function buildCrossTeamRouteKey(message: CrossTeamMessage, legacyToMember?: string): string[] {
  return [
    normalizeForDedupe(message.fromTeam),
    normalizeForDedupe(message.fromMember),
    normalizeForDedupe(message.toTeam),
    normalizeForDedupe(message.toMember || legacyToMember),
  ];
}

function stableMessageId(message: CrossTeamMessage): string {
  return String(message.messageId ?? '').trim();
}

function stableConversationId(message: CrossTeamMessage): string {
  return String(message.conversationId ?? '').trim();
}

function buildCrossTeamDedupeKey(message: CrossTeamMessage, legacyToMember?: string): string {
  return [
    ...buildCrossTeamRouteKey(message, legacyToMember),
    normalizeForDedupe(message.summary),
    normalizeForDedupe(message.text),
    normalizeTaskRefsForDedupe(message),
  ].join('||');
}

function hasSameRoute(
  left: CrossTeamMessage,
  right: CrossTeamMessage,
  legacyToMember?: string
): boolean {
  return (
    buildCrossTeamRouteKey(left, legacyToMember).join('||') ===
    buildCrossTeamRouteKey(right).join('||')
  );
}

function hasMatchingStableIdentity(
  left: CrossTeamMessage,
  right: CrossTeamMessage,
  callerMessageId?: string
): boolean {
  const normalizedCallerMessageId = String(callerMessageId ?? '').trim();
  if (normalizedCallerMessageId) {
    return (
      stableMessageId(left) === normalizedCallerMessageId &&
      stableMessageId(right) === normalizedCallerMessageId
    );
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
  if (options.stableIdentity && hasSameRoute(entry, message, options.legacyToMember)) {
    return hasMatchingStableIdentity(entry, message, options.callerMessageId);
  }

  return buildCrossTeamDedupeKey(entry, options.legacyToMember) === dedupeKey;
}

function findRecentDuplicate(
  list: unknown[],
  message: CrossTeamMessage,
  windowMs: number,
  options: CrossTeamDedupeOptions
): CrossTeamMessage | null {
  const dedupeKey = buildCrossTeamDedupeKey(message);
  const cutoff = Date.now() - windowMs;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = normalizePersistedMessage(list[i]);
    if (!entry) continue;
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

  private async readUnlocked(outboxPath: string): Promise<unknown[]> {
    try {
      const raw = await fs.promises.readFile(outboxPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map((entry: unknown) => entry) : [];
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
    const list = await this.readUnlocked(outboxPath);
    return list
      .map((entry) => normalizePersistedMessage(entry))
      .filter((entry): entry is CrossTeamMessage => entry !== null);
  }
}
