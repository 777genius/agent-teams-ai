import { classifyIdleNotificationText } from '@shared/utils/idleNotificationSemantics';
import { createLogger } from '@shared/utils/logger';
import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';
import { createHash } from 'crypto';

import { getEffectiveInboxMessageId } from './inboxMessageIdentity';

import type { InboxMessage, TeamConfig } from '@shared/types';

const PASSIVE_USER_REPLY_LINK_WINDOW_MS = 15_000;
const MESSAGE_FEED_CACHE_MAX_AGE_MS = 5_000;
const logger = createLogger('Service:TeamMessageFeedService');

interface TeamMessageFeedDeps {
  getConfig: (teamName: string) => Promise<TeamConfig | null>;
  getInboxMessages: (teamName: string) => Promise<InboxMessage[]>;
  getLeadSessionMessages: (teamName: string, config: TeamConfig) => Promise<InboxMessage[]>;
  getSentMessages: (teamName: string) => Promise<InboxMessage[]>;
}

interface TeamMessageFeedCacheEntry {
  feedRevision: string;
  messages: InboxMessage[];
  cachedAt: number;
}

export interface TeamNormalizedMessageFeed {
  teamName: string;
  feedRevision: string;
  messages: InboxMessage[];
}

function requireCanonicalMessageId(message: InboxMessage): string {
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId.length > 0) {
    return messageId;
  }
  throw new Error('Normalized team message is missing effective messageId');
}

function normalizePassiveUserReplyLinkText(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?…]+$/g, '')
    .trim();
}

function extractPassiveUserPeerSummaryBody(text: string): string | null {
  const classified = classifyIdleNotificationText(text);
  if (classified?.primaryKind !== 'heartbeat' || !classified.peerSummary) {
    return null;
  }

  const match = /^\[to\s+user\]\s*(.*)$/i.exec(classified.peerSummary);
  if (!match) {
    return null;
  }

  const body = match[1]?.trim() ?? '';
  return body.length > 0 ? body : null;
}

function isLeadThoughtCandidateForSlashResult(message: InboxMessage): boolean {
  if (typeof message.to === 'string' && message.to.trim().length > 0) return false;
  if (message.from === 'system') return false;
  return message.source === 'lead_session' || message.source === 'lead_process';
}

function annotateSlashCommandResponses(messages: InboxMessage[]): void {
  let pendingSlash = null as InboxMessage['slashCommand'] | null;

  for (const message of messages) {
    const slashCommand =
      message.source === 'user_sent'
        ? (message.slashCommand ?? buildStandaloneSlashCommandMeta(message.text))
        : null;

    if (slashCommand) {
      pendingSlash = slashCommand;
      continue;
    }

    if (!pendingSlash) {
      continue;
    }

    if (message.messageKind === 'slash_command_result') {
      continue;
    }

    if (isLeadThoughtCandidateForSlashResult(message)) {
      message.messageKind = 'slash_command_result';
      message.commandOutput = {
        stream: 'stdout',
        commandLabel: pendingSlash.command,
      };
      continue;
    }

    pendingSlash = null;
  }
}

