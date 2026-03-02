export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  role?: string;
  color?: string;
  joinedAt?: number;
  cwd?: string;
  removedAt?: number;
}

export interface TeamConfig {
  name: string;
  description?: string;
  color?: string;
  language?: string;
  members?: TeamMember[];
  projectPath?: string;
  projectPathHistory?: string[];
  leadSessionId?: string;
  sessionHistory?: string[];
  /** ISO timestamp — soft delete marker. If set, the team is considered deleted. */
  deletedAt?: string;
}

export interface TeamUpdateConfigRequest {
  name?: string;
  description?: string;
  color?: string;
  language?: string;
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
  /** Propagated from config.deletedAt — set when the team has been soft-deleted. */
  deletedAt?: string;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskWorkInterval {
  /** ISO timestamp when task entered in_progress */
  startedAt: string;
  /** ISO timestamp when task left in_progress (optional for active interval) */
  completedAt?: string;
}

export type TaskCommentType = 'regular' | 'review_request' | 'review_approved';

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  type: TaskCommentType;
}

// Fields are validated in TeamTaskReader.getTasks() using `satisfies Record<keyof TeamTask, unknown>`.
// Adding a field here without mapping it there will cause a compile error.
export interface TeamTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  createdBy?: string;
  status: TeamTaskStatus;
  /**
   * One task can be worked on in multiple disjoint periods (e.g. review sends it back to in_progress).
   * We persist intervals for reliable log attribution without relying on heuristics.
   */
  workIntervals?: TaskWorkInterval[];
  blocks?: string[];
  blockedBy?: string[];
  /**
   * Explicit task links (non-blocking). Used for navigation between related tasks,
   * e.g. "review task" ↔ "work task".
   */
  related?: string[];
  createdAt?: string;
  /** File modification time (mtime). Used for sorting by last activity. */
  updatedAt?: string;
  projectPath?: string;
  comments?: TaskComment[];
  /** Signals that the agent is blocked and needs clarification. "lead" = ask team lead, "user" = escalated to human. */
  needsClarification?: 'lead' | 'user';
  /** ISO timestamp — when the task was soft-deleted. Only set for status === 'deleted'. */
  deletedAt?: string;
}

/** Task enriched for UI/DTO use (overlay from kanban-state.json). */
export interface TeamTaskWithKanban extends TeamTask {
  /** Set when task is in team kanban (review or approved column). */
  kanbanColumn?: 'review' | 'approved';
}

export type AttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  size: number;
}

export interface AttachmentPayload extends AttachmentMeta {
  data: string;
}

export interface AttachmentFileData {
  id: string;
  data: string;
  mimeType: AttachmentMediaType;
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
  source?: 'inbox' | 'lead_session' | 'lead_process' | 'user_sent';
  attachments?: AttachmentMeta[];
}

export interface SendMessageRequest {
  member: string;
  text: string;
  summary?: string;
  from?: string;
  attachments?: AttachmentPayload[];
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
}

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export interface KanbanTaskState {
  column: Extract<KanbanColumnId, 'review' | 'approved'>;
  reviewer?: string | null;
  errorDescription?: string;
  movedAt: string;
}

export interface KanbanState {
  teamName: string;
  reviewers: string[];
  tasks: Record<string, KanbanTaskState>;
  /** Порядок id задач по колонкам для отображения на канбан-доске (drag-and-drop). */
  columnOrder?: Partial<Record<KanbanColumnId, string[]>>;
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
  cwd?: string;
  /** Set only when member's git branch differs from the lead's branch. */
  gitBranch?: string;
  removedAt?: number;
}

export interface TeamProcess {
  id: string;
  port?: number;
  url?: string;
  label: string;
  pid: number;
  claudeProcessId?: string;
  registeredBy?: string;
  command?: string;
  registeredAt: string;
  stoppedAt?: string;
}

export interface TeamData {
  teamName: string;
  config: TeamConfig;
  tasks: TeamTaskWithKanban[];
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  kanbanState: KanbanState;
  processes: TeamProcess[];
  warnings?: string[];
  isAlive?: boolean;
}

export interface TeamLaunchRequest {
  teamName: string;
  cwd: string;
  prompt?: string;
  model?: string;
  /** When true, skip --resume and start a fresh session (clears context memory). */
  clearContext?: boolean;
}

export interface TeamLaunchResponse {
  runId: string;
}

export interface CreateTaskRequest {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  startImmediately?: boolean;
}

export type LeadActivityState = 'active' | 'idle' | 'offline';

export interface TeamChangeEvent {
  type: 'config' | 'inbox' | 'task' | 'lead-activity' | 'process';
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
  model?: string;
}

export interface TeamCreateConfigRequest {
  teamName: string;
  displayName?: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
  cwd?: string;
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
  /** Accumulated assistant text output during provisioning (for live preview). */
  assistantOutput?: string;
}

export interface GlobalTask extends TeamTaskWithKanban {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  /** True when the parent team has been soft-deleted. */
  teamDeleted?: boolean;
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

export interface AddMemberRequest {
  name: string;
  role?: string;
}

export interface RemoveMemberRequest {
  name: string;
}

export interface UpdateMemberRoleRequest {
  name: string;
  role: string | undefined;
}

/** Data sent from renderer to main for native OS team message notification. */
export interface TeamMessageNotificationData {
  teamDisplayName: string;
  /** Who sent the message. */
  from: string;
  /** Who received the message (member name or "user"). */
  to?: string;
  /** Short summary shown in subtitle. */
  summary?: string;
  /** Full message body — displayed as notification body (truncated to 300 chars). */
  body: string;
  /** Optional sender color for visual context. */
  color?: string;
}
