import type {
  HostedWebEffortLevel,
  HostedWebTeamFastMode,
  HostedWebTeamProviderId,
  HostedWebTeamReviewState,
  HostedWebTeamTaskStatus,
} from './primitives';

export const HOSTED_WEB_API_BASE = '/api/hosted/v1';
export const HOSTED_WEB_ERROR_CODE_PREFIX = `${HOSTED_WEB_API_BASE}/errors/` as const;
export const HOSTED_WEB_LAST_EVENT_ID_HEADER = 'Last-Event-ID';
export const HOSTED_WEB_EVENT_CURSOR_QUERY_PARAM = 'cursor';

export type HostedWebTeamId = string;
export type HostedWebMemberId = string;
export type HostedWebTaskId = string;
export type HostedWebRunId = string;
export type HostedWebEventCursor = string;
export type HostedWebTerminalSessionId = string;
export type HostedWebErrorCode = `${typeof HOSTED_WEB_ERROR_CODE_PREFIX}${string}`;

export interface HostedWebWorkspaceRef {
  id: string;
  displayName: string;
  repositoryLabel?: string;
  branchLabel?: string;
}

export interface HostedWebErrorResponse {
  error: {
    code: HostedWebErrorCode;
    message: string;
    retryable?: boolean;
  };
}

export interface HostedWebProjectSummary {
  workspaceRef: HostedWebWorkspaceRef;
}

export interface HostedWebProviderSelection {
  providerId: HostedWebTeamProviderId;
  modelId?: string;
  effort?: HostedWebEffortLevel;
  fastMode?: HostedWebTeamFastMode;
}

export interface HostedWebTeamMemberSummary {
  memberId: HostedWebMemberId;
  displayName: string;
  role?: string;
  color?: string;
  provider?: HostedWebProviderSelection;
  currentTaskId: HostedWebTaskId | null;
  taskCount: number;
  isolation?: 'shared-workspace' | 'managed-worktree';
}

export interface HostedWebTaskSummary {
  taskId: HostedWebTaskId;
  displayId?: string;
  subject: string;
  status: HostedWebTeamTaskStatus;
  ownerMemberId?: HostedWebMemberId;
  reviewState?: HostedWebTeamReviewState;
  blockedBy?: HostedWebTaskId[];
  related?: HostedWebTaskId[];
  createdAt?: string;
  updatedAt?: string;
  needsClarification?: 'lead' | 'user';
}

export interface HostedWebRuntimeSummary {
  isAlive: boolean;
  terminalAvailable: boolean;
  activeProcessCount: number;
}

export interface HostedWebTeamSummary {
  teamId: HostedWebTeamId;
  displayName: string;
  description: string;
  color?: string;
  project: HostedWebProjectSummary | null;
  members: HostedWebTeamMemberSummary[];
  taskCount: number;
  lastActivity: string | null;
  pendingCreate?: boolean;
  partialLaunchFailure?: boolean;
  runtime: HostedWebRuntimeSummary;
}

export interface HostedWebTeamsListResponse {
  teams: HostedWebTeamSummary[];
  degraded?: boolean;
}

export interface HostedWebKanbanColumn {
  status: HostedWebTeamTaskStatus | 'review' | 'approved';
  taskIds: HostedWebTaskId[];
}

export interface HostedWebTeamSnapshotResponse {
  team: HostedWebTeamSummary;
  tasks: HostedWebTaskSummary[];
  kanban: HostedWebKanbanColumn[];
  revision: string;
}

export interface HostedWebLaunchMemberRequest {
  displayName: string;
  role?: string;
  workflow?: string;
  isolation?: 'shared-workspace' | 'managed-worktree';
  provider?: HostedWebProviderSelection;
}

export interface HostedWebLaunchTeamRequest {
  workspaceRef: HostedWebWorkspaceRef;
  prompt?: string;
  provider?: HostedWebProviderSelection;
  members?: HostedWebLaunchMemberRequest[];
  limitContext?: boolean;
  requireManualApproval?: boolean;
}

export interface HostedWebLaunchTeamResponse {
  runId: HostedWebRunId;
  launchStatus: 'started' | 'already_launching' | 'already_running';
}

export interface HostedWebCreateTaskRequest {
  subject: string;
  description?: string;
  ownerMemberId?: HostedWebMemberId;
  blockedBy?: HostedWebTaskId[];
  related?: HostedWebTaskId[];
  prompt?: string;
  startImmediately?: boolean;
}

export interface HostedWebCreateTaskResponse {
  task: HostedWebTaskSummary;
}

export interface HostedWebTerminalSessionRequest {
  preferredMemberId?: HostedWebMemberId;
  cols?: number;
  rows?: number;
}

export interface HostedWebTerminalSessionResponse {
  terminalSessionId: HostedWebTerminalSessionId;
  webSocketUrl: string;
  expiresAt: string;
}

export function hostedWebErrorCode(code: string): HostedWebErrorCode {
  return code.startsWith(HOSTED_WEB_ERROR_CODE_PREFIX)
    ? (code as HostedWebErrorCode)
    : `${HOSTED_WEB_ERROR_CODE_PREFIX}${code.replace(/^\/+/, '')}`;
}

export function isHostedWebErrorCode(value: unknown): value is HostedWebErrorCode {
  return typeof value === 'string' && value.startsWith(HOSTED_WEB_ERROR_CODE_PREFIX);
}

export function hostedWebTeamsRoute(): string {
  return `${HOSTED_WEB_API_BASE}/teams`;
}

export function hostedWebTeamRoute(teamId: HostedWebTeamId): string {
  return `${HOSTED_WEB_API_BASE}/teams/${encodeURIComponent(teamId)}`;
}

export function hostedWebTeamLaunchRoute(teamId: HostedWebTeamId): string {
  return `${hostedWebTeamRoute(teamId)}/launch`;
}

export function hostedWebTeamTasksRoute(teamId: HostedWebTeamId): string {
  return `${hostedWebTeamRoute(teamId)}/tasks`;
}

export function hostedWebTeamEventsRoute(
  teamId: HostedWebTeamId,
  options: { cursor?: HostedWebEventCursor } = {}
): string {
  const params = new URLSearchParams({ teamId });
  if (options.cursor) {
    params.set(HOSTED_WEB_EVENT_CURSOR_QUERY_PARAM, options.cursor);
  }
  return `${HOSTED_WEB_API_BASE}/events?${params.toString()}`;
}

export function hostedWebTerminalSessionsRoute(teamId: HostedWebTeamId): string {
  return `${hostedWebTeamRoute(teamId)}/terminal/sessions`;
}
