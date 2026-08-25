import type {
  RetryFailedRuntimeLanesResult,
  RuntimeLogQuery,
  RuntimeLogResponse,
} from '../../../contracts';

export type TeamRuntimeLogQuery = RuntimeLogQuery;
export type TeamRuntimeLogResponse = RuntimeLogResponse;

interface TeamMemberLogSummaryBase {
  sessionId: string;
  projectId: string;
  description: string;
  memberName: string | null;
  startTime: string;
  durationMs: number;
  messageCount: number;
  isOngoing: boolean;
  filePath?: string;
  lastOutputPreview?: string;
  lastThinkingPreview?: string;
  recentPreviews?: { text: string; timestamp: string; kind: 'thinking' | 'output' }[];
}

export interface TeamMemberSubagentLogSummary extends TeamMemberLogSummaryBase {
  kind: 'subagent';
  subagentId: string;
}

export interface TeamLeadSessionLogSummary extends TeamMemberLogSummaryBase {
  kind: 'lead_session';
}

export interface TeamMemberSessionLogSummary extends TeamMemberLogSummaryBase {
  kind: 'member_session';
}

export type TeamMemberLogSummary =
  | TeamMemberSubagentLogSummary
  | TeamLeadSessionLogSummary
  | TeamMemberSessionLogSummary;

export interface TeamMemberFullStats {
  linesAdded: number;
  linesRemoved: number;
  filesTouched: string[];
  fileStats: Record<string, { added: number; removed: number }>;
  toolUsage: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  tasksCompleted: number;
  messageCount: number;
  totalDurationMs: number;
  sessionCount: number;
  computedAt: string;
}

export interface TeamLeadActivitySnapshot {
  state: 'active' | 'idle' | 'offline';
  runId: string | null;
}

export interface TeamLeadContextUsage {
  promptInputTokens: number | null;
  outputTokens: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextUsedPercent: number | null;
  promptInputSource:
    | 'anthropic_usage'
    | 'openai_responses_usage'
    | 'openai_chat_usage'
    | 'unavailable';
  updatedAt: string;
}

export interface TeamLeadContextUsageSnapshot {
  usage: TeamLeadContextUsage | null;
  runId: string | null;
}

export interface TeamMemberSpawnStatus {
  status: 'offline' | 'waiting' | 'spawning' | 'online' | 'error' | 'skipped';
  launchState:
    | 'starting'
    | 'runtime_pending_bootstrap'
    | 'runtime_pending_permission'
    | 'confirmed_alive'
    | 'failed_to_start'
    | 'skipped_for_launch';
  updatedAt: string;
}

export interface TeamMemberSpawnStatusesSnapshot {
  statuses: Record<string, TeamMemberSpawnStatus>;
  runId: string | null;
}

export interface TeamAgentRuntimeEntry {
  memberName: string;
  alive: boolean;
  restartable: boolean;
  updatedAt: string;
}

export interface TeamAgentRuntimeSnapshot {
  teamName: string;
  updatedAt: string;
  runId: string | null;
  members: Record<string, TeamAgentRuntimeEntry>;
}

export interface TeamTaskLogQuery {
  owner?: string;
  status?: string;
  intervals?: { startedAt: string; completedAt?: string }[];
  since?: string;
}

export interface RuntimeLogReaderPort {
  getRuntimeLogs(teamName: string, query?: TeamRuntimeLogQuery): Promise<TeamRuntimeLogResponse>;
}

type LegacyNamedRuntimeLogReaderPort = Record<
  `get${string}Logs`,
  (teamName: string, query?: TeamRuntimeLogQuery) => Promise<TeamRuntimeLogResponse>
>;

export type TeamRuntimeLogsPort = RuntimeLogReaderPort &
  LegacyNamedRuntimeLogReaderPort & {
    findMemberLogs(teamName: string, memberName: string): Promise<TeamMemberLogSummary[]>;
    findLogsForTask(
      teamName: string,
      taskId: string,
      options?: TeamTaskLogQuery
    ): Promise<TeamMemberLogSummary[]>;
    getMemberStats(teamName: string, memberName: string): Promise<TeamMemberFullStats>;
  };

export interface TeamTaskLogWorkerPort {
  isAvailable(): boolean;
  findLogsForTask(
    teamName: string,
    taskId: string,
    options?: TeamTaskLogQuery
  ): Promise<TeamMemberLogSummary[]>;
  fatalFailureMessage(error: unknown): string | null;
}

export interface TeamRuntimeStatusPort {
  getAliveTeams(): string[];
}

export interface TeamRuntimeDiagnosticsPort {
  getLeadActivityState(teamName: string): TeamLeadActivitySnapshot;
  getLeadContextUsage(teamName: string): TeamLeadContextUsageSnapshot;
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export interface TeamMemberSpawnStatusPort {
  getMemberSpawnStatuses(teamName: string): Promise<TeamMemberSpawnStatusesSnapshot>;
}

export interface TeamRuntimeLifecycleCommandPort {
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedRuntimeLanes(teamName: string): Promise<RetryFailedRuntimeLanesResult>;
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
