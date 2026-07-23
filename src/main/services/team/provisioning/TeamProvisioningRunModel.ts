import type { AnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import type { PendingInboxRelayCandidate } from './TeamProvisioningInboxRelayCandidates';
import type { LeadActivityState } from './TeamProvisioningLeadActivity';
import type { MemberSpawnInboxCursor } from './TeamProvisioningMemberSpawnCursor';
import type { TeamsBaseLocation } from './TeamProvisioningRuntimeLaunchSelection';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  WorkspaceTrustDiagnosticsManifest,
  WorkspaceTrustExecutionResult,
  WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import type {
  ActiveToolCall,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamProvisioningProgress,
  ToolApprovalRequest,
  ToolCallMeta,
} from '@shared/types';
import type { spawn } from 'child_process';

export const VERIFY_TIMEOUT_MS = 15_000;

export const VERIFY_POLL_MS = 500;
export const LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT = 100;
export const LEAD_TEXT_EMIT_THROTTLE_MS = 2000;
// Progress emissions fan out the latest CLI tail + assistant output to the
// renderer over IPC. Under load the previous 300ms cadence combined with an
// unbounded payload (see `emitLogsProgress`) caused renderer OOM crashes
// (about 3 full-history serializations per second, each holding thousands of
// lines). The tail cap in `emitLogsProgress` bounds each payload; we also
// slow the cadence to ~1s so Zustand can keep up on large teams.
export const APP_TEAM_RUNTIME_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop';
export const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
export const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
export const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;
export const MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS = 1_500;
export const DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS = 12_000;

export interface PendingMemberRestartContext {
  requestedAt: string;
  desired: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'isolation' | 'providerId' | 'model' | 'effort'
  >;
}

export interface ProvisioningRun {
  runId: string;
  teamName: string;
  startedAt: string;
  progress: TeamProvisioningProgress;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** Rolling buffer of CLI log lines (oldest -> newest). */
  claudeLogLines: string[];
  /** Last stream used for claudeLogLines markers. */
  lastClaudeLogStream: 'stdout' | 'stderr' | null;
  /** Carry buffer for stdout line splitting (CLI output). */
  stdoutLogLineBuf: string;
  /** Carry buffer for stderr line splitting (CLI output). */
  stderrLogLineBuf: string;
  /** Raw stdout parser carry that has not been newline-delimited yet. */
  stdoutParserCarry: string;
  /** Whether the current stdout parser carry is a complete JSON fragment. */
  stdoutParserCarryIsCompleteJson: boolean;
  /** Whether the current stdout parser carry looks like Claude stream-json structure. */
  stdoutParserCarryLooksLikeClaudeJson: boolean;
  /** ISO timestamp when the last CLI line was recorded. */
  claudeLogsUpdatedAt?: string;
  /** ISO timestamp when the first accepted deterministic bootstrap event arrived. */
  deterministicBootstrapStartedAt?: string;
  /** Latest accepted deterministic bootstrap event name. */
  lastDeterministicBootstrapEvent?: string;
  /** Latest accepted deterministic bootstrap phase name. */
  lastDeterministicBootstrapPhase?: string;
  /** True after deterministic bootstrap reports that teammate spawning started. */
  deterministicBootstrapMemberSpawnSeen: boolean;
  /** True after deterministic bootstrap reports at least one teammate spawn result. */
  deterministicBootstrapMemberResultSeen: boolean;
  processKilled: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  child: ReturnType<typeof spawn> | null;
  timeoutHandle: NodeJS.Timeout | null;
  fsMonitorHandle: NodeJS.Timeout | null;
  onProgress: (progress: TeamProvisioningProgress) => void;
  expectedMembers: string[];
  request: TeamCreateRequest;
  allEffectiveMembers: TeamCreateRequest['members'];
  effectiveMembers: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  mixedSecondaryLanes: MixedSecondaryRuntimeLaneState[];
  /**
   * OpenCode secondary lanes share bridge state files. Launch them sequentially
   * per team run to avoid file-lock contention while keeping launch non-blocking.
   */
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
  /** Shared OpenCode host preflight failures, scoped to the resolved project cwd for this run. */
  mixedSecondarySharedRuntimeFailuresByProject?: Map<string, string>;
  lastLogProgressAt: number;
  /** Monotonic ms timestamp of last stdout/stderr data. For stall detection. */
  lastDataReceivedAt: number;
  /** Monotonic ms timestamp of last stdout data only. Stall watchdog uses this
   *  instead of lastDataReceivedAt because stderr emits periodic debug logs
   *  that reset the timer without producing any user-visible output. */
  lastStdoutReceivedAt: number;
  /** Stall watchdog interval handle. Cleared in cleanupRun(). */
  stallCheckHandle: NodeJS.Timeout | null;
  /** Index of the current stall warning in provisioningOutputParts.
   *  Used to replace in-place instead of pushing duplicates. */
  stallWarningIndex: number | null;
  /** The progress.message before the stall watchdog overwrote it.
   *  Restored when stdout resumes and the stall warning is cleared. */
  preStallMessage: string | null;
  /** Monotonic ms timestamp of last api_retry message. When set, the stall
   *  watchdog defers to retry messages for progress.message (retries are
   *  more informative than the generic "CLI not responding" stall text). */
  lastRetryAt: number;
  /** Index of the latest api_retry warning block in provisioningOutputParts. */
  apiRetryWarningIndex: number | null;
  /** True after emitApiErrorWarning() fires once - prevents duplicate warnings and pre-complete false positives. */
  apiErrorWarningEmitted: boolean;
  fsPhase: 'waiting_config' | 'waiting_members' | 'waiting_tasks' | 'all_files_found';
  waitingTasksSince: number | null;
  provisioningComplete: boolean;
  processClosed: boolean;
  requiresFirstRealTurnSuccess: boolean;
  firstRealTurnSucceeded: boolean;
  /** Path to the generated MCP config file for later cleanup. */
  mcpConfigPath: string | null;
  /** Paths to per-member generated MCP config files consumed by deterministic bootstrap. */
  memberMcpConfigPaths: string[];
  /** Path to the deterministic bootstrap spec file for later cleanup. */
  bootstrapSpecPath: string | null;
  /** Path to the deferred first-user-task file consumed by runtime after bootstrap. */
  bootstrapUserPromptPath: string | null;
  isLaunch: boolean;
  launchStateClearedForRun: boolean;
  deterministicBootstrap: boolean;
  launchCleanupStateFinalized?: boolean;
  workspaceTrustPlan?: WorkspaceTrustFullPlanResult | null;
  workspaceTrustExecution?: WorkspaceTrustExecutionResult | null;
  workspaceTrustDiagnostics?: WorkspaceTrustDiagnosticsManifest | null;
  workspaceTrustRetryAttempted?: boolean;
  leadRelayCapture: {
    leadName: string;
    startedAt: string;
    textParts: string[];
    textJoinMode?: 'block' | 'stream';
    replyVisibility?: 'user' | 'internal_activity';
    hasVisibleSendMessage?: boolean;
    hasUserVisibleSendMessage?: boolean;
    settled: boolean;
    idleHandle: NodeJS.Timeout | null;
    idleMs: number;
    resolveOnce: (text: string) => void;
    rejectOnce: (error: string) => void;
    timeoutHandle: NodeJS.Timeout;
  } | null;
  activeCrossTeamReplyHints: {
    toTeam: string;
    conversationId: string;
  }[];
  /** Monotonic counter for individual lead assistant messages. */
  leadMsgSeq: number;
  /** Active text bubble for token-streamed lead assistant output. */
  liveLeadTextBuffer: {
    messageId: string;
    text: string;
    timestamp: string;
    toolCalls?: ToolCallMeta[];
    toolSummary?: string;
  } | null;
  /** Accumulated tool_use details between text messages. */
  pendingToolCalls: ToolCallMeta[];
  /** Active runtime tool calls keyed by tool_use_id. */
  activeToolCalls: Map<string, ActiveToolCall>;
  /** True when a direct MCP cross_team_send happened and sentMessages history should refresh. */
  pendingDirectCrossTeamSendRefresh: boolean;
  /** Throttle timestamp for emitting inbox refresh events for lead text. */
  lastLeadTextEmitMs: number;
  /**
   * When set, the current stdin-injected turn is an internal "forward user DM to teammate"
   * request triggered by the UI. We suppress any lead->user echo for that turn.
   */
  silentUserDmForward: {
    target: string;
    startedAt: string;
    mode: 'user_dm' | 'member_inbox_relay';
  } | null;
  /** Safety valve: clears silentUserDmForward if turn never completes. */
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
  /** Exact inbox rows currently being bridged into the live teammate process. */
  pendingInboxRelayCandidates: PendingInboxRelayCandidate[];
  /** Accumulates assistant text during provisioning phase for live UI preview. */
  provisioningOutputParts: string[];
  /** Bounded orchestration checkpoints shown in the Live output panel. */
  provisioningTraceLines: string[];
  /** Last emitted trace key, used to avoid duplicate progress spam. */
  lastProvisioningTraceKey: string | null;
  /** Stable assistant message ids -> provisioningOutputParts index for in-place updates. */
  provisioningOutputIndexByMessageId: Map<string, number>;
  /** Session ID detected from stream-json output (result.session_id or message.session_id). */
  detectedSessionId: string | null;
  /** Lead process activity: 'active' during turn processing, 'idle' waiting for input, 'offline' after exit. */
  leadActivityState: LeadActivityState;
  /** Whether an auth failure retry was already attempted for this run. */
  authFailureRetried: boolean;
  /** Set to true while auth-failure respawn is in progress to prevent duplicate handling. */
  authRetryInProgress: boolean;
  /** Tracks lead process context window usage from stream-json usage data. */
  leadContextUsage: {
    promptInputTokens: number | null;
    outputTokens: number | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    promptInputSource: LeadContextUsage['promptInputSource'];
    lastUsageMessageId: string | null;
    lastEmittedAt: number;
  } | null;
  /** Saved spawn context for auth-failure respawn. */
  spawnContext: {
    claudePath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
  } | null;
  /** Run-scoped helper material used by Anthropic API-key team runtimes. */
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
  /** In-flight exact-owner cleanup, used to make cancellation and spawn rollback idempotent. */
  anthropicApiKeyHelperCleanupPromise: Promise<void> | null;
  /** Pending tool approval requests awaiting user response (control_request protocol). */
  pendingApprovals: Map<string, ToolApprovalRequest>;
  /** Teammate permission_request IDs already intercepted (prevents re-processing read messages). */
  processedPermissionRequestIds: Set<string>;
  /**
   * Post-compact context reinjection lifecycle.
   * - pendingPostCompactReminder: compact_boundary was received; waiting for idle to inject.
   * - postCompactReminderInFlight: the reminder turn has been injected via stdin, waiting for result.
   * - suppressPostCompactReminderOutput: true while processing a reminder turn - suppress
   *   low-value context-refresh acknowledgement text.
   */
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  suppressPostCompactReminderOutput: boolean;
  /** Gemini-only phase-2 launch hydration after the first successful provisioning turn. */
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  geminiPostLaunchHydrationSent: boolean;
  suppressGeminiPostLaunchHydrationOutput: boolean;
  /** Per-member spawn lifecycle statuses tracked from stream-json output. */
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  /** Agent tool_use_id -> teammate name for persistent teammate spawns. */
  memberSpawnToolUseIds: Map<string, string>;
  /** Explicit restart requests awaiting teammate rejoin or failure. */
  pendingMemberRestarts: Map<string, PendingMemberRestartContext>;
  /** Per-member latest processed lead-inbox bootstrap signal cursor for the current live run. */
  memberSpawnLeadInboxCursorByMember: Map<string, MemberSpawnInboxCursor>;
  /** Highest accepted deterministic bootstrap event sequence for this run. */
  lastDeterministicBootstrapSeq: number;
  /** Throttles config/inbox audit work triggered by frequent status polling. */
  lastMemberSpawnAuditAt: number;
  /** Throttles repeated audit warnings when config.json is temporarily unreadable. */
  lastMemberSpawnAuditConfigReadWarningAt: number;
  /** Per-member warning throttle for repeated "missing from config" logs. */
  lastMemberSpawnAuditMissingWarningAt: Map<string, number>;
  /** Prevents duplicate Team Launched notifications for the same live run. */
  teamLaunchedNotificationFired?: boolean;
}
