import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';

import { normalizeMemberName, shortHash } from './memberLogStreamSourceUtils';

import type { InboxMessage } from '@shared/types';

const MAX_VISIBLE_ACTIVITY_MESSAGES_TO_CONSIDER = 160;
const MAX_VISIBLE_ACTIVITY_ENTRIES = 24;
const TEAM_MESSAGES_CACHE_TTL_MS = 1_500;
const HIDDEN_ACTIVITY_BLOCK_TAGS = [
  'info_for_agent',
  'opencode_runtime_identity',
  'opencode_app_message_delivery',
  'system-reminder',
] as const;

export interface OpenCodeVisibleActivityInboxReader {
  getMessages(teamName: string): Promise<InboxMessage[]>;
}

export interface OpenCodeMemberVisibleActivityEntry {
  id: string;
  timestamp: string;
  title: string;
  text: string;
  sourceLabel: string;
  message: InboxMessage;
}

export class OpenCodeMemberVisibleActivityReader {
  private readonly teamMessagesCache = new Map<
    string,
    { expiresAt: number; messages: readonly InboxMessage[] }
  >();
  private readonly teamMessagesInFlight = new Map<string, Promise<readonly InboxMessage[]>>();

  constructor(
    private readonly inboxReader: OpenCodeVisibleActivityInboxReader = new TeamInboxReader()
  ) {}

  async list(input: {
    teamName: string;
    memberName: string;
    forceRefresh?: boolean;
  }): Promise<OpenCodeMemberVisibleActivityEntry[]> {
    const normalizedMemberName = normalizeMemberName(input.memberName);
    const messages = (await this.getTeamMessages(input.teamName, input.forceRefresh === true))
      .filter((message) => isVisibleMemberActivityMessage(message, normalizedMemberName))
      .sort(compareInboxMessagesNewestFirst)
      .slice(0, MAX_VISIBLE_ACTIVITY_MESSAGES_TO_CONSIDER);

    const deduped = new Map<string, OpenCodeMemberVisibleActivityEntry>();
    for (const message of messages) {
      const entry = toVisibleActivityEntry(message);
      if (!entry || deduped.has(entry.id)) {
        continue;
      }
      deduped.set(entry.id, entry);
      if (deduped.size >= MAX_VISIBLE_ACTIVITY_ENTRIES) {
        break;
      }
    }

    return [...deduped.values()];
  }

  private async getTeamMessages(
    teamName: string,
    forceRefresh: boolean
  ): Promise<readonly InboxMessage[]> {
    const cacheKey = `${getTeamsBasePath()}::${teamName}`;
    if (!forceRefresh) {
      const cached = this.teamMessagesCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.messages;
      }
      const inFlight = this.teamMessagesInFlight.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }
    }

    const promise = this.inboxReader
      .getMessages(teamName)
      .then((messages) => {
        this.teamMessagesCache.set(cacheKey, {
          expiresAt: Date.now() + TEAM_MESSAGES_CACHE_TTL_MS,
          messages,
        });
        return messages;
      })
      .finally(() => {
        this.teamMessagesInFlight.delete(cacheKey);
      });
    this.teamMessagesInFlight.set(cacheKey, promise);
    return promise;
  }
}

export function sanitizeOpenCodeVisibleActivityText(value: string, limit?: number): string {
  const compact = stripAngleTags(removeHiddenActivityBlocks(value))
    .replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!limit || compact.length <= limit) {
    return compact;
  }
  const allowed = Math.max(1, limit - 3);
  return `${compact.slice(0, allowed)}...`;
}

function isVisibleMemberActivityMessage(
  message: InboxMessage,
  normalizedMemberName: string
): boolean {
  if (normalizeMemberName(message.from) !== normalizedMemberName) {
    return false;
  }
  if (!message.timestamp || !Number.isFinite(Date.parse(message.timestamp))) {
    return false;
  }
  const text = message.summary ?? message.text;
  if (!text || isInboxNoiseMessage(text)) {
    return false;
  }
  return sanitizeOpenCodeVisibleActivityText(text).length > 0;
}

function toVisibleActivityEntry(message: InboxMessage): OpenCodeMemberVisibleActivityEntry | null {
  const text = sanitizeOpenCodeVisibleActivityText(
    [message.summary, message.text].filter(Boolean).join('\n\n')
  );
  if (!text) {
    return null;
  }
  const id = buildVisibleActivityId(message);
  return {
    id,
    timestamp: message.timestamp,
    title: buildVisibleActivityTitle(message),
    text,
    sourceLabel: 'OpenCode visible activity',
    message,
  };
}

function buildVisibleActivityId(message: InboxMessage): string {
  const messageKey =
    message.messageId ??
    [message.timestamp, message.from, message.to ?? '', message.summary ?? '', message.text].join(
      '\u0000'
    );
  return `opencode-visible:${shortHash(messageKey)}`;
}

function buildVisibleActivityTitle(message: InboxMessage): string {
  if (message.messageKind === 'task_comment_notification' || isCommentSummary(message.summary)) {
    return 'Comment added';
  }
  if (message.messageKind === 'agent_error') {
    return 'Agent error';
  }
  const text = `${message.summary ?? ''} ${message.text ?? ''}`.toLowerCase();
  if (/\b(done|completed|approved|fixed|verified)\b/i.test(text) || /заверш|готов/i.test(text)) {
    return 'Task completed';
  }
  if (message.to) {
    return 'Message sent';
  }
  return 'Team message';
}

function isCommentSummary(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith('comment on #') === true;
}

function compareInboxMessagesNewestFirst(left: InboxMessage, right: InboxMessage): number {
  const byTime = Date.parse(right.timestamp) - Date.parse(left.timestamp);
  if (byTime !== 0) {
    return byTime;
  }
  return buildVisibleActivityId(right).localeCompare(buildVisibleActivityId(left));
}

function removeHiddenActivityBlocks(value: string): string {
  let result = value;
  for (const tag of HIDDEN_ACTIVITY_BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return result;
}

function stripAngleTags(value: string): string {
  let result = '';
  let insideTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!insideTag && char === '<') {
      const next = value[index + 1] ?? '';
      if (/[A-Za-z/!]/.test(next)) {
        insideTag = true;
        result += ' ';
        continue;
      }
    }
    if (insideTag) {
      if (char === '>') {
        insideTag = false;
        result += ' ';
      }
      continue;
    }
    result += char;
  }
  return result;
}
