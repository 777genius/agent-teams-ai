import type {
  InboxMessage,
  MessagesPage,
  TeamGetDataOptions,
  TeamMemberActivityMeta,
  TeamViewSnapshot,
} from '@shared/types';

export type MissingTeamState = 'provisioning' | 'draft' | null;

export interface TeamSnapshotReaderPort {
  getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot>;
}

export interface TeamMessagePageReaderPort {
  getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<MessagesPage>;
}

export interface TeamNotificationContextReaderPort {
  getTeamNotificationContext(
    teamName: string
  ): Promise<{ displayName: string; projectPath?: string }>;
}

export type TeamMessageFeedReaderPort = TeamMessagePageReaderPort &
  TeamNotificationContextReaderPort;

export interface TeamMemberActivityReaderPort {
  getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta>;
}

export interface TeamProcessHealthPort {
  trackProcessHealthForTeam?(teamName: string): void;
  untrackProcessHealthForTeam?(teamName: string): void;
}

export interface TeamDataWorkerPolicyPort {
  isAvailable(): boolean;
  isFatalError(error: unknown): boolean;
}

export type TeamSnapshotWorkerReadPort = TeamDataWorkerPolicyPort & TeamSnapshotReaderPort;

export interface TeamMessagesWorkerReadPort extends TeamDataWorkerPolicyPort {
  getMessagesPage(
    teamName: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<MessagesPage>;
}

export type TeamMemberActivityWorkerReadPort = TeamDataWorkerPolicyPort &
  TeamMemberActivityReaderPort;

export type TeamDataWorkerReadPort = TeamSnapshotWorkerReadPort &
  TeamMessagesWorkerReadPort &
  TeamMemberActivityWorkerReadPort;

export interface MissingTeamStateReaderPort {
  classifyBeforeRead(teamName: string): Promise<MissingTeamState>;
  classifyAfterNotFound(teamName: string): Promise<MissingTeamState>;
}

export interface TeamTaskActivityRepairPort {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

export interface TeamRuntimeReadPort {
  isTeamAlive(teamName: string): boolean;
}

export interface LiveLeadMessageReaderPort {
  getLiveLeadProcessMessages(teamName: string): InboxMessage[];
  getCurrentLeadSessionId(teamName: string): string | null;
}

export interface MessageMergePort {
  mergeMessages(durableMessages: InboxMessage[], liveMessages: InboxMessage[]): InboxMessage[];
  mergePage(input: {
    durableMessages: InboxMessage[];
    liveMessages: InboxMessage[];
    limit: number;
    feedRevision: string;
    durableHasMoreAfterWindow?: boolean;
  }): MessagesPage;
}

export interface TeamNotificationContext {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  teamIsAlive?: boolean;
  currentLeadSessionId?: string | null;
}

export interface TeamMessageNotificationScannerPort {
  scan(messages: readonly InboxMessage[], context: TeamNotificationContext): void;
  checkRateLimitMessages(messages: readonly InboxMessage[], context: TeamNotificationContext): void;
  checkApiErrorMessages(messages: readonly InboxMessage[], context: TeamNotificationContext): void;
}

export interface TeamEngagementPort {
  markEngaged(teamName: string): void;
}

export interface MainOperationTrackerPort {
  setCurrent(operation: string | null): void;
}

export interface TeamViewClockPort {
  now(): number;
}

export interface RuntimeEnvironmentPort {
  isPackaged(): boolean;
}

export interface TeamViewReadLoggerPort {
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export interface NewestMessagesPageReaderPort {
  execute(input: {
    teamName: string;
    limit: number;
    liveMessages: InboxMessage[];
    includeUndefinedCursorInFallback?: boolean;
  }): Promise<MessagesPage>;
}

export type TeamViewReadResult =
  | { kind: 'success'; data: TeamViewSnapshot }
  | { kind: 'failure'; error: string };
