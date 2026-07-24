import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
} from '@shared/types';

export interface TeamTaskLogQuery {
  owner?: string;
  status?: string;
  intervals?: { startedAt: string; completedAt?: string }[];
  since?: string;
}

export interface TeamRuntimeLogsPort {
  getClaudeLogs(teamName: string, query?: TeamClaudeLogsQuery): Promise<TeamClaudeLogsResponse>;
  findMemberLogs(teamName: string, memberName: string): Promise<MemberLogSummary[]>;
  findLogsForTask(
    teamName: string,
    taskId: string,
    options?: TeamTaskLogQuery
  ): Promise<MemberLogSummary[]>;
  getMemberStats(teamName: string, memberName: string): Promise<MemberFullStats>;
}

export interface TeamTaskLogWorkerPort {
  isAvailable(): boolean;
  findLogsForTask(
    teamName: string,
    taskId: string,
    options?: TeamTaskLogQuery
  ): Promise<MemberLogSummary[]>;
  fatalFailureMessage(error: unknown): string | null;
}

export interface TeamRuntimeStatusPort {
  getAliveTeams(): string[];
}

export interface TeamRuntimeDiagnosticsPort {
  getLeadActivityState(teamName: string): LeadActivitySnapshot;
  getLeadContextUsage(teamName: string): LeadContextUsageSnapshot;
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export interface TeamMemberSpawnStatusPort {
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
}

export interface TeamRuntimeLifecycleCommandPort {
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
}

export interface TeamRuntimeStopPort {
  stopTeam(teamName: string): Promise<void>;
}

export interface TeamRuntimeLivenessPort {
  isTeamAlive(teamName: string): boolean;
}

export interface TeamRuntimeProcess {
  label: string;
  port?: number;
}

export interface TeamRuntimeProcessPort {
  findProcess(teamName: string, pid: number): Promise<TeamRuntimeProcess | null>;
  killProcess(teamName: string, pid: number): Promise<void>;
}

export interface TeamRuntimeFeedPort {
  invalidateMessageFeed(teamName: string): void;
}

export interface TeamRuntimeMessagingPort {
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
}

export interface TeamRuntimeEffectsPort {
  addStopBreadcrumb(teamName: string): void;
}

export interface TeamRuntimeLoggerPort {
  error(message: string): void;
  warn(message: string): void;
}
