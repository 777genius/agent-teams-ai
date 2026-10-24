import type { HostMemberActivityLog, HostMemberActivityStats } from './teamActivity';

export interface MemberActivityMetaEntry {
  memberName: string;
  lastAuthoredMessageAt: string | null;
  messageCountExact: number;
  latestAuthoredMessageSignalsTermination: boolean;
}

export interface TeamMemberActivityMeta {
  teamName: string;
  computedAt: string;
  members: Record<string, MemberActivityMetaEntry>;
  feedRevision: string;
}

export type LeadActivityState = 'active' | 'idle' | 'offline';

export interface LeadActivitySnapshot {
  state: LeadActivityState;
  runId: string | null;
}

export interface LeadContextUsage {
  /** Prompt-side tokens currently occupying the context window. */
  promptInputTokens: number | null;
  /** Tokens generated in the latest response. */
  outputTokens: number | null;
  /** Total occupied context window tokens (prompt input + output). */
  contextUsedTokens: number | null;
  /** Model's context window size */
  contextWindowTokens: number | null;
  /** Context usage percentage (0-100) */
  contextUsedPercent: number | null;
  /** Which usage contract produced the prompt-side numbers. */
  promptInputSource:
    | 'anthropic_usage'
    | 'openai_responses_usage'
    | 'openai_chat_usage'
    | 'unavailable';
  /** ISO timestamp of last update */
  updatedAt: string;
}

export interface LeadContextUsageSnapshot {
  usage: LeadContextUsage | null;
  runId: string | null;
}

export interface MemberSubagentSummary {
  subagentId: string;
  sessionId: string;
  projectId: string;
  description: string;
  memberName: string | null;
  startTime: string;
  durationMs: number;
  messageCount: number;
  isOngoing: boolean;
}

export type MemberLogKind = 'subagent' | 'lead_session' | 'member_session';

export interface MemberLogSummaryBase {
  kind: MemberLogKind;
  sessionId: string;
  projectId: string;
  description: string;
  memberName: string | null;
  startTime: string;
  durationMs: number;
  messageCount: number;
  isOngoing: boolean;
  /** Absolute path to JSONL file when known (avoids redundant findMemberLogPaths scan). */
  filePath?: string;
  /** Short preview of the last assistant output (truncated). */
  lastOutputPreview?: string;
  /** Short preview of the last thinking block (truncated). */
  lastThinkingPreview?: string;
  /** Recent thinking/output previews with timestamps for task-scoped filtering. */
  recentPreviews?: { text: string; timestamp: string; kind: 'thinking' | 'output' }[];
}

export interface MemberSubagentLogSummary extends MemberLogSummaryBase {
  kind: 'subagent';
  subagentId: string;
}

export interface MemberLeadSessionLogSummary extends MemberLogSummaryBase {
  kind: 'lead_session';
}

export interface MemberSessionLogSummary extends MemberLogSummaryBase {
  kind: 'member_session';
}

/** Legacy transcript readers always return file-backed, timestamped log summaries. */
export type LegacyMemberLogSummary =
  | MemberSubagentLogSummary
  | MemberLeadSessionLogSummary
  | MemberSessionLogSummary;

export type MemberLogSummary = HostMemberActivityLog | LegacyMemberLogSummary;

export interface FileLineStats {
  added: number;
  removed: number;
}

export interface MemberFullStats {
  linesAdded: number;
  linesRemoved: number;
  filesTouched: string[];
  fileStats: Record<string, FileLineStats>;
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

export type MemberStatsResult = MemberFullStats | HostMemberActivityStats;
