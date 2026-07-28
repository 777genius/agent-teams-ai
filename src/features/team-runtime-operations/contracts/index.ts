export {
  TEAM_ALIVE_LIST,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_RUNTIME_LOGS,
  TEAM_KILL_PROCESS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_RESTART_MEMBER,
  TEAM_RETRY_FAILED_RUNTIME_LANES,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_STOP,
} from './channels';

export interface RuntimeLogQuery {
  offset?: number;
  limit?: number;
}

export interface RuntimeLogResponse {
  lines: string[];
  total: number;
  hasMore: boolean;
  updatedAt?: string;
}

export interface RetryFailedRuntimeLanesResult {
  attempted: string[];
  confirmed: string[];
  pending: string[];
  failed: { memberName: string; error: string }[];
  skipped: { memberName: string; reason: string }[];
}

// Desktop compatibility exports. The feature root intentionally omits these
// provider-named aliases.
export type { RetryFailedOpenCodeSecondaryLanesResult } from './compatibility/open-code-runtime';
export {
  TEAM_GET_CLAUDE_LOGS,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
} from './compatibility/open-code-runtime';
