import {
  TeamLeadSessionMessageReader,
  type TeamLeadSessionMessageReaderParseCache,
  type TeamLeadSessionMessageReaderProjectResolver,
  TeamViewSnapshotAssembler,
  type TeamViewSnapshotAssemblerPorts,
} from '@features/team-view-read-model/main';

import { MemberActivityMetaService } from './MemberActivityMetaService';
import { mergeLiveLeadProcessMessagesPage } from './mergeLiveLeadProcessMessages';
import { capMessagesPageLiveOverlay } from './teamInboxOrdering';
import { TeamMessageFeedService } from './TeamMessageFeedService';

import type { PersistedTaskChangePresenceIndex } from './cache/taskChangePresenceCacheTypes';
import type { InboxMessageCursor, InboxMessagesWindow } from './TeamInboxReader';
import type { TaskChangeLogSourceSnapshot } from './TeamTaskReadModelService';
import type {
  InboxMessage,
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types';

const TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS = 5_000;

export interface TeamNotificationContext {
  displayName: string;
  projectPath?: string;
}

interface TeamNotificationContextCacheEntry {
  value: TeamNotificationContext;
  cachedAt: number;
  generation: number;
}

interface InFlightTeamNotificationContext {
  promise: Promise<TeamNotificationContext>;
  generation: number;
}

export interface TeamViewReadModelServicePorts extends TeamViewSnapshotAssemblerPorts<
  PersistedTaskChangePresenceIndex,
  TaskChangeLogSourceSnapshot
> {
  projectResolver: TeamLeadSessionMessageReaderProjectResolver;
  leadSessionParseCache?: TeamLeadSessionMessageReaderParseCache;
  readInboxMessages(teamName: string): Promise<InboxMessage[]>;
  readInboxMessagesWindow?(
    teamName: string,
    options: { cursor?: InboxMessageCursor | null; limit: number }
  ): Promise<InboxMessagesWindow>;
  readSentMessages(teamName: string): Promise<InboxMessage[]>;
}

export class TeamViewReadModelService {
  private readonly teamViewSnapshotAssembler: TeamViewSnapshotAssembler<
    PersistedTaskChangePresenceIndex,
    TaskChangeLogSourceSnapshot
  >;
  private readonly leadSessionMessageReader: TeamLeadSessionMessageReader;
  private readonly messageFeedService: TeamMessageFeedService;
  private readonly memberActivityMetaService: MemberActivityMetaService;
  private readonly notificationContextCache = new Map<string, TeamNotificationContextCacheEntry>();
  private readonly notificationContextInFlight = new Map<string, InFlightTeamNotificationContext>();
  private readonly notificationContextGenerationByTeam = new Map<string, number>();

  constructor(private readonly ports: TeamViewReadModelServicePorts) {
    this.teamViewSnapshotAssembler = new TeamViewSnapshotAssembler(ports);
    this.leadSessionMessageReader = new TeamLeadSessionMessageReader(
      ports.projectResolver,
      ports.leadSessionParseCache ?? TeamLeadSessionMessageReader.createParseCache()
    );
    const readInboxMessagesWindow = ports.readInboxMessagesWindow;
    this.messageFeedService = new TeamMessageFeedService({
      getConfig: (teamName) => ports.readConfig(teamName),
      getInboxMessages: (teamName) => ports.readInboxMessages(teamName),
      getInboxMessagesWindow: readInboxMessagesWindow
        ? (teamName, options) => readInboxMessagesWindow(teamName, options)
        : undefined,
      getLeadSessionMessages: (teamName, config) =>
        this.leadSessionMessageReader.read(teamName, config),
      getSentMessages: (teamName) => ports.readSentMessages(teamName),
    });
    this.memberActivityMetaService = new MemberActivityMetaService(this.messageFeedService);
  }

  getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    return this.teamViewSnapshotAssembler.getTeamData(teamName, options);
  }

  async getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number; liveMessages?: InboxMessage[] }
  ): Promise<MessagesPage> {
    const liveMessages = capMessagesPageLiveOverlay(options.liveMessages);
    const pageOptions =
      liveMessages.length > 0
        ? {
            ...options,
            liveMessages,
          }
        : {
            cursor: options.cursor,
            limit: options.limit,
          };
    const page = await this.messageFeedService.getPage(teamName, pageOptions);
    if (options.cursor || liveMessages.length === 0) {
      return {
        messages: page.messages,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        feedRevision: page.feedRevision,
      };
    }

    return mergeLiveLeadProcessMessagesPage({
      durableMessages: page.durableWindowMessages,
      liveMessages,
      limit: options.limit,
      feedRevision: page.feedRevision,
      durableHasMoreAfterWindow: page.durableHasMoreAfterWindow,
    });
  }

  getMessageFeed(
    teamName: string
  ): Promise<{ teamName: string; feedRevision: string; messages: InboxMessage[] }> {
    return this.messageFeedService.getFeed(teamName);
  }

  getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    return this.memberActivityMetaService.getMeta(teamName);
  }

  async getTeamDisplayName(teamName: string): Promise<string> {
    try {
      const config = await this.ports.readConfig(teamName);
      const displayName = config?.name?.trim();
      return displayName || teamName;
    } catch {
      return teamName;
    }
  }

  async getTeamNotificationContext(teamName: string): Promise<TeamNotificationContext> {
    const now = Date.now();
    const generation = this.getNotificationContextGeneration(teamName);
    const cached = this.notificationContextCache.get(teamName);
    if (
      cached?.generation === generation &&
      now - cached.cachedAt < TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS
    ) {
      return cached.value;
    }

    const existing = this.notificationContextInFlight.get(teamName);
    if (existing?.generation === generation) {
      return existing.promise;
    }

    const promise = this.readTeamNotificationContext(teamName, generation, now).finally(() => {
      if (this.notificationContextInFlight.get(teamName)?.promise === promise) {
        this.notificationContextInFlight.delete(teamName);
      }
    });
    this.notificationContextInFlight.set(teamName, { promise, generation });
    return promise;
  }

  invalidateMessageFeed(teamName: string): void {
    this.messageFeedService.invalidate(teamName);
    this.memberActivityMetaService.invalidate(teamName);
  }

  invalidateNotificationContext(teamName: string): void {
    this.notificationContextCache.delete(teamName);
    this.notificationContextGenerationByTeam.set(
      teamName,
      this.getNotificationContextGeneration(teamName) + 1
    );
  }

  private getNotificationContextGeneration(teamName: string): number {
    return this.notificationContextGenerationByTeam.get(teamName) ?? 0;
  }

  private async readTeamNotificationContext(
    teamName: string,
    generationAtStart: number,
    now: number
  ): Promise<TeamNotificationContext> {
    try {
      const config = await this.ports.readConfig(teamName);
      const displayName = config?.name?.trim() || teamName;
      const projectPath =
        typeof config?.projectPath === 'string' && config.projectPath.trim().length > 0
          ? config.projectPath
          : undefined;
      const value: TeamNotificationContext = projectPath
        ? { displayName, projectPath }
        : { displayName };
      this.cacheNotificationContext(teamName, generationAtStart, now, value);
      return value;
    } catch {
      const value = { displayName: teamName };
      this.cacheNotificationContext(teamName, generationAtStart, now, value);
      return value;
    }
  }

  private cacheNotificationContext(
    teamName: string,
    generationAtStart: number,
    cachedAt: number,
    value: TeamNotificationContext
  ): void {
    if (this.getNotificationContextGeneration(teamName) === generationAtStart) {
      this.notificationContextCache.set(teamName, {
        value,
        cachedAt,
        generation: generationAtStart,
      });
    }
  }
}
