export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  role?: string;
  /** Per-agent workflow/instructions injected into spawn prompt. */
  workflow?: string;
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
export type TeamReviewState = 'none' | 'review' | 'needsFix' | 'approved';

export interface TaskWorkInterval {
  /** ISO timestamp when task entered in_progress */
  startedAt: string;
  /** ISO timestamp when task left in_progress (optional for active interval) */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Task History Events — unified workflow event log
// ---------------------------------------------------------------------------

interface TaskHistoryEventBase {
  id: string;
  timestamp: string;
  actor?: string;
}

export interface TaskCreatedEvent extends TaskHistoryEventBase {
  type: 'task_created';
  status: TeamTaskStatus;
}

export interface TaskStatusChangedEvent extends TaskHistoryEventBase {
  type: 'status_changed';
  from: TeamTaskStatus;
  to: TeamTaskStatus;
}

export interface TaskReviewRequestedEvent extends TaskHistoryEventBase {
  type: 'review_requested';
  from: TeamReviewState;
  to: 'review';
  reviewer?: string;
  note?: string;
}

export interface TaskReviewChangesRequestedEvent extends TaskHistoryEventBase {
  type: 'review_changes_requested';
  from: TeamReviewState;
  to: 'needsFix';
  note?: string;
}

export interface TaskReviewApprovedEvent extends TaskHistoryEventBase {
  type: 'review_approved';
  from: TeamReviewState;
  to: 'approved';
  note?: string;
}

export type TaskHistoryEvent =
  | TaskCreatedEvent
  | TaskStatusChangedEvent
  | TaskReviewRequestedEvent
  | TaskReviewChangesRequestedEvent
  | TaskReviewApprovedEvent;

export type TaskCommentType = 'regular' | 'review_request' | 'review_approved';

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  type: TaskCommentType;
  /** Attachments on this comment. Metadata only — files stored on disk. */
  attachments?: TaskAttachmentMeta[];
}

// Fields are validated in TeamTaskReader.getTasks() using `satisfies Record<keyof TeamTask, unknown>`.
// Adding a field here without mapping it there will cause a compile error.
export interface TeamTask {
  id: string;
  /** Human-friendly short task label shown in UI. Canonical identity remains `id`. */
  displayId?: string;
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
  /**
   * Unified workflow event log.
   * Append-only — records task creation, status changes, and review transitions.
   */
  historyEvents?: TaskHistoryEvent[];
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
  /** Attachments associated with this task. Metadata only — actual files stored on disk. */
  attachments?: TaskAttachmentMeta[];
  /** Derived review state — computed from historyEvents, not persisted as authority. */
  reviewState?: TeamReviewState;
}

/** Task enriched for UI/DTO use (overlay from kanban-state.json). */
export interface TeamTaskWithKanban extends TeamTask {
  /** Set when task is in team kanban (review or approved column). */
  kanbanColumn?: 'review' | 'approved';
  /** Reviewer assigned in kanban state, when applicable. */
  reviewer?: string | null;
}

/** Metadata for an attachment associated with a task or comment. */
export interface TaskAttachmentMeta {
  /** Unique attachment ID (uuid). */
  id: string;
  /** Original filename (e.g. "screenshot.png"). */
  filename: string;
  /** MIME type. */
  mimeType: AttachmentMediaType;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp when the attachment was added. */
  addedAt: string;
}

/** Payload for uploading an attachment with base64 data (renderer → main). */
export interface CommentAttachmentPayload {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  base64Data: string;
}

/**
 * Broad MIME type string (e.g. "image/png", "application/pdf").
 *
 * Note: the UI may still choose to preview only certain types (e.g. images),
 * but tasks/comments can store arbitrary attachments for agent workflows.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias for documentation/readability
export type AttachmentMediaType = string;

/** Supported image MIME types (used for preview/validation in UI). */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

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

