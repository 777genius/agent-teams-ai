import { classifyIdleNotificationText } from '@shared/utils/idleNotificationSemantics';
import { createLogger } from '@shared/utils/logger';
import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import { createHash } from 'crypto';

import { getEffectiveInboxMessageId } from './inboxMessageIdentity';

import type { InboxMessage, TeamConfig } from '@shared/types';

const PASSIVE_USER_REPLY_LINK_WINDOW_MS = 15_000;
const MESSAGE_FEED_CACHE_MAX_AGE_MS = 5_000;
const logger = createLogger('Service:TeamMessageFeedService');

type TeamConfigMember = NonNullable<TeamConfig['members']>[number];

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

interface InFlightTeamMessageFeed {
  promise: Promise<TeamNormalizedMessageFeed>;
  generationAtStart: number;
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

function resolveLeadName(config: TeamConfig): string {
  const lead =
    config.members?.find((member) => member.agentType === 'team-lead' || member.role === 'Lead') ??
    config.members?.find((member) => member.name === 'team-lead') ??
    config.members?.[0];
  return lead?.name?.trim() || 'team-lead';
}

function resolveSyntheticBootstrapTimestamp(
  config: TeamConfig,
  member: TeamConfigMember
): string | null {
  const raw = member.joinedAt ?? (config as { createdAt?: unknown }).createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return new Date(raw).toISOString();
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function buildSyntheticBootstrapDisplayPrompt(
  config: TeamConfig,
  member: TeamConfigMember
): string {
  const role = member.role?.trim() || member.agentType?.trim() || 'team member';
  const displayName = config.description?.trim() || config.name;
  const providerId = member.providerId?.trim();
  const providerLine = providerId ? `\nProvider override for this teammate: ${providerId}.` : '';
  const modelLine = member.model?.trim()
    ? `\nModel override for this teammate: ${member.model.trim()}.`
    : '';
  const runtimeProviderField =
    providerId === 'opencode' || providerId === 'codex' ? `, runtimeProvider: "${providerId}"` : '';

  return `You are ${member.name}, a ${role} on team "${displayName}" (${config.name}).${providerLine}${modelLine}

The team has already been created and you are being attached as a persistent teammate.
Your FIRST action: call MCP tool member_briefing on the "agent-teams" server with:
{ teamName: "${config.name}", memberName: "${member.name}"${runtimeProviderField} }
Call member_briefing directly yourself. Do NOT use Agent, any subagent, or a delegated helper for this step.
After member_briefing succeeds, wait for instructions from the lead and use team mailbox/task tools normally.`;
}

function buildSyntheticBootstrapMessages(
  config: TeamConfig,
  fallbackTimestampForMessage: (messageId: string) => string
): InboxMessage[] {
  const members = Array.isArray(config.members) ? config.members : [];
  const leadName = resolveLeadName(config);
  const normalizedLeadName = leadName.trim().toLowerCase();
  return members
    .filter(
      (member) =>
        member &&
        member.name?.trim() &&
        member.name.trim().toLowerCase() !== normalizedLeadName &&
        member.removedAt == null
    )
    .map((member) => {
      const messageId = `bootstrap-start:${config.name}:${member.name}`;
      return {
        from: leadName,
        to: member.name,
        text: buildSyntheticBootstrapDisplayPrompt(config, member),
        timestamp:
          resolveSyntheticBootstrapTimestamp(config, member) ??
          fallbackTimestampForMessage(messageId),
        read: true,
        source: 'system_notification' as const,
        messageId,
      };
    });
}

function isVisibleTeamMessage(message: InboxMessage): boolean {
  return !isTeamInternalControlMessageEnvelope(message);
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
  private readonly inFlightByTeam = new Map<string, InFlightTeamMessageFeed>();
  private readonly generationByTeam = new Map<string, number>();
  private readonly syntheticBootstrapTimestampByMessageId = new Map<string, string>();

  constructor(private readonly deps: TeamMessageFeedDeps) {}

  invalidate(teamName: string): void {
    this.dirtyTeams.add(teamName);
    this.generationByTeam.set(teamName, this.getGeneration(teamName) + 1);
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
    if (cached && !cacheDirty && cacheExpired) {
      this.refreshCleanExpiredCacheInBackground(teamName, cached, now);
      return {
        teamName,
        feedRevision: cached.feedRevision,
        messages: cached.messages,
      };
    }

    const existingRequest = this.inFlightByTeam.get(teamName);
    const generationAtStart = this.getGeneration(teamName);
    if (existingRequest?.generationAtStart === generationAtStart) {
      return existingRequest.promise;
    }

    const request = this.buildFeed(
      teamName,
      cached,
      now,
      cacheDirty,
      cacheExpired,
      generationAtStart
    ).finally(() => {
      if (this.inFlightByTeam.get(teamName)?.promise === request) {
        this.inFlightByTeam.delete(teamName);
      }
    });
    this.inFlightByTeam.set(teamName, {
      promise: request,
      generationAtStart,
    });
    return request;
  }

  private getGeneration(teamName: string): number {
    return this.generationByTeam.get(teamName) ?? 0;
  }

  private getSyntheticBootstrapFallbackTimestamp(messageId: string): string {
    const existing = this.syntheticBootstrapTimestampByMessageId.get(messageId);
    if (existing) {
      return existing;
    }

    const timestamp = new Date(Date.now()).toISOString();
    this.syntheticBootstrapTimestampByMessageId.set(messageId, timestamp);
    return timestamp;
  }

  private refreshCleanExpiredCacheInBackground(
    teamName: string,
    cached: TeamMessageFeedCacheEntry,
    now: number
  ): void {
    const generationAtStart = this.getGeneration(teamName);
    const existingRequest = this.inFlightByTeam.get(teamName);
    if (existingRequest?.generationAtStart === generationAtStart) {
      return;
    }

    const request = this.buildFeed(teamName, cached, now, false, true, generationAtStart).catch(
      (error) => {
        logger.debug(
          `[${teamName}] background message feed refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return {
          teamName,
          feedRevision: cached.feedRevision,
          messages: cached.messages,
        };
      }
    );

    const trackedRequest = request.finally(() => {
      if (this.inFlightByTeam.get(teamName)?.promise === trackedRequest) {
        this.inFlightByTeam.delete(teamName);
      }
    });
    this.inFlightByTeam.set(teamName, {
      promise: trackedRequest,
      generationAtStart,
    });
  }

  private async buildFeed(
    teamName: string,
    cached: TeamMessageFeedCacheEntry | undefined,
    now: number,
    cacheDirty: boolean,
    cacheExpired: boolean,
    generationAtStart: number
  ): Promise<TeamNormalizedMessageFeed> {
    const startedAt = Date.now();
    const configStartedAt = Date.now();
    const config = await this.deps.getConfig(teamName);
    const configMs = Date.now() - configStartedAt;
    if (!config) {
      const emptyEntry = { feedRevision: toFeedRevision([]), messages: [], cachedAt: now };
      if (this.getGeneration(teamName) === generationAtStart) {
        this.cacheByTeam.set(teamName, emptyEntry);
        this.dirtyTeams.delete(teamName);
      }
      return { teamName, ...emptyEntry };
    }

    const sourceStartedAt = Date.now();
    const [inboxMessages, leadTexts, sentMessages] = await Promise.all([
      this.deps.getInboxMessages(teamName).catch(() => [] as InboxMessage[]),
      this.deps.getLeadSessionMessages(teamName, config).catch(() => [] as InboxMessage[]),
      this.deps.getSentMessages(teamName).catch(() => [] as InboxMessage[]),
    ]);
    const sourceMs = Date.now() - sourceStartedAt;

    const normalizeStartedAt = Date.now();
    const syntheticMessages = buildSyntheticBootstrapMessages(config, (messageId) =>
      this.getSyntheticBootstrapFallbackTimestamp(messageId)
    );
    let messages = [...inboxMessages, ...leadTexts, ...sentMessages, ...syntheticMessages].filter(
      isVisibleTeamMessage
    );
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
    const normalizeMs = Date.now() - normalizeStartedAt;
    const totalMs = Date.now() - startedAt;
    if (totalMs >= 750) {
      logger.warn(
        `[${teamName}] message feed build slow totalMs=${totalMs} configMs=${configMs} sourceMs=${sourceMs} normalizeMs=${normalizeMs} inbox=${inboxMessages.length} lead=${leadTexts.length} sent=${sentMessages.length} synthetic=${syntheticMessages.length} cacheDirty=${cacheDirty} cacheExpired=${cacheExpired}`
      );
    }
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

    if (this.getGeneration(teamName) === generationAtStart) {
      this.cacheByTeam.set(teamName, nextEntry);
      this.dirtyTeams.delete(teamName);
    }
    return {
      teamName,
      feedRevision: nextEntry.feedRevision,
      messages: nextEntry.messages,
    };
  }
}
