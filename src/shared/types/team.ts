export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  role?: string;
  color?: string;
  joinedAt?: number;
}

export interface TeamConfig {
  name: string;
  description?: string;
  color?: string;
  members?: TeamMember[];
  projectPath?: string;
  projectPathHistory?: string[];
  leadSessionId?: string;
  sessionHistory?: string[];
}

export interface TeamUpdateConfigRequest {
  name?: string;
  description?: string;
  color?: string;
}

export interface TeamSummaryMember {
  name: string;
  role?: string;
  color?: string;
}

export interface TeamSummary {
  teamName: string;
  displayName: string;
  description: string;
  color?: string;
  memberCount: number;
  members?: TeamSummaryMember[];
  taskCount: number;
  lastActivity: string | null;
  projectPath?: string;
  projectPathHistory?: string[];
  leadSessionId?: string;
  sessionHistory?: string[];
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  status: TeamTaskStatus;
  blocks?: string[];
  blockedBy?: string[];
  createdAt?: string;
  projectPath?: string;
}

export interface InboxMessage {
  from: string;
  to?: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
  messageId?: string;
  source?: 'inbox' | 'lead_session';
}

export interface SendMessageRequest {
  member: string;
  text: string;
  summary?: string;
  from?: string;
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  messageId: string;
}

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';
export type KanbanReviewStatus = 'pending' | 'error';

export interface KanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  reviewStatus?: KanbanReviewStatus;
  reviewer?: string | null;
  errorDescription?: string;
  movedAt: string;
}

export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
}

export type UpdateKanbanPatch =
  | { op: 'set_column'; column: Extract<KanbanColumnId, 'review' | 'approved'> }
  | { op: 'remove' }
  | { op: 'request_changes'; comment?: string };

export interface ResolvedTeamMember {
  name: string;
  status: MemberStatus;
  currentTaskId: string | null;
  taskCount: number;
  lastActiveAt: string | null;
  messageCount: number;
  color?: string;
  agentType?: string;
  role?: string;
}

export interface TeamData {
  teamName: string;
  config: TeamConfig;
  tasks: TeamTask[];
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  kanbanState: KanbanState;
  warnings?: string[];
  isAlive?: boolean;
}

export interface TeamLaunchRequest {
  teamName: string;
  cwd: string;
  prompt?: string;
}

export interface TeamLaunchResponse {
  runId: string;
}

export interface CreateTaskRequest {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
  prompt?: string;
  startImmediately?: boolean;
}

export interface TeamChangeEvent {
  type: 'config' | 'inbox' | 'task';
  teamName: string;
  detail?: string;
}

export type TeamProvisioningState =
  | 'idle'
  | 'validating'
  | 'spawning'
  | 'monitoring'
  | 'verifying'
  | 'ready'
  | 'disconnected'
  | 'failed'
  | 'cancelled';

export interface TeamProvisioningMemberInput {
  name: string;
  role?: string;
}

export interface TeamCreateRequest {
  teamName: string;
  displayName?: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
  cwd: string;
  prompt?: string;
}

export interface TeamCreateConfigRequest {
  teamName: string;
  displayName?: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
}

export interface TeamCreateResponse {
  runId: string;
}

export interface TeamProvisioningPrepareResult {
  ready: boolean;
  message: string;
  warnings?: string[];
}

export interface TeamProvisioningProgress {
  runId: string;
  teamName: string;
  state: Exclude<TeamProvisioningState, 'idle'>;
  message: string;
  startedAt: string;
  updatedAt: string;
  pid?: number;
  error?: string;
  warnings?: string[];
  cliLogsTail?: string;
}

export interface GlobalTask extends TeamTask {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
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

export type MemberLogKind = 'subagent' | 'lead_session';

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
}

export interface MemberSubagentLogSummary extends MemberLogSummaryBase {
  kind: 'subagent';
  subagentId: string;
}

export interface MemberLeadSessionLogSummary extends MemberLogSummaryBase {
  kind: 'lead_session';
}

export type MemberLogSummary = MemberSubagentLogSummary | MemberLeadSessionLogSummary;

export interface MemberFullStats {
  linesAdded: number;
  linesRemoved: number;
  filesTouched: string[];
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
