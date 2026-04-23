import type { EnhancedChunk } from '@main/types';

export interface TeamMember {
  name: string;
  agentId?: string;
  agentType?: string;
  role?: string;
  /** Per-agent workflow/instructions injected into spawn prompt. */
  workflow?: string;
  /** Opt-in runtime isolation for persistent teammates. Omitted means shared workspace. */
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
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
  agentId?: string;
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
  /** True when team.meta.json exists but config.json doesn't — provisioning failed before TeamCreate. */
  pendingCreate?: boolean;
  /** True when the last launch partially succeeded (e.g. lead started, but not all teammates joined). */
  partialLaunchFailure?: boolean;
  /** Planned teammate count for the last persisted partial launch marker. */
  expectedMemberCount?: number;
  /** Confirmed teammate count from runtime artifacts/config for the last partial launch marker. */
  confirmedMemberCount?: number;
  /** Missing teammate names from the last partial launch marker. */
  missingMembers?: string[];
  /** Durable aggregate launch state derived from persisted launch-state evidence. */
  teamLaunchState?: TeamLaunchAggregateState;
  /** ISO timestamp of the last durable launch-state evaluation. */
  launchUpdatedAt?: string;
  /** Durable aggregate teammate counts from launch-state evidence. */
  confirmedCount?: number;
  pendingCount?: number;
  failedCount?: number;
  runtimeAlivePendingCount?: number;
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

export interface TaskReviewStartedEvent extends TaskHistoryEventBase {
  type: 'review_started';
  from: TeamReviewState;
  to: 'review';
}

export type TaskHistoryEvent =
  | TaskCreatedEvent
  | TaskStatusChangedEvent
  | TaskReviewRequestedEvent
  | TaskReviewChangesRequestedEvent
  | TaskReviewApprovedEvent
  | TaskReviewStartedEvent;

export type TaskCommentType = 'regular' | 'review_request' | 'review_approved';

export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export type BoardTaskRefKind = 'canonical' | 'display' | 'unknown';
export type BoardTaskResolution = 'resolved' | 'deleted' | 'unresolved' | 'ambiguous';
export type BoardTaskActivityLinkKind = 'execution' | 'lifecycle' | 'board_action';
export type BoardTaskActivityTargetRole = 'subject' | 'related';
export type BoardTaskActivityPhase = 'work' | 'review';
export type BoardTaskActorRelation = 'same_task' | 'other_active_task' | 'idle' | 'ambiguous';
export type BoardTaskActivityStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type BoardTaskActivityRelationship = 'blocked-by' | 'blocks' | 'related';
export type BoardTaskActivityCategory =
  | 'status'
  | 'review'
  | 'comment'
  | 'assignment'
  | 'read'
  | 'attachment'
  | 'relationship'
  | 'clarification'
  | 'other';
export type BoardTaskRelationshipPerspective = 'outgoing' | 'incoming' | 'symmetric';

export interface BoardTaskLocator {
  ref: string;
  refKind: BoardTaskRefKind;
  canonicalId?: string;
}

export interface BoardTaskActivityTaskRef {
  locator: BoardTaskLocator;
  resolution: BoardTaskResolution;
  taskRef?: TaskRef;
}

export interface BoardTaskActivityActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskActivityAction {
  canonicalToolName?: string;
  toolUseId?: string;
  category: BoardTaskActivityCategory;
  peerTask?: BoardTaskActivityTaskRef;
  relationshipPerspective?: BoardTaskRelationshipPerspective;
  details?: {
    status?: BoardTaskActivityStatus;
    owner?: string | null;
    clarification?: 'lead' | 'user' | null;
    reviewer?: string;
    relationship?: BoardTaskActivityRelationship;
    commentId?: string;
    attachmentId?: string;
    filename?: string;
  };
}

export interface BoardTaskActivityActorContext {
  relation: BoardTaskActorRelation;
  activeTask?: BoardTaskActivityTaskRef;
  activePhase?: BoardTaskActivityPhase;
  activeExecutionSeq?: number;
}

export interface BoardTaskActivityEntry {
  id: string;
  timestamp: string;
  task: BoardTaskActivityTaskRef;
  linkKind: BoardTaskActivityLinkKind;
  targetRole: BoardTaskActivityTargetRole;
  actor: BoardTaskActivityActor;
  actorContext: BoardTaskActivityActorContext;
  action?: BoardTaskActivityAction;
  source: {
    messageUuid: string;
    filePath: string;
    toolUseId?: string;
    sourceOrder: number;
  };
}

export interface BoardTaskActivityDetailMetadataRow {
  label: string;
  value: string;
}

export interface BoardTaskActivityDetail {
  entryId: string;
  summaryLabel: string;
  actorLabel: string;
  timestamp: string;
  contextLines: string[];
  metadataRows: BoardTaskActivityDetailMetadataRow[];
  logDetail?: BoardTaskExactLogDetail;
}

export type BoardTaskActivityDetailResult =
  | {
      status: 'ok';
      detail: BoardTaskActivityDetail;
    }
  | {
      status: 'missing';
    };

export interface BoardTaskExactLogActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskExactLogSource {
  filePath: string;
  messageUuid: string;
  toolUseId?: string;
  sourceOrder: number;
}

interface BoardTaskExactLogSummaryBase {
  id: string;
  timestamp: string;
  actor: BoardTaskExactLogActor;
  source: BoardTaskExactLogSource;
  anchorKind: 'tool' | 'message';
  actionLabel: string;
  actionCategory?: BoardTaskActivityCategory;
  canonicalToolName?: string;
  linkKinds: BoardTaskActivityLinkKind[];
}

export type BoardTaskExactLogSummary =
  | (BoardTaskExactLogSummaryBase & {
      canLoadDetail: true;
      sourceGeneration: string;
    })
  | (BoardTaskExactLogSummaryBase & {
      canLoadDetail: false;
    });

export interface BoardTaskExactLogDetail {
  id: string;
  chunks: EnhancedChunk[];
}

export interface BoardTaskExactLogSummariesResponse {
  items: BoardTaskExactLogSummary[];
}

export type BoardTaskExactLogDetailResult =
  | { status: 'ok'; detail: BoardTaskExactLogDetail }
  | { status: 'stale' }
  | { status: 'missing' };

export interface BoardTaskLogActor {
  memberName?: string;
  role: 'member' | 'lead' | 'unknown';
  sessionId: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface BoardTaskLogParticipant {
  key: string;
  label: string;
  role: 'member' | 'lead' | 'unknown';
  isLead: boolean;
  isSidechain: boolean;
}

export interface BoardTaskLogSegment {
  id: string;
  participantKey: string;
  actor: BoardTaskLogActor;
  startTimestamp: string;
  endTimestamp: string;
  chunks: EnhancedChunk[];
}

export interface BoardTaskLogStreamRuntimeProjection {
  provider: 'opencode';
  mode: 'attribution' | 'heuristic';
  attributionRecordCount: number;
  projectedMessageCount: number;
  fallbackReason?:
    | 'no_attribution_records'
    | 'attribution_no_projected_messages'
    | 'task_tool_markers';
  markerMatchCount?: number;
  markerSpanCount?: number;
}

export interface BoardTaskLogStreamResponse {
  participants: BoardTaskLogParticipant[];
  defaultFilter: 'all' | string;
  segments: BoardTaskLogSegment[];
  source?: 'transcript' | 'opencode_runtime_fallback' | 'opencode_runtime_attribution';
  runtimeProjection?: BoardTaskLogStreamRuntimeProjection;
}

export interface BoardTaskLogStreamSummary {
  segmentCount: number;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  type: TaskCommentType;
  taskRefs?: TaskRef[];
  /** Attachments on this comment. Metadata only — files stored on disk. */
  attachments?: TaskAttachmentMeta[];
}

/**
 * Snapshot of a user message captured at task-creation time.
 * Stored as provenance — the original message identity is `sourceMessageId`.
 */
export interface SourceMessageSnapshot {
  /** Sanitized message text (agent-only blocks stripped). */
  text: string;
  /** Who sent the message. */
  from: string;
  /** ISO timestamp of the original message. */
  timestamp: string;
  /** Message source type (e.g. "user_sent", "inbox"). */
  source?: string;
  /** Attachment metadata references (IDs only, no blobs). filePath present when file is stored on disk. */
  attachments?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    filePath?: string;
  }[];
}

export type InboxMessageKind =
  | 'default'
  | 'slash_command'
  | 'slash_command_result'
  | 'task_comment_notification';

export interface SlashCommandMeta {
  name: string;
  command: `/${string}`;
  args?: string;
  knownDescription?: string;
}

export interface CommandOutputMeta {
  stream: 'stdout' | 'stderr';
  commandLabel: string;
}

// Fields are validated in TeamTaskReader.getTasks() using `satisfies Record<keyof TeamTask, unknown>`.
// Adding a field here without mapping it there will cause a compile error.
export interface TeamTask {
  id: string;
  /** Human-friendly short task label shown in UI. Canonical identity remains `id`. */
  displayId?: string;
  subject: string;
  description?: string;
  descriptionTaskRefs?: TaskRef[];
  activeForm?: string;
  prompt?: string;
  promptTaskRefs?: TaskRef[];
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
   * e.g. "frontend task" ↔ "backend task" or a rare meta reminder ↔ the main work task.
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
  /** Exact messageId of the user message this task was created from. */
  sourceMessageId?: string;
  /** Snapshot of the source message at creation time (sanitized, no blobs). */
  sourceMessage?: SourceMessageSnapshot;
}

/** Task enriched for UI/DTO use (overlay from kanban-state.json). */
export type TaskChangePresenceState = 'has_changes' | 'needs_attention' | 'no_changes' | 'unknown';

export interface TeamTaskWithKanban extends TeamTask {
  /** Set when task is in team kanban (review or approved column). */
  kanbanColumn?: 'review' | 'approved';
  /** Reviewer assigned in kanban state, when applicable. */
  reviewer?: string | null;
  /** Cheap persisted change-presence state for kanban rendering. */
  changePresence?: TaskChangePresenceState;
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
  /** Absolute path to the file on disk. Null/absent for metadata-only references. */
  filePath?: string | null;
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
  /** Absolute path to the file on disk. Absent for metadata-only references. */
  filePath?: string;
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
  /** Optional runtime tool_use identifier when available. */
  toolUseId?: string;
}

export type ToolActivitySource = 'runtime' | 'member_log' | 'inbox';
export type ToolActivityState = 'running' | 'complete' | 'error';

/** Live or recently finished tool activity for one team member. */
export interface ActiveToolCall {
  memberName: string;
  toolUseId: string;
  toolName: string;
  preview?: string;
  startedAt: string;
  state: ToolActivityState;
  source: ToolActivitySource;
  finishedAt?: string;
  resultPreview?: string;
}

/** Renderer-facing event payload for tool lifecycle updates. */
export interface ToolActivityEventPayload {
  action: 'start' | 'finish' | 'reset';
  activity?: {
    memberName: string;
    toolUseId: string;
    toolName: string;
    preview?: string;
    startedAt: string;
    source: ToolActivitySource;
  };
  memberName?: string;
  toolUseId?: string;
  toolUseIds?: string[];
  finishedAt?: string;
  resultPreview?: string;
  isError?: boolean;
}

export interface InboxMessage {
  from: string;
  to?: string;
  text: string;
  timestamp: string;
  read: boolean;
  taskRefs?: TaskRef[];
  /** Authoritative task comment id attached by runtime-authored task notifications. */
  commentId?: string;
  summary?: string;
  color?: string;
  messageId?: string;
  /** Original inbox messageId when this row is only a relay/delivery bridge copy. */
  relayOfMessageId?: string;
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
  /** Renderer-friendly semantic kind. Defaults to "default" when absent. */
  messageKind?: InboxMessageKind;
  /** Structured slash-command metadata for sent command rows. */
  slashCommand?: SlashCommandMeta;
  /** Structured command-output metadata for session-derived result rows. */
  commandOutput?: CommandOutputMeta;
}

/** Cursor-based paginated messages response. */
export interface MessagesPage {
  messages: InboxMessage[];
  /** Opaque cursor string for fetching older messages. Null when no more pages. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Content-stable revision of the full normalized feed that produced this page.
   * Changes only when the semantic message feed changes.
   */
  feedRevision: string;
}

export type AgentActionMode = 'do' | 'ask' | 'delegate';

export interface SendMessageRequest {
  member: string;
  text: string;
  taskRefs?: TaskRef[];
  commentId?: string;
  actionMode?: AgentActionMode;
  summary?: string;
  from?: string;
  timestamp?: string;
  messageId?: string;
  relayOfMessageId?: string;
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
  messageKind?: InboxMessageKind;
  slashCommand?: SlashCommandMeta;
  commandOutput?: CommandOutputMeta;
}

export interface SendMessageResult {
  deliveredToInbox: boolean;
  deliveredViaStdin?: boolean;
  messageId: string;
  deduplicated?: boolean;
}

export interface AddTaskCommentRequest {
  text: string;
  attachments?: CommentAttachmentPayload[];
  taskRefs?: TaskRef[];
}

export type MemberStatus = 'active' | 'idle' | 'terminated' | 'unknown';

export type MemberSpawnStatus = 'offline' | 'waiting' | 'spawning' | 'online' | 'error';
export type MemberLaunchState =
  | 'starting'
  | 'runtime_pending_bootstrap'
  | 'runtime_pending_permission'
  | 'confirmed_alive'
  | 'failed_to_start';
export type TeamLaunchAggregateState = 'clean_success' | 'partial_pending' | 'partial_failure';
export type PersistedTeamLaunchPhase = 'active' | 'finished' | 'reconciled';

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
  | { op: 'request_changes'; comment?: string; taskRefs?: TaskRef[] };

export interface ResolvedTeamMember {
  name: string;
  agentId?: string;
  status: MemberStatus;
  currentTaskId: string | null;
  taskCount: number;
  lastActiveAt: string | null;
  messageCount: number;
  color?: string;
  agentType?: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  cwd?: string;
  /** Set only when member's git branch differs from the lead's branch. */
  gitBranch?: string;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  removedAt?: number;
}

export interface MemberRuntimeAdvisory {
  kind: 'sdk_retrying';
  observedAt: string;
  retryUntil: string;
  retryDelayMs: number;
  reasonCode?:
    | 'quota_exhausted'
    | 'rate_limited'
    | 'auth_error'
    | 'network_error'
    | 'provider_overloaded'
    | 'backend_error'
    | 'unknown';
  message?: string;
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

export interface TeamMemberSnapshot {
  name: string;
  agentId?: string;
  currentTaskId: string | null;
  taskCount: number;
  color?: string;
  agentType?: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  laneOwnerProviderId?: TeamProviderId;
  cwd?: string;
  /** Set only when member's git branch differs from the lead's branch. */
  gitBranch?: string;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  removedAt?: number;
}

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

export interface TeamViewSnapshot {
  teamName: string;
  config: TeamConfig;
  tasks: TeamTaskWithKanban[];
  members: TeamMemberSnapshot[];
  kanbanState: KanbanState;
  processes: TeamProcess[];
  warnings?: string[];
  isAlive?: boolean;
}

export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TeamProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';
export type TeamProviderBackendId = 'auto' | 'adapter' | 'api' | 'cli-sdk' | 'codex-native';
export type TeamFastMode = 'inherit' | 'on' | 'off';

export interface ProviderModelLaunchIdentity {
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  selectedModel: string | null;
  selectedModelKind: 'default' | 'explicit';
  resolvedLaunchModel: string | null;
  catalogId: string | null;
  catalogSource:
    | 'anthropic-models-api'
    | 'app-server'
    | 'static-fallback'
    | 'runtime'
    | 'unavailable';
  catalogFetchedAt: string | null;
  selectedEffort: EffortLevel | null;
  resolvedEffort: EffortLevel | null;
  selectedFastMode?: TeamFastMode | null;
  resolvedFastMode?: boolean | null;
  fastResolutionReason?: string | null;
}

export interface TeamLaunchRequest {
  teamName: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  /** When true, context window is limited to 200K tokens instead of the default. */
  limitContext?: boolean;
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
  descriptionTaskRefs?: TaskRef[];
  owner?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  startImmediately?: boolean;
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

export interface PersistedTeamLaunchMemberSources {
  inboxHeartbeat?: boolean;
  nativeHeartbeat?: boolean;
  processAlive?: boolean;
  configRegistered?: boolean;
  configDrift?: boolean;
  hardFailureSignal?: boolean;
  duplicateRespawnBlocked?: boolean;
}

export interface PersistedTeamLaunchMemberState {
  name: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  selectedFastMode?: TeamFastMode;
  resolvedFastMode?: boolean;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  laneOwnerProviderId?: TeamProviderId;
  launchIdentity?: ProviderModelLaunchIdentity;
  launchState: MemberLaunchState;
  agentToolAccepted: boolean;
  runtimeAlive: boolean;
  bootstrapConfirmed: boolean;
  hardFailure: boolean;
  hardFailureReason?: string;
  pendingPermissionRequestIds?: string[];
  runtimePid?: number;
  firstSpawnAcceptedAt?: string;
  lastHeartbeatAt?: string;
  lastRuntimeAliveAt?: string;
  lastEvaluatedAt: string;
  sources?: PersistedTeamLaunchMemberSources;
  diagnostics?: string[];
}

export interface PersistedTeamLaunchSummary {
  confirmedCount: number;
  pendingCount: number;
  failedCount: number;
  runtimeAlivePendingCount: number;
}

export interface PersistedTeamLaunchSnapshot {
  version: 2;
  teamName: string;
  updatedAt: string;
  leadSessionId?: string;
  launchPhase: PersistedTeamLaunchPhase;
  expectedMembers: string[];
  bootstrapExpectedMembers?: string[];
  members: Record<string, PersistedTeamLaunchMemberState>;
  summary: PersistedTeamLaunchSummary;
  teamLaunchState: TeamLaunchAggregateState;
}

export interface MemberSpawnStatusesSnapshot {
  statuses: Record<string, MemberSpawnStatusEntry>;
  runId: string | null;
  teamLaunchState?: TeamLaunchAggregateState;
  launchPhase?: PersistedTeamLaunchPhase;
  expectedMembers?: string[];
  updatedAt?: string;
  summary?: PersistedTeamLaunchSummary;
  source?: 'live' | 'persisted' | 'merged';
}

export type MemberSpawnLivenessSource = 'heartbeat' | 'process';

export type TeamAgentRuntimeBackendType = 'lead' | 'tmux' | 'iterm2' | 'in-process' | 'process';

export interface TeamAgentRuntimeEntry {
  memberName: string;
  alive: boolean;
  restartable: boolean;
  backendType?: TeamAgentRuntimeBackendType;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  pid?: number;
  runtimeModel?: string;
  rssBytes?: number;
  updatedAt: string;
}

export interface TeamAgentRuntimeSnapshot {
  teamName: string;
  updatedAt: string;
  runId: string | null;
  providerBackendId?: TeamProviderBackendId;
  fastMode?: TeamFastMode;
  members: Record<string, TeamAgentRuntimeEntry>;
}

export interface TeamChangeEvent {
  type:
    | 'config'
    | 'inbox'
    | 'log-source-change'
    | 'task-log-change'
    | 'task'
    | 'lead-activity'
    | 'lead-context'
    | 'lead-message'
    | 'tool-activity'
    | 'process'
    | 'member-spawn';
  teamName: string;
  runId?: string;
  detail?: string;
  taskId?: string;
}

export interface ProjectBranchChangeEvent {
  projectPath: string;
  branch: string | null;
}

/** Per-member spawn status entry, exposed to renderer via IPC. */
export interface MemberSpawnStatusEntry {
  status: MemberSpawnStatus;
  launchState: MemberLaunchState;
  /** Error message when status === 'error'. */
  error?: string;
  /** Hard failure reason for failed_to_start. */
  hardFailureReason?: string;
  /**
   * Optional provenance for `online`.
   * - heartbeat: teammate sent a real inbox/native message after bootstrap
   * - process: runtime process is alive, but bootstrap/first reply is not yet confirmed
   */
  livenessSource?: MemberSpawnLivenessSource;
  /** Agent tool_result confirmed the spawn request was accepted by the runtime. */
  agentToolAccepted?: boolean;
  /** Runtime process or registered teammate runtime is currently alive. */
  runtimeAlive?: boolean;
  /** A real teammate heartbeat/bootstrap confirmation was observed. */
  bootstrapConfirmed?: boolean;
  /** Hard failure observed from spawn/bootstrap/runtime evidence. */
  hardFailure?: boolean;
  /** Pending runtime permission request ids currently blocking bootstrap. */
  pendingPermissionRequestIds?: string[];
  /** ISO timestamp of the first accepted teammate spawn for this member. */
  firstSpawnAcceptedAt?: string;
  /** ISO timestamp of the latest confirmed heartbeat/bootstrap message. */
  lastHeartbeatAt?: string;
  /** Live runtime model observed from the teammate process, when available. */
  runtimeModel?: string;
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
  | 'configuring'
  | 'assembling'
  | 'finalizing'
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
  /** Opt-in: run this teammate in its own git worktree. */
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
}

export interface TeamCreateRequest {
  teamName: string;
  displayName?: string;
  description?: string;
  color?: string;
  members: TeamProvisioningMemberInput[];
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  /** When true, context window is limited to 200K tokens instead of the default. */
  limitContext?: boolean;
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
  providerBackendId?: TeamProviderBackendId;
  fastMode?: TeamFastMode;
}

export interface TeamCreateResponse {
  runId: string;
}

export type TeamProvisioningModelVerificationMode = 'compatibility' | 'deep';

export interface TeamProvisioningPrepareResult {
  ready: boolean;
  message: string;
  details?: string[];
  warnings?: string[];
}

export interface TeamProvisioningProgress {
  runId: string;
  teamName: string;
  state: Exclude<TeamProvisioningState, 'idle'>;
  message: string;
  /** Visual severity for the message subtitle: 'error' (red), 'warning' (amber), or default (muted). */
  messageSeverity?: 'error' | 'warning';
  startedAt: string;
  updatedAt: string;
  pid?: number;
  error?: string;
  warnings?: string[];
  /** Provisioning CLI logs shown in the launch progress UI. */
  cliLogsTail?: string;
  /** Accumulated assistant text output during provisioning (for live preview). */
  assistantOutput?: string;
  /** True once provisioning has written a readable config.json for this team. */
  configReady?: boolean;
}

export interface TeamRuntimeState {
  teamName: string;
  isAlive: boolean;
  runId: string | null;
  progress: TeamProvisioningProgress | null;
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

export type MemberLogSummary =
  | MemberSubagentLogSummary
  | MemberLeadSessionLogSummary
  | MemberSessionLogSummary;

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
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
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
  teamEventType?:
    | 'task_clarification'
    | 'task_status_change'
    | 'task_comment'
    | 'task_created'
    | 'all_tasks_completed';
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
  taskRefs?: TaskRef[];
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
  taskRefs?: TaskRef[];
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
  /** Team color name (from config or create request) for badge rendering. */
  teamColor?: string;
  /** Team display name (from config or create request). */
  teamDisplayName?: string;
  /** Permission suggestions from teammate runtime (only for teammate permission_request).
   * FACT: Populated by Claude Code runtime, contains instructions to add permission rules.
   */
  permissionSuggestions?: {
    type: string;
    rules?: { toolName: string }[];
    behavior?: string;
    destination?: string;
  }[];
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
  /** Auto-allow ALL tools (overrides individual settings below). */
  autoAllowAll: boolean;
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
  autoAllowAll: false,
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

/** Result of reading a file for tool approval diff preview. */
export interface ToolApprovalFileContent {
  content: string;
  exists: boolean;
  truncated: boolean;
  isBinary: boolean;
  error?: string;
}
