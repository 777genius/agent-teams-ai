/** Actual retained Host observations; no transcript/session-file or timestamp inference. */
export type HostActivityValue =
  | null
  | boolean
  | number
  | string
  | HostActivityValue[]
  | { [key: string]: HostActivityValue };
export type HostActivityContent =
  | {
      kind: 'text';
      messageRef: string;
      block: number;
      text: string;
      phase: 'snapshot' | 'complete';
    }
  | { kind: 'tool'; messageRef: string; toolRef: string; name: string; input: HostActivityValue }
  | { kind: 'tool-result'; toolRef: string; content: HostActivityValue; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; cumulativeCostUsd?: number }
  | { kind: 'compaction'; sourceRef: string; reason: 'manual' | 'automatic' | 'unknown' }
  | { kind: 'result'; outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; code?: string }
  | { kind: 'diagnostic'; code: string }
  | { kind: 'gap'; reason: string };
export interface HostSubagentActivity {
  kind: 'subagent';
  childId?: string;
  parentToolRef?: string;
  phase: 'started' | 'completed' | 'failed' | 'stopped' | 'fact' | 'interaction' | 'usage' | 'gap';
  fact?:
    | Exclude<HostActivityContent, { kind: 'usage' | 'result' }>
    | {
        kind: 'interaction';
        interactionRef: string;
        request:
          | { kind: 'permission'; tool: string; input: HostActivityValue }
          | { kind: 'question'; questions: HostActivityValue };
      };
  childTotalTokens?: number;
  childToolUses?: number;
  childDurationMs?: number;
  reason?: 'unattributed' | 'stale' | 'conflict' | 'limit';
}
export type HostActivityData = HostActivityContent | HostSubagentActivity;
export interface HostActivityFact {
  eventId: string;
  sequence: number;
  inputId?: string;
  data: HostActivityData;
}
export interface HostMemberActivityLog {
  kind: 'host_activity';
  /** Application identity only; never a native session ref or transcript path. */
  sessionId: string;
  memberId: string;
  memberName: string;
  generation: string | null;
  taskId?: string;
  description: string;
  startTime: null;
  durationMs: null;
  messageCount: number;
  isOngoing: boolean | null;
  events: HostActivityFact[];
  gaps: string[];
  lastOutputPreview?: string;
  lastThinkingPreview?: undefined;
  recentPreviews?: undefined;
}
export interface HostMemberActivityStats {
  kind: 'host_activity_stats';
  memberName: string;
  scope: 'retained_runtime_activity';
  generations: number;
  observedMessages: number;
  toolUsage: Record<string, number>;
  compactions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  gaps: string[];
  computedAt: string;
}

/** Original task-input anchors in the existing Task surfaces. No transcript path or inferred clock. */
export interface HostTaskLogSummary {
  id: string;
  sourceGeneration: string;
  sessionId: string;
  memberId: string;
  memberName: string;
  generation: string;
  inputId: string;
  eventCount: number;
  messageCount: number;
  gaps: string[];
}
export interface HostTaskActivityView {
  kind: 'host_task_activity';
  taskId: string;
  items: HostTaskLogSummary[];
  historyEvents?: import('./team').TaskHistoryEvent[];
  gaps: string[];
}
export interface HostTaskLogDetail {
  kind: 'host_task_log_detail';
  id: string;
  taskId: string;
  sourceGeneration: string;
  log: HostMemberActivityLog;
}
export type HostTaskLogDetailResult =
  | { status: 'ok'; detail: HostTaskLogDetail }
  | { status: 'missing' }
  | { status: 'stale' };
export interface HostTaskLogStream {
  kind: 'host_task_log_stream';
  taskId: string;
  logs: HostMemberActivityLog[];
  gaps: string[];
}
export interface HostTaskExactLogs {
  kind: 'host_task_exact_logs';
  taskId: string;
  items: HostTaskLogSummary[];
  gaps: string[];
}