/** Lightweight metadata for a single tool call (for UI display in tooltips). */
export interface ToolCallMeta {
  /** Tool name, e.g. "Read", "Bash", "Grep" */
  name: string;
  /** Human-readable preview extracted from input args, e.g. "index.ts", "grep -r foo" */
  preview?: string;
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
  source?:
    | 'inbox'
    | 'lead_session'
    | 'lead_process'
    | 'user_sent'
    | 'system_notification'
    | 'cross_team'
    | 'cross_team_sent';
  attachments?: AttachmentMeta[];
  /** Lead session ID that produced this message (for session boundary detection). */
  leadSessionId?: string;
  /** Stable cross-team thread ID shared across request/reply turns. */
  conversationId?: string;
  /** Explicit parent conversation/message reference for replies. */
  replyToConversationId?: string;
  /** Tool usage summary from assistant message, e.g. "3 tools (2 Read, Bash)" */
  toolSummary?: string;
  /** Structured tool call details for tooltip display. */
  toolCalls?: ToolCallMeta[];
}

export type AgentActionMode = 'do' | 'ask' | 'delegate';

export interface SendMessageRequest {
  member: string;
  text: string;
  actionMode?: AgentActionMode;
  summary?: string;
  from?: string;
  timestamp?: string;
  messageId?: string;
  /** Override the `to` field in the stored message (defaults to `member`). */
  to?: string;
  color?: string;
  attachments?: AttachmentPayload[];
  source?: InboxMessage['source'];
  /** Lead session ID for session boundary detection. */
  leadSessionId?: string;
  conversationId?: string;
  replyToConversationId?: string;
  toolSummary?: string;
  toolCalls?: ToolCallMeta[];
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
  deduplicated?: boolean;
}

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

/**
 * Spawn lifecycle status for a team member during team launch/reconnect.
 * - offline: not yet spawned (no Agent tool_use seen)
 * - spawning: Agent tool_use sent, awaiting tool_result
 * - online: tool_result received, agent is active
 * - error: spawn failed (tool_result with error)
 */
export type MemberSpawnStatus = 'offline' | 'spawning' | 'online' | 'error';

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
  workflow?: string;
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

export type EffortLevel = 'low' | 'medium' | 'high';