function linkPassiveUserReplySummaries(messages: InboxMessage[]): InboxMessage[] {
  const canonicalReplies = messages
    .map((message) => {
      const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      if (!messageId || message.to !== 'user') {
        return null;
      }
      if (classifyIdleNotificationText(message.text)) {
        return null;
      }

      const time = Date.parse(message.timestamp);
      if (!Number.isFinite(time)) {
        return null;
      }

      return {
        messageId,
        from: message.from,
        time,
        normalizedSummary: normalizePassiveUserReplyLinkText(message.summary),
        normalizedText: normalizePassiveUserReplyLinkText(message.text),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (canonicalReplies.length === 0) {
    return messages;
  }

  let didLink = false;
  const linkedMessages = messages.map((message) => {
    if (
      typeof message.relayOfMessageId === 'string' &&
      message.relayOfMessageId.trim().length > 0
    ) {
      return message;
    }

    const body = extractPassiveUserPeerSummaryBody(message.text);
    if (!body) {
      return message;
    }

    const passiveTime = Date.parse(message.timestamp);
    if (!Number.isFinite(passiveTime)) {
      return message;
    }

    const normalizedBody = normalizePassiveUserReplyLinkText(body);
    if (!normalizedBody) {
      return message;
    }

    const matches = canonicalReplies.filter((candidate) => {
      if (candidate.from !== message.from) {
        return false;
      }
      const deltaMs = passiveTime - candidate.time;
      if (deltaMs < 0 || deltaMs > PASSIVE_USER_REPLY_LINK_WINDOW_MS) {
        return false;
      }
      if (candidate.normalizedSummary === normalizedBody) {
        return true;
      }
      return normalizedBody.length >= 6 && candidate.normalizedText.includes(normalizedBody);
    });

    if (matches.length !== 1) {
      return message;
    }

    didLink = true;
    return {
      ...message,
      relayOfMessageId: matches[0].messageId,
    };
  });

  return didLink ? linkedMessages : messages;
}

function dedupeLeadProcessCopies(
  messages: InboxMessage[],
  leadTexts: readonly InboxMessage[]
): InboxMessage[] {
  if (leadTexts.length === 0) {
    return messages;
  }

  const normalizeText = (text: string): string => text.trim().replace(/\r\n/g, '\n');
  const getFingerprint = (msg: Pick<InboxMessage, 'from' | 'text' | 'leadSessionId'>) =>
    `${msg.leadSessionId ?? ''}\0${msg.from}\0${normalizeText(msg.text ?? '')}`;

  const leadSessionFingerprints = new Set<string>();
  for (const msg of leadTexts) {
    if (msg.source === 'lead_session') {
      leadSessionFingerprints.add(getFingerprint(msg));
    }
  }

  return messages.filter((message) => {
    if (message.source !== 'lead_process') return true;
    if (message.to) return true;
    return !leadSessionFingerprints.has(getFingerprint(message));
  });
}

function choosePreferredMessage(current: InboxMessage, candidate: InboxMessage): InboxMessage {
  const score = (msg: InboxMessage): number => {
    let value = 0;
    if (msg.source !== 'lead_process') value += 4;
    if (msg.read === false) value += 2;
    if (msg.relayOfMessageId) value += 1;
    if (msg.summary) value += 1;
    if (msg.to) value += 1;
    return value;
  };

  const currentScore = score(current);
  const candidateScore = score(candidate);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  const currentTs = Date.parse(current.timestamp);
  const candidateTs = Date.parse(candidate.timestamp);
  if (Number.isFinite(currentTs) && Number.isFinite(candidateTs) && candidateTs !== currentTs) {
    return candidateTs > currentTs ? candidate : current;
  }

  return current;
}

function dedupeByMessageId(messages: InboxMessage[]): InboxMessage[] {
  const dedupedById = new Map<string, InboxMessage>();
  const dedupedWithoutId: InboxMessage[] = [];

  for (const message of messages) {
    const id = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    if (!id) {
      dedupedWithoutId.push(message);
      continue;
    }
    const existing = dedupedById.get(id);
    if (!existing) {
      dedupedById.set(id, message);
      continue;
    }
    dedupedById.set(id, choosePreferredMessage(existing, message));
  }

  return [...dedupedWithoutId, ...dedupedById.values()];
}

function ensureEffectiveMessageIds(messages: InboxMessage[]): InboxMessage[] {
  let changed = false;
  const normalized = messages.map((message) => {
    const effectiveMessageId = getEffectiveInboxMessageId(message);
    if (!effectiveMessageId || effectiveMessageId === message.messageId) {
      return message;
    }
    changed = true;
    return {
      ...message,
      messageId: effectiveMessageId,
    };
  });

  return changed ? normalized : messages;
}

function attachLeadSessionIds(config: TeamConfig, messages: InboxMessage[]): void {
  if (!config.leadSessionId && !messages.some((message) => message.leadSessionId)) {
    return;
  }

  messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const anchors: { time: number; sessionId: string }[] = [];
  for (const message of messages) {
    if (message.leadSessionId) {
      anchors.push({ time: Date.parse(message.timestamp), sessionId: message.leadSessionId });
    }
  }

  if (anchors.length > 0) {
    for (const message of messages) {
      if (message.leadSessionId) continue;
      const messageTime = Date.parse(message.timestamp);
      let best = anchors[0];
      let bestDistance = Math.abs(messageTime - best.time);
      for (const anchor of anchors) {
        const distance = Math.abs(messageTime - anchor.time);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = anchor;
        } else if (distance > bestDistance && anchor.time > messageTime) {
          break;
        }
      }
      message.leadSessionId = best.sessionId;
    }
    return;
  }

  if (!config.leadSessionId) {
    return;
  }

  for (const message of messages) {
    message.leadSessionId = config.leadSessionId;
  }
}

function toFeedRevision(messages: readonly InboxMessage[]): string {
  const stableMessages = messages.map((message) => ({
    messageId: message.messageId ?? null,
    relayOfMessageId: message.relayOfMessageId ?? null,
    from: message.from,
    to: message.to ?? null,
    text: message.text,
    timestamp: message.timestamp,
    read: message.read,
    summary: message.summary ?? null,
    color: message.color ?? null,
    source: message.source ?? null,
    attachments: message.attachments ?? null,
    leadSessionId: message.leadSessionId ?? null,
    conversationId: message.conversationId ?? null,
    replyToConversationId: message.replyToConversationId ?? null,
    toolSummary: message.toolSummary ?? null,
    toolCalls: message.toolCalls ?? null,
    messageKind: message.messageKind ?? null,
    slashCommand: message.slashCommand ?? null,
    commandOutput: message.commandOutput ?? null,
  }));

  return createHash('sha256').update(JSON.stringify(stableMessages)).digest('hex').slice(0, 24);
}

export class TeamMessageFeedService {
  private readonly cacheByTeam = new Map<string, TeamMessageFeedCacheEntry>();
  private readonly dirtyTeams = new Set<string>();

  constructor(private readonly deps: TeamMessageFeedDeps) {}

  invalidate(teamName: string): void {
    this.dirtyTeams.add(teamName);
  }

  async getFeed(teamName: string): Promise<TeamNormalizedMessageFeed> {
    const cached = this.cacheByTeam.get(teamName);
    const now = Date.now();
    const cacheDirty = this.dirtyTeams.has(teamName);
    const cacheExpired = !cached || now - cached.cachedAt >= MESSAGE_FEED_CACHE_MAX_AGE_MS;
    if (cached && !cacheDirty && !cacheExpired) {
      return {
        teamName,
        feedRevision: cached.feedRevision,
        messages: cached.messages,
      };
    }

    const config = await this.deps.getConfig(teamName);
    if (!config) {
      const emptyEntry = { feedRevision: toFeedRevision([]), messages: [], cachedAt: now };
      this.cacheByTeam.set(teamName, emptyEntry);
      this.dirtyTeams.delete(teamName);
      return { teamName, ...emptyEntry };
    }

    const [inboxMessages, leadTexts, sentMessages] = await Promise.all([
      this.deps.getInboxMessages(teamName).catch(() => [] as InboxMessage[]),
      this.deps.getLeadSessionMessages(teamName, config).catch(() => [] as InboxMessage[]),
      this.deps.getSentMessages(teamName).catch(() => [] as InboxMessage[]),
    ]);

    let messages = [...inboxMessages, ...leadTexts, ...sentMessages];
    messages = dedupeLeadProcessCopies(messages, leadTexts);
    messages = ensureEffectiveMessageIds(messages);
    messages = dedupeByMessageId(messages);
    messages = linkPassiveUserReplySummaries(messages);
    attachLeadSessionIds(config, messages);
    annotateSlashCommandResponses(messages);

    messages.sort((left, right) => {
      const diff = Date.parse(right.timestamp) - Date.parse(left.timestamp);
      if (diff !== 0) return diff;
      return requireCanonicalMessageId(left).localeCompare(requireCanonicalMessageId(right));
    });

    const feedRevision = toFeedRevision(messages);
    if (cached && !cacheDirty && cacheExpired && cached.feedRevision !== feedRevision) {
      logger.warn(
        `[${teamName}] Message feed cache expired without dirty invalidation and recovered newer durable messages`
      );
    }
    const nextEntry =
      cached?.feedRevision === feedRevision
        ? {
            ...cached,
            cachedAt: now,
          }
        : {
            feedRevision,
            messages,
            cachedAt: now,
          };

    this.cacheByTeam.set(teamName, nextEntry);
    this.dirtyTeams.delete(teamName);
    return {
      teamName,
      feedRevision: nextEntry.feedRevision,
      messages: nextEntry.messages,
    };
  }
}