export interface TeamLaunchRequest {
  teamName: string;
  cwd: string;
  prompt?: string;
  model?: string;
  effort?: EffortLevel;
  /** When true, skip --resume and start a fresh session (clears context memory). */
  clearContext?: boolean;
  /** When false, run WITHOUT --dangerously-skip-permissions (manual tool approval). Default: true. */
  skipPermissions?: boolean;
  /** Worktree name — CLI: --worktree <name>. */
  worktree?: string;
  /** Raw custom CLI args string, shell-split and appended to CLI command. */
  extraCliArgs?: string;
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

export interface LeadContextUsage {
  /** Total tokens currently in context (input + cache_creation + cache_read) */
  currentTokens: number;
  /** Model's context window size */
  contextWindow: number;
  /** Usage percentage (0-100) */
  percent: number;
  /** ISO timestamp of last update */
  updatedAt: string;
}

export interface TeamChangeEvent {
  type:
    | 'config'
    | 'inbox'
    | 'task'
    | 'lead-activity'
    | 'lead-context'
    | 'lead-message'
    | 'process'
    | 'member-spawn';
  teamName: string;
  detail?: string;
}

/** Per-member spawn status entry, exposed to renderer via IPC. */
export interface MemberSpawnStatusEntry {
  status: MemberSpawnStatus;
  /** Error message when status === 'error'. */
  error?: string;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
}

export interface TeamClaudeLogsQuery {
  /** Offset in lines from the newest log line (0 = newest). */
  offset?: number;
  /** Max number of lines to return. */
  limit?: number;
}

export interface TeamClaudeLogsResponse {
  /** Log lines ordered newest-first. */
  lines: string[];
  /** Total number of buffered lines available in memory. */
  total: number;
  /** True when there are older lines beyond the current window. */
  hasMore: boolean;
  /** ISO timestamp of the last observed CLI output for this team. */
  updatedAt?: string;
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
  /** Per-agent workflow/instructions injected into spawn prompt. */
  workflow?: string;
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
  effort?: EffortLevel;
  /** When false, run WITHOUT --dangerously-skip-permissions (manual tool approval). Default: true. */
  skipPermissions?: boolean;
  /** Worktree name — CLI: --worktree <name>. */
  worktree?: string;
  /** Raw custom CLI args string, shell-split and appended to CLI command. */
  extraCliArgs?: string;
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
  /** Absolute path to JSONL file when known (avoids redundant findMemberLogPaths scan). */
  filePath?: string;
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
  workflow?: string;
}

export interface RemoveMemberRequest {
  name: string;
}

export interface UpdateMemberRoleRequest {
  name: string;
  role: string | undefined;
}

export interface ReplaceMembersRequest {
  members: TeamProvisioningMemberInput[];
}

/** Data sent from renderer to main for native OS team message notification. */
export interface TeamMessageNotificationData {
  teamDisplayName: string;
  /** Team directory name (for notification storage and deep-linking). */
  teamName?: string;
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
  /** Team event sub-type for notification categorization. */
  teamEventType?: 'task_clarification' | 'task_status_change';
  /** Stable key for storage deduplication. Required — no fallback to Date.now(). */
  dedupeKey?: string;
  /**
   * When true, the notification is stored in-app but no native OS toast is shown.
   * Used when per-type toggle is off — storage is unconditional,
   * but the user opted out of OS interruptions for this event type.
   */
  suppressToast?: boolean;
}

// =============================================================================
// Cross-Team Communication
// =============================================================================

export interface CrossTeamMessage {
  messageId: string;
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  conversationId?: string;
  replyToConversationId?: string;
  text: string;
  summary?: string;
  chainDepth: number;
  timestamp: string;
}

export interface CrossTeamSendRequest {
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  timestamp?: string;
  messageId?: string;
  conversationId?: string;
  replyToConversationId?: string;
  text: string;
  actionMode?: AgentActionMode;
  summary?: string;
  chainDepth?: number;
}

export interface CrossTeamSendResult {
  messageId: string;
  deliveredToInbox: boolean;
  deduplicated?: boolean;
}

// =============================================================================
// Tool Approval (control_request / control_response protocol)
// =============================================================================

/** A pending tool approval request from the CLI control_request protocol. */
export interface ToolApprovalRequest {
  requestId: string;
  /** Run ID — prevents stale approvals after stop→launch race. */
  runId: string;
  teamName: string;
  /** Which process sent this (e.g. 'lead'). */
  source: string;
  /** Tool name: 'Bash', 'Edit', 'Write', 'Read', etc. */
  toolName: string;
  /** Tool input parameters (e.g. { command: "ls" } for Bash). */
  toolInput: Record<string, unknown>;
  /** ISO timestamp when the request was received. */
  receivedAt: string;
}

/** Dismissal event — process died, all pending approvals for this team+run should be removed. */
export interface ToolApprovalDismiss {
  dismissed: true;
  teamName: string;
  /** Only dismiss approvals from this specific run. */
  runId: string;
}

// ---------------------------------------------------------------------------
// Tool Approval Settings
// ---------------------------------------------------------------------------

/** Timeout behavior for unanswered tool approval requests. */
export type ToolApprovalTimeoutAction = 'allow' | 'deny' | 'wait';

/** User-configurable auto-allow settings for tool approval. */
export interface ToolApprovalSettings {
  /** Auto-allow file edit tools (Edit, Write, NotebookEdit). */
  autoAllowFileEdits: boolean;
  /** Auto-allow safe bash commands (git, pnpm, npm, ls, cat, echo, etc.). */
  autoAllowSafeBash: boolean;
  /** Timeout behavior when user doesn't respond. */
  timeoutAction: ToolApprovalTimeoutAction;
  /** Timeout seconds (used when timeoutAction !== 'wait'). */
  timeoutSeconds: number;
}

export const DEFAULT_TOOL_APPROVAL_SETTINGS: ToolApprovalSettings = {
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'wait',
  timeoutSeconds: 30,
};

/** Event pushed when a pending approval was auto-resolved (timeout or auto-allow). */
export interface ToolApprovalAutoResolved {
  autoResolved: true;
  requestId: string;
  runId: string;
  teamName: string;
  reason: 'auto_allow_category' | 'timeout_allow' | 'timeout_deny';
}

/** Union of approval events pushed from main to renderer. */
export type ToolApprovalEvent =
  | ToolApprovalRequest
  | ToolApprovalDismiss
  | ToolApprovalAutoResolved;
