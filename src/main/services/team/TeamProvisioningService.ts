import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { getAppIconPath } from '@main/utils/appIcon';
import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';
import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import {
  encodePath,
  extractBaseDir,
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { shouldAutoAllow } from '@main/utils/toolApprovalRules';
import {
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_OPEN,
  stripAgentBlocks,
  wrapAgentBlock,
} from '@shared/constants/agentBlocks';
import {
  CROSS_TEAM_PREFIX_TAG,
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import {
  isInboxNoiseMessage,
  isMeaningfulBootstrapCheckInMessage,
  type ParsedPermissionRequest,
  parsePermissionRequest,
} from '@shared/utils/inboxNoise';
import { isLeadAgentType, isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  parseAllTeammateMessages,
  type ParsedTeammateContent,
} from '@shared/utils/teammateMessageParser';
import { createCliAutoSuffixNameGuard, parseNumericSuffixName } from '@shared/utils/teamMemberName';
import { isDefaultProviderModelSelection } from '@shared/utils/providerModelSelection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import {
  extractToolPreview,
  extractToolResultPreview,
  formatToolSummaryFromCalls,
  parseAgentToolResultStatus,
} from '@shared/utils/toolSummary';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type ChildProcess, execFileSync, type spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  type GeminiRuntimeAuthState,
  resolveGeminiRuntimeAuth,
} from '../runtime/geminiRuntimeAuth';
import {
  buildProviderPreflightPingArgs,
  buildProviderModelProbeArgs,
  classifyProviderModelProbeFailure,
  getProviderModelProbeExpectedOutput,
  getProviderModelProbeTimeoutMs,
  isProviderModelProbeSuccessOutput,
  normalizeProviderModelProbeFailureReason,
} from '../runtime/providerModelProbe';
import { buildProviderAwareCliEnv } from '../runtime/providerAwareCliEnv';
import { resolveTeamProviderId } from '../runtime/providerRuntimeEnv';

import { buildActionModeProtocol } from './actionModeInstructions';
import { atomicWriteAsync } from './atomicWrite';
import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import { withFileLock } from './fileLock';
import {
  type ClassifiedMainProcessIdle,
  classifyIdleNotificationForMainProcess,
} from './idleNotificationMainProcessSemantics';
import { withInboxLock } from './inboxLock';
import { getEffectiveInboxMessageId } from './inboxMessageIdentity';
import { resolveDesktopTeammateModeDecision } from './runtimeTeammateMode';
import {
  choosePreferredLaunchSnapshot,
  clearBootstrapState,
  readBootstrapLaunchSnapshot,
  readBootstrapRealTaskSubmissionState,
  readBootstrapRuntimeState,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import {
  createPersistedLaunchSnapshot,
  snapshotFromRuntimeMemberStatuses,
  snapshotToMemberSpawnStatuses,
} from './TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMcpConfigBuilder } from './TeamMcpConfigBuilder';
import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { TeamTaskReader } from './TeamTaskReader';

/**
 * Kill a team CLI process using SIGKILL (uncatchable).
 *
 * Newer Claude CLI versions (≥2.1.x) handle SIGTERM gracefully and run cleanup
 * that deletes team files (config.json, inboxes/, tasks/). SIGKILL prevents this.
 *
 * ALWAYS use this instead of killProcessTree() for team processes.
 * stdin.end() is also forbidden — EOF triggers the same cleanup.
 */
function killTeamProcess(child: ChildProcess | null | undefined): void {
  killProcessTree(child, 'SIGKILL');
}

function buildRelayInboxView(messages: RelayInboxMessage[]): RelayInboxMessageView[] {
  return messages.map((message) => {
    const isCrossTeamLike =
      message.source === CROSS_TEAM_SOURCE || message.source === CROSS_TEAM_SENT_SOURCE;
    return {
      message,
      idle: isCrossTeamLike ? null : classifyIdleNotificationForMainProcess(message.text),
      isCoarseNoise: isCrossTeamLike ? false : isInboxNoiseMessage(message.text),
    };
  });
}

interface PersistedRuntimeMemberLike {
  name?: string;
  agentId?: string;
  tmuxPaneId?: string;
  backendType?: string;
}

type RelayInboxMessage = InboxMessage & { messageId: string };

interface RelayInboxMessageView {
  message: RelayInboxMessage;
  idle: ClassifiedMainProcessIdle | null;
  isCoarseNoise: boolean;
}

import type {
  ActiveToolCall,
  CrossTeamSendResult,
  EffortLevel,
  InboxMessage,
  LeadContextUsage,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSummary,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchAggregateState,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamProvisioningState,
  TeamRuntimeState,
  TeamTask,
  ToolActivityEventPayload,
  ToolApprovalAutoResolved,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
  ToolCallMeta,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES, createController, protocols } =
  agentTeamsControllerModule;
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RUN_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LOG_PROGRESS_THROTTLE_MS = 300;
const UI_LOGS_TAIL_LIMIT = 128 * 1024;
const PROBE_CACHE_TTL_MS = 36 * 60 * 60 * 1000;
const PREFLIGHT_BINARY_TIMEOUT_MS = 8000;
const PREFLIGHT_AUTH_RETRY_DELAY_MS = 2000;
const PREFLIGHT_AUTH_MAX_RETRIES = 2;
const FS_MONITOR_POLL_MS = 2000;
const TASK_WAIT_FALLBACK_MS = 15_000;
const STALL_CHECK_INTERVAL_MS = 10_000;
const STALL_WARNING_THRESHOLD_MS = 20_000;
const APP_TEAM_RUNTIME_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop';
const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;
const MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS = 1_500;
const MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS = 10_000;
const CROSS_TEAM_TOOL_RECIPIENT_NAMES = new Set([
  'cross_team_send',
  'cross_team_list_targets',
  'cross_team_get_outbox',
]);
const HANDLED_STREAM_JSON_TYPES = new Set([
  'user',
  'assistant',
  'control_request',
  'result',
  'system',
]);
function assertAppDeterministicBootstrapEnabled(): void {
  if (process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the app rollout flag (CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
  if (process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the runtime kill switch (CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
}

function classifyDeterministicBootstrapFailure(reason: string): {
  title: string;
  normalizedReason: string;
} {
  const normalizedReason = reason.trim();
  const lower = normalizedReason.toLowerCase();
  if (lower.includes('disabled by kill switch')) {
    return {
      title: 'Deterministic bootstrap disabled',
      normalizedReason,
    };
  }
  if (
    lower.includes('requires claude_enable_deterministic_team_bootstrap=1') ||
    lower.includes('unsupported schema version') ||
    lower.includes('regular file and must not be a symlink')
  ) {
    return {
      title: 'Deterministic bootstrap compatibility failure',
      normalizedReason,
    };
  }
  return {
    title: 'Deterministic bootstrap failed',
    normalizedReason,
  };
}

function getPreflightPingArgs(providerId: TeamProviderId | undefined): string[] {
  return buildProviderPreflightPingArgs(providerId);
}

function getPreflightTimeoutMs(providerId: TeamProviderId | undefined): number {
  return getProviderModelProbeTimeoutMs(providerId);
}

interface ProviderModelListCommandResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      defaultModel?: string | null;
      models?: (string | { id?: string; label?: string; description?: string })[];
    }
  >;
}

function extractJsonObjectFromCli<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error('No JSON object found in CLI output');
  }
}

function isProbeTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('timed out') ||
    lower.includes('did not complete') ||
    lower.includes('etimedout')
  );
}

function isTransientModelProbeMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('429') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504')
  );
}

function getTeamProviderLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
    default:
      return 'Anthropic';
  }
}

interface CanonicalSendMessageExample {
  to: string;
  summary: string;
  message: string;
}

// TODO(refactor): If more prompt-bound tool contracts appear here, move these
// canonical examples/rules into a small dedicated module (for example
// `teamPromptContracts.ts`) and cover them with schema-backed tests. Keep this
// layer narrow and explicit; do not grow it into a generic schema-to-prompt
// generator.
const SEND_MESSAGE_CANONICAL_FIELDS = ['to', 'summary', 'message'] as const;
const SEND_MESSAGE_FORBIDDEN_ALIAS_FIELDS = ['recipient', 'content'] as const;

function buildCanonicalSendMessageExample(example: CanonicalSendMessageExample): string {
  return `{ ${SEND_MESSAGE_CANONICAL_FIELDS.map((field) => `${field}: "${example[field]}"`).join(', ')} }`;
}

function getCanonicalSendMessageFieldRule(): string {
  return `CRITICAL: The SendMessage tool input must use the actual tool field names \`${SEND_MESSAGE_CANONICAL_FIELDS.join('`, `')}\`. Never invent alternate keys like \`${SEND_MESSAGE_FORBIDDEN_ALIAS_FIELDS.join('` or `')}\`.`;
}

function getCanonicalSendMessageToolRule(to: string): string {
  return `Use the SendMessage tool with to="${to}".`;
}

function getConfiguredRuntimeBackend(providerId: TeamProviderId): string | null {
  const runtimeConfig = ConfigManager.getInstance().getConfig().runtime.providerBackends;
  switch (providerId) {
    case 'gemini':
      return runtimeConfig.gemini;
    case 'codex':
      return runtimeConfig.codex;
    case 'anthropic':
    default:
      return null;
  }
}

function mergeProvisioningWarnings(
  existing: string[] | undefined,
  nextWarning: string | null
): string[] | undefined {
  if (!nextWarning) return existing;
  const merged = (existing ?? []).filter((warning) => warning !== nextWarning);
  merged.push(nextWarning);
  return merged.length > 0 ? merged : undefined;
}

function buildRuntimeLaunchWarning(
  request: Pick<TeamCreateRequest, 'providerId' | 'model' | 'effort'>,
  env: NodeJS.ProcessEnv,
  options?: {
    geminiRuntimeAuth?: GeminiRuntimeAuthState | null;
    promptSize?: PromptSizeSummary | null;
    expectedMembersCount?: number;
  }
): string {
  const providerId = resolveTeamProviderId(request.providerId);
  const providerLabel = getTeamProviderLabel(providerId);
  const modelLabel = request.model?.trim() || 'default';
  const effortLabel = request.effort ?? 'default';
  const backend = getConfiguredRuntimeBackend(providerId);
  const flags: string[] = [];
  if (env.CLAUDE_CODE_USE_GEMINI === '1') flags.push('USE_GEMINI');
  if (env.CLAUDE_CODE_USE_OPENAI === '1') flags.push('USE_OPENAI');
  if (env.CLAUDE_CODE_ENTRY_PROVIDER) {
    flags.push(`ENTRY_PROVIDER=${env.CLAUDE_CODE_ENTRY_PROVIDER}`);
  }
  if (env.CLAUDE_CODE_GEMINI_BACKEND) {
    flags.push(`GEMINI_BACKEND=${env.CLAUDE_CODE_GEMINI_BACKEND}`);
  }
  if (env.CLAUDE_CODE_CODEX_BACKEND) {
    flags.push(`CODEX_BACKEND=${env.CLAUDE_CODE_CODEX_BACKEND}`);
  }
  const backendPart = backend ? `, backend ${backend}` : '';
  const flagsPart = flags.length > 0 ? `, env ${flags.join(', ')}` : '';
  const geminiAuth = options?.geminiRuntimeAuth;
  const authPart =
    providerId === 'gemini' && geminiAuth
      ? `, auth ${geminiAuth.authMethod ?? 'none'}/${geminiAuth.resolvedBackend}`
      : '';
  const promptSize = options?.promptSize;
  const promptPart = promptSize
    ? `, prompt ${promptSize.chars.toLocaleString('en-US')} chars/${promptSize.lines} lines`
    : '';
  const membersPart =
    typeof options?.expectedMembersCount === 'number'
      ? `, members ${options.expectedMembersCount}`
      : '';
  return `Launch runtime: ${providerLabel} · ${modelLabel} · ${effortLabel}${backendPart}${authPart}${promptPart}${membersPart}${flagsPart}`;
}

function logRuntimeLaunchSnapshot(
  teamName: string,
  claudePath: string,
  args: string[],
  request: Pick<TeamCreateRequest, 'providerId' | 'model' | 'effort'>,
  env: NodeJS.ProcessEnv,
  options?: {
    geminiRuntimeAuth?: GeminiRuntimeAuthState | null;
    promptSize?: PromptSizeSummary | null;
    expectedMembersCount?: number;
  }
): void {
  const providerId = resolveTeamProviderId(request.providerId);
  const snapshot = {
    providerId,
    model: request.model ?? null,
    effort: request.effort ?? null,
    configuredBackend: getConfiguredRuntimeBackend(providerId),
    promptSize: options?.promptSize ?? null,
    expectedMembersCount: options?.expectedMembersCount ?? null,
    geminiRuntimeAuth:
      providerId === 'gemini'
        ? {
            authenticated: options?.geminiRuntimeAuth?.authenticated ?? null,
            authMethod: options?.geminiRuntimeAuth?.authMethod ?? null,
            resolvedBackend: options?.geminiRuntimeAuth?.resolvedBackend ?? null,
            projectId: options?.geminiRuntimeAuth?.projectId ?? null,
            statusMessage: options?.geminiRuntimeAuth?.statusMessage ?? null,
          }
        : null,
    env: {
      CLAUDE_CODE_USE_GEMINI: env.CLAUDE_CODE_USE_GEMINI ?? null,
      CLAUDE_CODE_USE_OPENAI: env.CLAUDE_CODE_USE_OPENAI ?? null,
      CLAUDE_CODE_ENTRY_PROVIDER: env.CLAUDE_CODE_ENTRY_PROVIDER ?? null,
      CLAUDE_CODE_GEMINI_BACKEND: env.CLAUDE_CODE_GEMINI_BACKEND ?? null,
      CLAUDE_CODE_CODEX_BACKEND: env.CLAUDE_CODE_CODEX_BACKEND ?? null,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null,
      CLAUDE_TEAM_CONTROL_URL: env.CLAUDE_TEAM_CONTROL_URL ?? null,
    },
    args,
    claudePath,
  };
  logger.info(`[${teamName}] Launch runtime snapshot ${JSON.stringify(snapshot)}`);
}

function getPromptSizeSummary(prompt: string): PromptSizeSummary {
  return {
    chars: prompt.length,
    lines: prompt.length === 0 ? 0 : prompt.split(/\r?\n/g).length,
  };
}

type TeamsBaseLocation = 'configured' | 'default';

type ValidConfigProbeResult =
  | { ok: true; location: TeamsBaseLocation; configPath: string }
  | { ok: false };

function getTeamsBasePathsToProbe(): { location: TeamsBaseLocation; basePath: string }[] {
  const configured = getTeamsBasePath();
  const defaultBase = path.join(getAutoDetectedClaudeBasePath(), 'teams');
  if (path.resolve(configured) === path.resolve(defaultBase)) {
    return [{ location: 'configured', basePath: configured }];
  }
  return [
    { location: 'configured', basePath: configured },
    { location: 'default', basePath: defaultBase },
  ];
}

function logsSuggestShutdownOrCleanup(logs: string): boolean {
  const text = logs.toLowerCase();
  return (
    text.includes('shutdown') ||
    text.includes('clean up') ||
    text.includes('cleanup') ||
    text.includes('deactivate') ||
    text.includes('deactivated') ||
    text.includes('resources') ||
    // Russian keywords observed in some CLI outputs / user environments
    text.includes('очист') ||
    text.includes('очищ') ||
    text.includes('заверш') ||
    text.includes('деактив')
  );
}

function looksLikeClaudeStdoutJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  return (
    /"type"\s*:/.test(trimmed) ||
    /"message"\s*:/.test(trimmed) ||
    /"content"\s*:/.test(trimmed) ||
    /"subtype"\s*:/.test(trimmed) ||
    /"session_id"\s*:/.test(trimmed)
  );
}

interface ProvisioningRun {
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
  effectiveMembers: TeamCreateRequest['members'];
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
  /** True after emitApiErrorWarning() fires once — prevents duplicate warnings and pre-complete false positives. */
  apiErrorWarningEmitted: boolean;
  fsPhase: 'waiting_config' | 'waiting_members' | 'waiting_tasks' | 'all_files_found';
  waitingTasksSince: number | null;
  provisioningComplete: boolean;
  /** Path to the generated MCP config file for later cleanup. */
  mcpConfigPath: string | null;
  /** Path to the deterministic bootstrap spec file for later cleanup. */
  bootstrapSpecPath: string | null;
  /** Path to the deferred first-user-task file consumed by runtime after bootstrap. */
  bootstrapUserPromptPath: string | null;
  isLaunch: boolean;
  deterministicBootstrap: boolean;
  leadRelayCapture: {
    leadName: string;
    startedAt: string;
    textParts: string[];
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
   * request triggered by the UI. We suppress any lead→user echo for that turn.
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
    currentTokens: number;
    contextWindow: number;
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
  /** Pending tool approval requests awaiting user response (control_request protocol). */
  pendingApprovals: Map<string, ToolApprovalRequest>;
  /** Teammate permission_request IDs already intercepted (prevents re-processing read messages). */
  processedPermissionRequestIds: Set<string>;
  /**
   * Post-compact context reinjection lifecycle.
   * - pendingPostCompactReminder: compact_boundary was received; waiting for idle to inject.
   * - postCompactReminderInFlight: the reminder turn has been injected via stdin, waiting for result.
   * - suppressPostCompactReminderOutput: true while processing a reminder turn — suppress
   *   low-value acknowledgement text so the user doesn't see "OK, I'll remember that."
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
  memberSpawnStatuses: Map<
    string,
    {
      status: MemberSpawnStatus;
      launchState: MemberLaunchState;
      error?: string;
      hardFailureReason?: string;
      livenessSource?: MemberSpawnLivenessSource;
      agentToolAccepted?: boolean;
      runtimeAlive?: boolean;
      bootstrapConfirmed?: boolean;
      hardFailure?: boolean;
      firstSpawnAcceptedAt?: string;
      lastHeartbeatAt?: string;
      updatedAt: string;
    }
  >;
  /** Agent tool_use_id -> teammate name for persistent teammate spawns. */
  memberSpawnToolUseIds: Map<string, string>;
  /** Highest accepted deterministic bootstrap event sequence for this run. */
  lastDeterministicBootstrapSeq: number;
  /** Throttles config/inbox audit work triggered by frequent status polling. */
  lastMemberSpawnAuditAt: number;
  /** Throttles repeated audit warnings when config.json is temporarily unreadable. */
  lastMemberSpawnAuditConfigReadWarningAt: number;
  /** Per-member warning throttle for repeated "missing from config" logs. */
  lastMemberSpawnAuditMissingWarningAt: Map<string, number>;
}

type LeadActivityState = 'active' | 'idle' | 'offline';

type ProvisioningAuthSource =
  | 'anthropic_api_key'
  | 'anthropic_auth_token'
  | 'configured_api_key_missing'
  | 'codex_runtime'
  | 'gemini_runtime'
  | 'none';

interface ProvisioningEnvResolution {
  env: NodeJS.ProcessEnv;
  authSource: ProvisioningAuthSource;
  geminiRuntimeAuth: GeminiRuntimeAuthState | null;
  warning?: string;
}

interface PromptSizeSummary {
  chars: number;
  lines: number;
}

const MEMBER_LAUNCH_GRACE_MS = 90_000;

export function shouldWarnOnUnreadableMemberAuditConfig(params: {
  nowMs: number;
  lastWarnAt: number;
  expectedMembers: readonly string[];
  memberSpawnStatuses: ReadonlyMap<
    string,
    Pick<MemberSpawnStatusEntry, 'agentToolAccepted' | 'firstSpawnAcceptedAt'> | undefined
  >;
}): boolean {
  const { nowMs, lastWarnAt, expectedMembers, memberSpawnStatuses } = params;
  if (nowMs - lastWarnAt < MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS) {
    return false;
  }
  return expectedMembers.some((memberName) => {
    const current = memberSpawnStatuses.get(memberName);
    if (!current?.agentToolAccepted || typeof current.firstSpawnAcceptedAt !== 'string') {
      return false;
    }
    const acceptedAtMs = Date.parse(current.firstSpawnAcceptedAt);
    return Number.isFinite(acceptedAtMs) && nowMs - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;
  });
}

export function shouldWarnOnMissingRegisteredMember(params: {
  nowMs: number;
  lastWarnAt: number;
  graceExpired: boolean;
}): boolean {
  const { nowMs, lastWarnAt, graceExpired } = params;
  return graceExpired && nowMs - lastWarnAt >= MEMBER_SPAWN_AUDIT_WARNING_THROTTLE_MS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry {
  const updatedAt = nowIso();
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt,
  };
}

interface LiveTeamAgentRuntimeMetadata {
  model?: string;
}

function stripWrappedCliFlagValue(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unwrapped = trimmed.slice(1, -1).trim();
    return unwrapped.length > 0 ? unwrapped : undefined;
  }
  return trimmed;
}

function extractCliFlagValue(command: string, flagName: string): string | undefined {
  const escapedFlag = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escapedFlag}\\s+("([^"]*)"|'([^']*)'|([^\\s]+))`).exec(
    command
  );
  if (!match) {
    return undefined;
  }
  return stripWrappedCliFlagValue(match[2] ?? match[3] ?? match[4] ?? match[1]);
}

export function shouldAcceptDeterministicBootstrapEvent(params: {
  runId: string;
  teamName: string;
  lastSeq: number;
  msg: Record<string, unknown>;
}): { accept: boolean; nextSeq: number } {
  const msgRunId = typeof params.msg.run_id === 'string' ? params.msg.run_id.trim() : '';
  if (msgRunId && msgRunId !== params.runId) {
    return { accept: false, nextSeq: params.lastSeq };
  }

  const msgTeamName = typeof params.msg.team_name === 'string' ? params.msg.team_name.trim() : '';
  if (msgTeamName && msgTeamName !== params.teamName) {
    return { accept: false, nextSeq: params.lastSeq };
  }

  const seq = typeof params.msg.seq === 'number' ? params.msg.seq : NaN;
  if (Number.isFinite(seq)) {
    if (!Number.isInteger(seq) || seq <= params.lastSeq) {
      return { accept: false, nextSeq: params.lastSeq };
    }
    return { accept: true, nextSeq: seq };
  }

  return { accept: true, nextSeq: params.lastSeq };
}

function deriveMemberLaunchState(entry: {
  agentToolAccepted?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  hardFailure?: boolean;
}): MemberLaunchState {
  if (entry.hardFailure) {
    return 'failed_to_start';
  }
  if (entry.bootstrapConfirmed) {
    return 'confirmed_alive';
  }
  if (entry.runtimeAlive || entry.agentToolAccepted) {
    return 'runtime_pending_bootstrap';
  }
  return 'starting';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function ensureCwdExists(cwd: string): Promise<void> {
  await fs.promises.mkdir(cwd, { recursive: true });
  const stat = await fs.promises.stat(cwd);
  if (!stat.isDirectory()) {
    throw new Error('cwd must be a directory');
  }
}

function isMissingCwdSpawnError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('spawn ') && lower.includes(' enoent');
}

/** @deprecated Use wrapAgentBlock from @shared/constants/agentBlocks instead. */
const wrapInAgentBlock = wrapAgentBlock;

function indentMultiline(text: string, indent: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function formatWorkflowBlock(workflow: string, indent: string): string {
  const trimmed = workflow.trim();
  if (trimmed.length === 0) return '';
  const body = indentMultiline(trimmed, indent);
  return `\n${indent}---BEGIN WORKFLOW---\n${body}\n${indent}---END WORKFLOW---`;
}

type TeamMemberInput = TeamCreateRequest['members'][number];

function normalizeTeamMemberProviderId(providerId: unknown): TeamProviderId | undefined {
  return providerId === 'codex' || providerId === 'gemini' || providerId === 'anthropic'
    ? providerId
    : undefined;
}

function buildEffectiveTeamMemberSpec(
  member: TeamMemberInput,
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamMemberInput {
  const memberProviderId = normalizeTeamMemberProviderId(member.providerId);
  const defaultProviderId = normalizeTeamMemberProviderId(defaults.providerId);
  const effectiveProviderId = memberProviderId ?? defaultProviderId ?? 'anthropic';
  const model =
    member.model?.trim() ||
    (memberProviderId == null || memberProviderId === defaultProviderId
      ? defaults.model?.trim()
      : undefined) ||
    undefined;

  return {
    ...member,
    providerId: effectiveProviderId,
    model,
    effort: member.effort ?? defaults.effort,
  };
}

function buildEffectiveTeamMemberSpecs(
  members: TeamCreateRequest['members'],
  defaults: {
    providerId?: TeamProviderId;
    model?: string;
    effort?: TeamCreateRequest['effort'];
  }
): TeamCreateRequest['members'] {
  return members.map((member) => buildEffectiveTeamMemberSpec(member, defaults));
}

function shouldSkipResumeForProviderRuntimeChange(
  request: Pick<TeamLaunchRequest, 'providerId' | 'model'>,
  config: Record<string, unknown>
): { skip: boolean; reason?: string } {
  const providerId = normalizeTeamMemberProviderId(request.providerId);
  if (providerId !== 'gemini' && providerId !== 'codex') {
    return { skip: false };
  }

  const members = Array.isArray(config.members)
    ? (config.members as Record<string, unknown>[])
    : [];
  const lead =
    members.find((member) => isLeadMember(member)) ??
    members.find((member) => {
      const name = typeof member?.name === 'string' ? member.name.trim().toLowerCase() : '';
      return name === 'team-lead';
    });
  if (!lead) {
    return { skip: false };
  }

  const currentLeadProviderId =
    normalizeTeamMemberProviderId(
      typeof lead.providerId === 'string'
        ? lead.providerId
        : typeof lead.provider === 'string'
          ? lead.provider
          : providerId
    ) ?? providerId;
  const requestedModel = request.model?.trim() || '';
  const currentLeadModel = typeof lead.model === 'string' ? lead.model.trim() : '';

  if (currentLeadProviderId !== providerId) {
    return {
      skip: true,
      reason: `provider changed (${currentLeadProviderId} -> ${providerId})`,
    };
  }

  if (requestedModel && currentLeadModel && requestedModel !== currentLeadModel) {
    return {
      skip: true,
      reason: `model changed (${currentLeadModel} -> ${requestedModel})`,
    };
  }

  return { skip: false };
}

function buildMembersPrompt(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (role: ${member.role.trim()})` : '';
      const providerPart =
        member.providerId && member.providerId !== 'anthropic'
          ? ` [provider: ${member.providerId}]`
          : '';
      const modelPart = member.model?.trim() ? ` [model: ${member.model.trim()}]` : '';
      const effortPart = member.effort ? ` [effort: ${member.effort}]` : '';
      const workflowPart = member.workflow?.trim()
        ? `\n     Workflow/instructions:${formatWorkflowBlock(member.workflow, '       ')}`
        : '';
      return `- ${member.name}${rolePart}${providerPart}${modelPart}${effortPart}${workflowPart}`;
    })
    .join('\n');
}

/** Compact roster: name + role only, no workflow details. Used for post-compact reminders. */
function buildCompactMembersRoster(members: TeamCreateRequest['members']): string {
  return members
    .map((member) => {
      const rolePart = member.role?.trim() ? ` (${member.role.trim()})` : '';
      return `- ${member.name}${rolePart}`;
    })
    .join('\n');
}

function buildTeammateAgentBlockReminder(): string {
  return [
    `Hidden internal instructions rule (IMPORTANT):`,
    `- If you send internal operational instructions to another agent/teammate that the human user must NOT see in the UI, wrap ONLY that hidden part in:`,
    `  ${AGENT_BLOCK_OPEN}`,
    `  ... hidden instructions only ...`,
    `  ${AGENT_BLOCK_CLOSE}`,
    `- Keep normal human-readable coordination outside the block.`,
    `- NEVER use agent-only blocks in messages to "user".`,
  ].join('\n');
}

function extractHeartbeatTimestamp(text: string, fallback?: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return fallback?.trim() || undefined;
  try {
    const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    if (typeof parsed.timestamp === 'string' && parsed.timestamp.trim().length > 0) {
      return parsed.timestamp.trim();
    }
  } catch {
    // Best-effort only. Non-JSON teammate messages still use the inbox timestamp fallback.
  }
  return fallback?.trim() || undefined;
}

function extractBootstrapFailureReason(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const looksLikeBootstrapFailure =
    lower.includes('bootstrap failed') ||
    lower.includes('bootstrap failure') ||
    lower.includes('bootstrap error') ||
    lower.includes('bootstrap не удался') ||
    lower.includes('сбой bootstrap') ||
    ((lower.includes('member') || lower.includes('член')) && lower.includes('not found')) ||
    (lower.includes('не найден') &&
      (lower.includes('член') || lower.includes('member') || lower.includes('inbox'))) ||
    lower.includes('member_briefing tool is not available') ||
    lower.includes('member_briefing tool not found') ||
    lower.includes('no such tool available: mcp__agent_teams__member_briefing') ||
    lower.includes('agent calls that include team_name must also include name') ||
    (lower.includes('member_briefing') &&
      (lower.includes('not available') ||
        lower.includes('not found') ||
        lower.includes('lookup failure') ||
        lower.includes('validation error') ||
        lower.includes('api error'))) ||
    lower.includes('model is not supported') ||
    lower.includes('model is not available') ||
    lower.includes('model not available') ||
    lower.includes('model unavailable') ||
    lower.includes('model not found') ||
    lower.includes('unknown model') ||
    lower.includes('invalid model') ||
    lower.includes('unsupported model') ||
    lower.includes('not supported when using codex with a chatgpt account') ||
    lower.includes('please check the provided tool list');
  if (!looksLikeBootstrapFailure) return null;
  return trimmed.slice(0, 280);
}

function extractTranscriptTextContent(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { type?: unknown; text?: unknown; content?: unknown };
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      parts.push(record.text.trim());
      continue;
    }
    parts.push(...extractTranscriptTextContent(record.content));
  }
  return parts;
}

function extractTranscriptMessageText(record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const normalizedRecord = record as {
    text?: unknown;
    content?: unknown;
    message?: unknown;
    toolUseResult?: unknown;
  };
  if (typeof normalizedRecord.text === 'string' && normalizedRecord.text.trim()) {
    return normalizedRecord.text.trim();
  }
  const fromContent = extractTranscriptTextContent(normalizedRecord.content);
  if (fromContent.length > 0) {
    return fromContent.join('\n');
  }
  const fromToolUseResult = extractTranscriptTextContent(normalizedRecord.toolUseResult);
  if (fromToolUseResult.length > 0) {
    return fromToolUseResult.join('\n');
  }
  if (normalizedRecord.message) {
    return extractTranscriptMessageText(normalizedRecord.message);
  }
  return null;
}

function normalizeMemberDiagnosticText(memberName: string, text: string): string {
  return `${memberName}: ${text.trim()}`;
}

function shouldUseGeminiStagedLaunch(providerId: TeamProviderId | undefined): boolean {
  return resolveTeamProviderId(providerId) === 'gemini';
}

function buildGeminiMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  displayName: string,
  teamName: string,
  leadName: string
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim() ? `\nModel override: ${member.model.trim()}.` : '';
  const effortLine = member.effort ? `\nEffort override: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim() ? `\nWorkflow:\n${member.workflow.trim()}` : '';

  return `You are ${member.name}, a ${role} on team "${displayName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

${getAgentLanguageInstruction()}
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly. Do NOT use Agent, any subagent, or any delegated helper for this step.
If member_briefing fails, SendMessage "${leadName}" one short natural-language sentence with the exact error text. Do NOT send only "bootstrap failed".
${getCanonicalSendMessageFieldRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'bootstrap error', message: 'exact error text' })}
After member_briefing succeeds, stay silent until you have a real blocker, question, or task result. Do NOT send raw tool output, JSON, dict/object dumps, or internal state payloads.
- Review flow rule: review happens on the SAME work task. If task #X needs review and a reviewer exists or has been named, the owner completes #X and sends #X through review_request, and the reviewer handles review_start then review_approve/review_request_changes on #X. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".`;
}

function buildGeminiReconnectMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  teamName: string,
  leadName: string
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim() ? `\nModel override: ${member.model.trim()}.` : '';
  const effortLine = member.effort ? `\nEffort override: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim() ? `\nWorkflow:\n${member.workflow.trim()}` : '';

  return `You are ${member.name}, a ${role} on team "${teamName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

${getAgentLanguageInstruction()}
The team has just been reconnected after a restart.
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly. Do NOT use Agent, any subagent, or any delegated helper for this step.
If member_briefing fails, SendMessage "${leadName}" one short natural-language sentence with the exact error text. Do NOT send only "bootstrap failed".
${getCanonicalSendMessageFieldRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'bootstrap error', message: 'exact error text' })}
After member_briefing succeeds, stay silent unless you have a real blocker, question, or task result. Do NOT send raw tool output, JSON, dict/object dumps, or internal state payloads.
- Review flow rule: review happens on the SAME work task. If task #X needs review and a reviewer exists or has been named, the owner completes #X and sends #X through review_request, and the reviewer handles review_start then review_approve/review_request_changes on #X. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".`;
}

function buildMemberReviewFlowReminder(): string {
  return [
    '- Review flow rule: review is a state transition on the SAME work task, not a separate task.',
    '- If your task #X needs review and a reviewer exists or has been named, finish the work on #X, call task_complete on #X, then use review_request on #X for that reviewer. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".',
    '- If you are the reviewer for task #X, call review_start on #X first, then review_approve or review_request_changes on #X itself.',
    '- If review requests changes, resume/fix the SAME task #X, then task_complete #X and send #X back through review_request when ready.',
  ].join('\n');
}

function buildMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  displayName: string,
  teamName: string,
  leadName: string
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\nProvider override for this teammate: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim()
    ? `\nModel override for this teammate: ${member.model.trim()}.`
    : '';
  const effortLine = member.effort ? `\nEffort override for this teammate: ${member.effort}.` : '';
  const workflowBlock = member.workflow?.trim()
    ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(member.workflow, '')}`
    : '';
  const actionModeProtocol = protocols.buildActionModeProtocolText(
    protocols.MEMBER_DELEGATE_DESCRIPTION
  );
  return `You are ${member.name}, a ${role} on team "${displayName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

${getAgentLanguageInstruction()}
Your FIRST action: call MCP tool member_briefing with:
{ teamName: "${teamName}", memberName: "${member.name}" }
Call member_briefing directly as your own MCP tool call. Do NOT use the Agent tool, any subagent, or any delegated helper for this step.
member_briefing is expected to be available in your initial MCP tool list. If it is missing or unavailable, treat that as a real bootstrap error and report the exact error text to your team lead.
Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.
If member_briefing fails, send one short natural-language message to your team lead "${leadName}" that includes the exact failure reason (for example the API error, validation error, or lookup failure), then wait. Do NOT send only "bootstrap failed".
IMPORTANT: When sending messages to the team lead, always use the exact name "${leadName}" in the \`to\` field of SendMessage. Never abbreviate or shorten it (e.g. do NOT use "lead" instead of "team-lead").
${getCanonicalSendMessageFieldRule()}
Correct example:
${buildCanonicalSendMessageExample({ to: leadName, summary: 'short update', message: 'your message' })}
After member_briefing succeeds:
- Do NOT send a "ready", "online", "status accepted", or other acknowledgement-only message just to confirm you started successfully.
- If bootstrap succeeded and you have no task yet, stay silent and wait for task assignments.
- Only SendMessage the lead after bootstrap when there is a real blocker, a failed bootstrap, an explicit question, an urgent coordination need, or a completed task result to report.
- Never send raw tool output, JSON, dict/object dumps, Python-style structs, or internal state payloads to the lead or the user. If you need to report bootstrap/task/tool status, rewrite it as one short natural-language sentence.
- When you later receive work or reconnect after a restart, use task_briefing as your compact queue view. Use task_get when you need the full task context before starting a pending/needsFix task or when the in_progress briefing details are not enough.
- If a newly assigned task cannot be started immediately because you are still busy on another task, leave a short task comment on that waiting task right away with the reason and your best ETA, keep it in pending/TODO, and only move it to in_progress with task_start when you truly begin.
- CRITICAL: If someone comments on your task, you MUST reply on that same task via task_add_comment. Never leave a user/lead/teammate task comment unanswered, even if the reply is only a short acknowledgement or status update. Do NOT treat status changes or direct messages as a substitute for an on-task reply.
- CRITICAL: If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on that same task, FIRST leave a short task comment saying what you are about to do, THEN move it to in_progress with task_start, THEN do the work, and when finished leave a short result comment and move it to done with task_complete. Never skip this comment -> reopen -> work -> comment -> done cycle.
- CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment via task_add_comment BEFORE calling task_complete. Save the comment.id from the response — you will need it in the next step. The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.
- After task_complete, notify your team lead via SendMessage. Use the comment.id you saved (first 8 characters). Include: task ref, brief summary (2-4 sentences), pointer to full comment, and next step. Example: "#abcd1234 done. Found 3 competitors, two lack kanban. For full details: task_get_comment { taskId: "abcd1234", commentId: "e5f6a7b8" }. Moving to #efgh5678."
- Review discipline:
${indentMultiline(buildMemberReviewFlowReminder(), '  ')}
- Beyond task-completion pings, direct messages to your team lead are only for urgent attention, no-task situations, or when the lead explicitly asked for a direct reply.
- If a task-scoped update is already recorded in a task comment, do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention. When skipping a message, stay silent — never output meta-commentary about skipped or already-delivered messages.
${buildTeammateAgentBlockReminder()}
${actionModeProtocol}`;
}

function buildReconnectMemberSpawnPrompt(
  member: TeamCreateRequest['members'][number],
  teamName: string,
  leadName: string,
  hasTasks: boolean
): string {
  const role = member.role?.trim() || 'team member';
  const providerLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `\n     Provider override for this teammate: ${member.providerId}.`
      : '';
  const modelLine = member.model?.trim()
    ? `\n     Model override for this teammate: ${member.model.trim()}.`
    : '';
  const effortLine = member.effort
    ? `\n     Effort override for this teammate: ${member.effort}.`
    : '';
  const workflowBlock = member.workflow?.trim()
    ? `\n\nYour workflow and how you should behave:${formatWorkflowBlock(member.workflow, '     ')}`
    : '';
  const actionModeProtocol = indentMultiline(
    protocols.buildActionModeProtocolText(protocols.MEMBER_DELEGATE_DESCRIPTION),
    '     '
  );
  const providerArgLine =
    member.providerId && member.providerId !== 'anthropic'
      ? `   - provider: "${member.providerId}"\n`
      : '';
  const modelArgLine = member.model?.trim() ? `   - model: "${member.model.trim()}"\n` : '';
  const effortArgLine = member.effort ? `   - effort: "${member.effort}"\n` : '';
  return `   For "${member.name}":
${providerArgLine}${modelArgLine}${effortArgLine}   - prompt:
     You are ${member.name}, a ${role} on team "${teamName}" (${teamName}).${providerLine}${modelLine}${effortLine}${workflowBlock}

     ${getAgentLanguageInstruction()}
     The team has been reconnected after a restart.
     ${
       hasTasks
         ? 'You may have assigned tasks in states like in_progress, needsFix, pending, review, completed, or approved from the previous session.'
         : 'You have no assigned tasks currently.'
     }
     Your FIRST action: call MCP tool member_briefing with:
     { teamName: "${teamName}", memberName: "${member.name}" }
     Call member_briefing directly as your own MCP tool call. Do NOT use the Agent tool, any subagent, or any delegated helper for this step.
     member_briefing is expected to be available in your initial MCP tool list. If it is missing or unavailable, treat that as a real bootstrap error and report the exact error text to your team lead.
     Do NOT start work, claim tasks, or improvise workflow/task/process rules before member_briefing succeeds.
     If member_briefing fails, send one short natural-language message to your team lead "${leadName}" that includes the exact failure reason (for example the API error, validation error, or lookup failure), then wait. Do NOT send only "bootstrap failed".
     IMPORTANT: When sending messages to the team lead, always use the exact name "${leadName}" in the \`to\` field of SendMessage. Never abbreviate or shorten it (e.g. do NOT use "lead" instead of "team-lead").
     ${buildTeammateAgentBlockReminder()}
${actionModeProtocol}

     After member_briefing succeeds:
     - Do NOT send a "ready", "online", "status accepted", or other acknowledgement-only message just to confirm you reconnected successfully.
     - If reconnect bootstrap succeeded and you have no immediate blocker or question, stay silent and continue with your queue.
     - Never send raw tool output, JSON, dict/object dumps, Python-style structs, or internal state payloads to the lead or the user. If you need to report bootstrap/task/tool status, rewrite it as one short natural-language sentence.
     - Use task_briefing as your compact queue view.
     - If task_briefing shows any in_progress task, resume/finish those first. Call task_get only if you need more context than task_briefing already gave you.
     - After that, prioritize tasks marked Needs fixes after review, then normal pending tasks.
     - Before you start any needsFix or pending task, call task_get for that specific task.
     - If a newly assigned needsFix or pending task must wait because you are still finishing another task, leave a short task comment on that waiting task with the reason and your best ETA, keep it in pending/TODO (use task_set_status pending if needed), and only run task_start when you truly begin.
     - CRITICAL: If someone comments on your task, you MUST reply on that same task via task_add_comment. Never leave a user/lead/teammate task comment unanswered, even if the reply is only a short acknowledgement or status update. Do NOT treat status changes or direct messages as a substitute for an on-task reply.
     - If you are the one about to do the implementation/fixes and the owner is missing or someone else, run task_set_owner to yourself immediately before task_start.
     - Only then run task_start when you truly begin.
     - If a task gets a new comment and you are going to do additional implementation/fix/follow-up work on it, FIRST leave a short task comment saying what you are about to do, THEN run task_start, then do the work, and when finished leave a short result comment and run task_complete again. Never skip this comment -> reopen -> work -> comment -> done cycle.
     - CRITICAL: When you finish a task, your results (findings, research report, analysis, code changes summary, or any deliverable) MUST be posted as a task comment BEFORE calling task_complete. The task comment is the primary delivery channel — the user reads results on the task board. A SendMessage to the lead is NOT a substitute: direct messages are ephemeral and not visible on the board. If you only SendMessage without a task comment, the user will never see your work.
     - After task_complete, notify your team lead via SendMessage. The task_add_comment response contains comment.id (UUID) — take its first 8 characters as the short commentId. Include: task ref, brief summary (2-4 sentences), pointer to full comment, and next step. Example: "#abcd1234 done. Found 3 competitors, two lack kanban. For full details: task_get_comment { taskId: "abcd1234", commentId: "e5f6a7b8" }. Moving to #efgh5678."
     - Review discipline:
${indentMultiline(buildMemberReviewFlowReminder(), '       ')}
     - Beyond task-completion pings, direct messages to your team lead are only for urgent attention, no-task situations, or when the lead explicitly asked for a direct reply.
     - If a task-scoped update is already recorded in a task comment, do NOT send a duplicate SendMessage to the lead with the same content unless you need urgent non-task attention. When skipping a message, stay silent — never output meta-commentary about skipped or already-delivered messages.
     - If you have no tasks, wait for new assignments.`;
}

export function buildAddMemberSpawnMessage(
  teamName: string,
  displayName: string,
  leadName: string,
  member: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'providerId' | 'model' | 'effort'
  >
): string {
  const roleHint =
    typeof member.role === 'string' && member.role.trim()
      ? ` with role "${member.role.trim()}"`
      : '';
  const workflowHint =
    typeof member.workflow === 'string' && member.workflow.trim()
      ? ` Their workflow: ${member.workflow.trim()}`
      : '';

  const prompt = buildMemberSpawnPrompt(
    {
      name: member.name,
      ...(member.role ? { role: member.role } : {}),
      ...(member.workflow ? { workflow: member.workflow } : {}),
      ...(member.providerId ? { providerId: member.providerId } : {}),
      ...(member.model ? { model: member.model } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
    },
    displayName,
    teamName,
    leadName
  );
  const providerPart =
    member.providerId && member.providerId !== 'anthropic'
      ? `, provider="${member.providerId}"`
      : '';
  const modelPart = member.model?.trim() ? `, model="${member.model.trim()}"` : '';
  const effortPart = member.effort ? `, effort="${member.effort}"` : '';

  return (
    `A new teammate "${member.name}"${roleHint} has been added to the team. ` +
    `Please spawn them immediately using the **Agent** tool with team_name="${teamName}", name="${member.name}", subagent_type="general-purpose"${providerPart}${modelPart}${effortPart}, and the exact prompt below:${workflowHint}\n\n` +
    indentMultiline(prompt, '  ')
  );
}

interface RuntimeBootstrapMemberSpec {
  name: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  provider?: TeamProviderId;
  effort?: EffortLevel;
  agentType?: string;
  description?: string;
  useSplitPane?: boolean;
  planModeRequired?: boolean;
}

interface RuntimeBootstrapSpec {
  version: 1;
  runId: string;
  mode: 'create' | 'launch';
  initiator: {
    kind: 'app';
    source: 'claude_team_agent_teams_orchestrator';
  };
  team: {
    name: string;
    displayName?: string;
    description?: string;
    color?: string;
    cwd: string;
  };
  lead: {
    agentLanguage?: string;
    permissionSeedTools?: string[];
  };
  members: RuntimeBootstrapMemberSpec[];
  launch?: {
    bootstrapTimeoutMs?: number;
    continueOnPartialFailure?: boolean;
  };
  ui?: {
    emitStructuredEvents?: boolean;
  };
}

function buildDeterministicCreateBootstrapSpec(
  runId: string,
  request: TeamCreateRequest,
  effectiveMembers: TeamCreateRequest['members']
): RuntimeBootstrapSpec {
  return {
    version: 1,
    runId,
    mode: 'create',
    initiator: {
      kind: 'app',
      source: 'claude_team_agent_teams_orchestrator',
    },
    team: {
      name: request.teamName,
      ...(request.displayName?.trim() ? { displayName: request.displayName.trim() } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.color?.trim() ? { color: request.color.trim() } : {}),
      cwd: request.cwd,
    },
    lead: {
      agentLanguage: getConfiguredAgentLanguageName(),
      ...(request.skipPermissions === false
        ? {
            permissionSeedTools: [
              ...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
              'Edit',
              'Write',
              'NotebookEdit',
            ],
          }
        : {}),
    },
    members: effectiveMembers.map((member) => ({
      name: member.name,
      ...(member.role?.trim() ? { role: member.role.trim() } : {}),
      ...(member.workflow?.trim() ? { workflow: member.workflow.trim() } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(member.model?.trim() ? { model: member.model.trim() } : {}),
      ...(member.providerId ? { provider: member.providerId } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
      ...(member.role?.trim() ? { description: member.role.trim() } : {}),
    })),
    launch: {
      continueOnPartialFailure: true,
    },
    ui: {
      emitStructuredEvents: true,
    },
  };
}

function buildDeterministicLaunchBootstrapSpec(
  runId: string,
  request: TeamLaunchRequest,
  effectiveMembers: TeamCreateRequest['members']
): RuntimeBootstrapSpec {
  return {
    version: 1,
    runId,
    mode: 'launch',
    initiator: {
      kind: 'app',
      source: 'claude_team_agent_teams_orchestrator',
    },
    team: {
      name: request.teamName,
      cwd: request.cwd,
    },
    lead: {
      agentLanguage: getConfiguredAgentLanguageName(),
      ...(request.skipPermissions === false
        ? {
            permissionSeedTools: [
              ...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
              'Edit',
              'Write',
              'NotebookEdit',
            ],
          }
        : {}),
    },
    members: effectiveMembers.map((member) => ({
      name: member.name,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(member.model?.trim() ? { model: member.model.trim() } : {}),
      ...(member.providerId ? { provider: member.providerId } : {}),
      ...(member.effort ? { effort: member.effort } : {}),
      ...(member.role?.trim() ? { role: member.role.trim() } : {}),
      ...(member.workflow?.trim() ? { workflow: member.workflow.trim() } : {}),
      ...(member.role?.trim() ? { description: member.role.trim() } : {}),
    })),
    launch: {
      continueOnPartialFailure: true,
    },
    ui: {
      emitStructuredEvents: true,
    },
  };
}

async function writeDeterministicBootstrapSpecFile(spec: RuntimeBootstrapSpec): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-teams-bootstrap-'));
  const filePath = path.join(tempDir, `${spec.team.name}-${randomUUID()}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(spec), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

async function removeDeterministicBootstrapTempFile(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
  await fs.promises.rmdir(path.dirname(filePath)).catch(() => {});
}

async function removeDeterministicBootstrapSpecFile(filePath: string | null): Promise<void> {
  await removeDeterministicBootstrapTempFile(filePath);
}

async function writeDeterministicBootstrapUserPromptFile(prompt: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agent-teams-bootstrap-prompt-')
  );
  const filePath = path.join(tempDir, `${randomUUID()}.txt`);
  await fs.promises.writeFile(filePath, prompt, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}

async function removeDeterministicBootstrapUserPromptFile(filePath: string | null): Promise<void> {
  await removeDeterministicBootstrapTempFile(filePath);
}

function buildTeamCtlOpsInstructions(teamName: string, leadName: string): string {
  return wrapInAgentBlock(
    [
      `Internal task board tooling (MCP):`,
      `- Use the board-management MCP tools for tasks that must appear on the team board (assigned work, substantial work, or when the user explicitly asks to create a task).`,
      ``,
      `Execution discipline (CRITICAL — prevents misleading task boards):`,
      `- Start a task (move to in_progress) ONLY when you are actually beginning work on it.`,
      `- Complete a task ONLY when it is truly finished (and any required verification is done).`,
      `- If you assign work to a teammate who already has another in_progress task, create/keep the newly assigned task in pending/TODO. Do NOT move it to in_progress on their behalf before they actually start.`,
      `- Never bulk-move many tasks at the end of a session — update status incrementally as you work.`,
      `- Record meaningful progress, decisions, and blockers as task comments so context is preserved on the board.`,
      `- CRITICAL: Task results (findings, reports, analysis, code changes) MUST be posted as task comments — the user reads results on the task board. Direct messages alone are not visible on the board and the user will miss them.`,
      ``,
      `Parallelization guideline (IMPORTANT):`,
      `- If a task is genuinely parallelizable, split it into multiple smaller tasks owned by different members.`,
      `  - Prefer splitting by independent deliverables (e.g. frontend/backend, API/UI, parsing/rendering, tests/docs) rather than arbitrary slices.`,
      `  - Use blockedBy only when one piece truly cannot start without another; otherwise link with related.`,
      `  - Do NOT split when work is inherently sequential, requires one person to keep consistent context, or the overhead would exceed the benefit.`,
      `  - When splitting, make each task have a clear completion criterion and a single accountable owner.`,
      ``,
      `IMPORTANT: The board MCP only supports these domains: task, kanban, review, message, process. There is NO "member" domain — team members are managed by spawning teammates via the Task tool, not via the board MCP.`,
      ``,
      `Task board operations — use MCP tools directly:`,
      `- Get task details: task_get { teamName: "${teamName}", taskId: "<id>" }`,
      `- Get a single comment without loading full task: task_get_comment { teamName: "${teamName}", taskId: "<id>", commentId: "<commentId or prefix>" }`,
      `  When a teammate reports "#abcd1234 done ... task_get_comment { taskId: "abcd1234", commentId: "e5f6a7b8" }", use that taskId and commentId to fetch the full result text.`,
      `- List all tasks: task_list { teamName: "${teamName}" }`,
      `- Create task: task_create { teamName: "${teamName}", subject: "...", description?: "...", owner?: "<actual-member-name>", createdBy?: "<your-name>", blockedBy?: ["1","2"], related?: ["3"] }`,
      `- Create task from user message (preferred when you have a MessageId from a relayed inbox message): task_create_from_message { teamName: "${teamName}", messageId: "<exact-messageId>", subject: "...", owner?: "<member>", createdBy?: "<your-name>", blockedBy?: ["1","2"], related?: ["3"] }`,
      `- Assign/reassign owner: task_set_owner { teamName: "${teamName}", taskId: "<id>", owner: "<member-name>" }`,
      `- Clear owner: task_set_owner { teamName: "${teamName}", taskId: "<id>", owner: null }`,
      `- Start task (preferred over set-status): task_start { teamName: "${teamName}", taskId: "<id>" }`,
      `- Complete task (preferred over set-status): task_complete { teamName: "${teamName}", taskId: "<id>" }`,
      `- Update status: task_set_status { teamName: "${teamName}", taskId: "<id>", status: "pending|in_progress|completed|deleted" }`,
      `- Add comment: task_add_comment { teamName: "${teamName}", taskId: "<id>", text: "...", from: "${leadName}" }`,
      `- Attach file to task: task_attach_file { teamName: "${teamName}", taskId: "<id>", filePath: "<path>", mode?: "copy|link", filename?: "<name>", mimeType?: "<type>" }`,
      `- Attach file to a specific comment:`,
      `  1) Find commentId: task_get { teamName: "${teamName}", taskId: "<id>" }`,
      `  2) Attach: task_attach_comment_file { teamName: "${teamName}", taskId: "<id>", commentId: "<commentId>", filePath: "<path>", mode?: "copy|link", filename?: "<name>", mimeType?: "<type>" }`,
      `- Create with deps (blocked work MUST be pending): task_create { teamName: "${teamName}", subject: "...", owner: "<member>", createdBy: "<your-name>", blockedBy: ["1","2"], related?: ["3"], startImmediately: false }`,
      `- Link dependency: task_link { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "blocked-by" }`,
      `- Link related: task_link { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "related" }`,
      `- Unlink: task_unlink { teamName: "${teamName}", taskId: "<id>", targetId: "<targetId>", relationship: "blocked-by" }`,
      `- Set clarification flag: task_set_clarification { teamName: "${teamName}", taskId: "<id>", value: "lead"|"user"|"clear" }`,
      ``,
      `Review operations — use MCP tools directly (text comments do NOT change kanban state):`,
      `- Request review (after task_complete): review_request { teamName: "${teamName}", taskId: "<id>", from: "${leadName}", reviewer: "<reviewer-name>" }`,
      `- Start review (reviewer signals they are beginning): review_start { teamName: "${teamName}", taskId: "<id>", from: "<reviewer-name>" }`,
      `- Approve review: review_approve { teamName: "${teamName}", taskId: "<id>", note?: "<note>", notifyOwner: true }`,
      `  Call review_approve EXACTLY ONCE per review. Include your review feedback in the "note" field of that single call. Do NOT call it twice (once to approve, once with a note). The tool auto-creates a comment from the note.`,
      `- Request changes: review_request_changes { teamName: "${teamName}", taskId: "<id>", comment: "<what to fix>" }`,
      `CRITICAL: Review is a state transition on the EXISTING work task. When implementation for task #X needs review, move #X through the review flow with review_request/review_start/review_approve/review_request_changes. Do NOT create a new separate task just to represent that review.`,
      `CRITICAL: Only send task #X into review when a concrete reviewer exists for #X. If no reviewer exists yet, keep #X completed until you assign/decide the reviewer. Do NOT use review_request just to park the task in REVIEW without an actual reviewer.`,
      `CRITICAL: Writing "approved" or "LGTM" as a task comment does NOT move the task on the kanban board. You MUST call the review_approve MCP tool. Without the tool call the task stays stuck in the REVIEW column.`,
      ``,
      `Background service operations — use MCP tools directly (dev servers, watchers, databases, etc.; NOT teammate-agent liveness):`,
      protocols.buildProcessProtocolText(teamName),
      ``,
      `Attachment storage modes (IMPORTANT):`,
      `- Default is copy (safe, robust).`,
      `- Use mode: "link" to try a hardlink (no duplication). It may fall back to copy unless you disable fallback.`,
      ``,
      `Dependency guidelines:`,
      `- Use blockedBy when a task cannot start until another is done.`,
      `- If you set blockedBy, create the task in pending (for example with startImmediately: false). Do NOT put blocked tasks into in_progress.`,
      `- Use related to link related work (e.g. frontend + backend) without blocking.`,
      `- Review tasks: By default, NEVER create a separate "review task". Reviews belong to the existing work task (#X) and must use the dedicated review flow on #X.`,
      `  - Correct flow: finish implementation on #X -> task_complete #X -> review_request #X -> reviewer runs review_start #X -> reviewer runs review_approve or review_request_changes on #X.`,
      `  - Only move #X into REVIEW when a real reviewer exists for #X. If nobody is reviewing it yet, keep #X completed until the reviewer is decided.`,
      `  - The REVIEW column is for the same task #X moving through review. It is NOT a signal to create another task for review.`,
      `  - Dependencies do not auto-start tasks; the owner must explicitly start it when ready.`,
      `- Avoid over-specifying. Only add dependencies when execution order matters.`,
      ``,
      `Notification policy:`,
      `- Task assignment notifications are handled by the board runtime, so do NOT send a separate SendMessage for the same assignment unless you have extra context that is not already on the task.`,
      `- Review requests are also handled by the board runtime: review_request already notifies the reviewer, so do NOT send a second manual SendMessage for the same review request unless you are adding materially new context that is not already on the task.`,
      `- When beginning a review, always call review_start first to move the task into the REVIEW column on the kanban board.`,
      `- If you receive a task-scoped system notification like "Comment on #...", reply on-task only when you have a substantive update: a decision, blocker, clarification answer, review result, or a concrete next-step change that belongs on the board.`,
      `- Do NOT post acknowledgement-only task comments such as "Принято", "Ок", "На связи", "Жду", or similar low-signal echoes. If the notification is FYI and no durable update is needed, say nothing and write nothing.`,
      `- Teammate task comments are auto-forwarded to you. When that happens, reply on-task first only if the task actually needs a durable board update. Direct messages are allowed only as an additional urgent wake-up ping or clearly non-task coordination, never as a substitute for a substantive task comment.`,
      `- When you skip sending a message because it would be a duplicate or was already delivered, produce NO text output about it. Do not write meta-commentary like "(Already relayed…)", "(No additional relay needed…)", or similar. Just silently move on.`,
      `- Ownership must reflect the person actually doing the implementation/fix work. If someone takes over execution, update the owner immediately before they start. Do NOT leave the lead/planner as owner when another member is doing the work.`,
      `- Set createdBy when creating tasks so workflow history shows who created the task.`,
      ``,
      `Clarification handling (CRITICAL — MANDATORY for correct task board state):`,
      `- When a teammate needs clarification (needsClarification: "lead"), you MUST reply via task comment first. This is the durable answer, auto-clears the flag, and wakes the owner.`,
      `- If you also send a SendMessage for urgency/visibility, treat it as an extra notification only — never as a substitute for the task-comment reply.`,
      `- If you somehow reply via SendMessage before commenting, add the missing task comment immediately, and if needed also clear the flag manually:`,
      `  task_set_clarification { teamName: "${teamName}", taskId: "<taskId>", value: "clear" }`,
      `- If you cannot answer and the user needs to decide — ESCALATION PROTOCOL:`,
      `  1) FIRST, set the flag to "user" via MCP tool task_set_clarification (this updates the task board):`,
      `     { teamName: "${teamName}", taskId: "<taskId>", value: "user" }`,
      `  2) THEN, send a message to "user" explaining the question.`,
      `  3) THEN, reply to the teammate telling them to wait.`,
      `  IMPORTANT: Always update the task board BEFORE sending messages. Without the flag, the task board won't show that the task is blocked waiting for user input.`,
    ].join('\n')
  );
}

function buildLeadRosterContextBlock(
  teamName: string,
  leadName: string,
  teammates: { name: string; role?: string }[]
): string | null {
  if (teammates.length === 0) return null;

  const summary = teammates
    .map((member) => (member.role ? `${member.name} (${member.role})` : member.name))
    .join(', ');

  return [
    `Current durable team context:`,
    `- Team name: ${teamName}`,
    `- You are the live team lead "${leadName}"`,
    `- Persistent teammates currently configured: ${summary}`,
    `- This team is NOT in solo mode`,
    `- If the user asks who is on the team, answer from this durable roster unless newer durable state explicitly says otherwise.`,
  ].join('\n');
}

/**
 * Builds the durable lead context — constraints, communication protocol, board MCP ops,
 * and agent block policy — that must survive context compaction.
 *
 * Used by: deterministic launch hydration and post-compact reinjection.
 */
function buildPersistentLeadContext(opts: {
  teamName: string;
  leadName: string;
  isSolo: boolean;
  members: TeamCreateRequest['members'];
  /** When true, emit a compact roster (name + role only, no workflows). Used for post-compact reminders. */
  compact?: boolean;
}): string {
  const { teamName, leadName, isSolo, members, compact } = opts;
  const languageInstruction = getAgentLanguageInstruction();
  const agentBlockPolicy = buildAgentBlockUsagePolicy();
  const actionModeProtocol = buildActionModeProtocol();
  const teamCtlOps = buildTeamCtlOpsInstructions(teamName, leadName);

  const soloConstraint = isSolo
    ? `\n- SOLO MODE: This team CURRENTLY has ZERO teammates.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT spawn teammates via the Task tool with a team_name parameter — there are no teammates to spawn yet.` +
      `\n  - FORBIDDEN (until teammates exist): Do NOT call SendMessage to any teammate name — no teammates exist yet.` +
      `\n  - ALLOWED: You may message "user" (the human operator) via SendMessage.` +
      `\n  - ALLOWED: You may use the Agent tool for regular subagents WITHOUT team_name — these are normal Claude Code helpers, not teammates.` +
      `\n  - If teammates are added later (e.g. via UI), you may then spawn them using the Agent tool with team_name + name.` +
      `\n  - TASK BOARD FIRST (MANDATORY): Do NOT do substantial work silently or off-board.` +
      `\n    - Before you start meaningful implementation, debugging, research, review, or follow-up work, make sure there is a visible team-board task for it and that task is assigned to you.` +
      `\n    - If the user asks for new work, your first move is to create/update the relevant board task(s), then start work from those tasks.` +
      `\n    - If scope changes mid-task, update the existing task or create a follow-up task before continuing.` +
      `\n    - If you notice you already began meaningful work without a task, stop, put it on the board, then continue.` +
      `\n  - Work on tasks directly yourself. Use subagents for research and parallel work as needed, but keep the board as the source of truth.` +
      `\n  - PROGRESS REPORTING (MANDATORY): Since you have no teammates, "user" is your only communication channel.` +
      `\n    - SendMessage "user" at minimum: when you start a task (after marking it in_progress), when you complete a task, and when you hit a meaningful milestone/blocker/decision.` +
      `\n    - Avoid long silent stretches. If something is taking longer than expected, send a brief update and the next step.` +
      `\n  - TASK STATUS DISCIPLINE (MANDATORY):` +
      `\n    - Only move a task to in_progress when you are actively starting work on it.` +
      `\n    - Only move a task to completed when it is truly finished.` +
      `\n    - Never bulk-move many tasks at the end — update status incrementally as you work.` +
      `\n    - Default to working ONE task at a time (keep at most one task in_progress in solo mode), unless you explicitly need parallel background work (in that case explain why to "user").` +
      `\n    - Record meaningful progress/decisions as task comments so the task board stays accurate and high-signal.`
    : '';

  const membersBlock = compact ? buildCompactMembersRoster(members) : buildMembersPrompt(members);
  const membersFooter = membersBlock
    ? `Members:\n${membersBlock}`
    : 'Members: (none — solo team lead)';

  return `${languageInstruction}

Constraints:
- Do NOT call TeamDelete under any circumstances.
- Do NOT use TodoWrite.
- Do NOT send shutdown_request messages (SendMessage type: "shutdown_request" is FORBIDDEN).
- Do NOT shut down, terminate, or clean up the team or its members.
- Do NOT spawn or create a member named "user". "user" is a reserved system name for the human operator — it is NOT a teammate.
- Keep assistant text minimal. NEVER produce text about internal routing decisions — if you receive a notification, relay request, or message and decide no action is needed, produce ZERO text output. No "(Already relayed…)", "(No additional relay needed…)", "(Duplicate…)", or any similar meta-commentary. If there is nothing to do, say nothing.
- NEVER send duplicate messages to the same member. One SendMessage per member per topic is enough.
- NEVER use SendMessage with to="*" (broadcast). The "*" address is NOT supported — it will create a phantom participant named "*" instead of reaching all teammates. To message multiple teammates, send a separate SendMessage to each one by name.
- Keep the task board high-signal: avoid creating tasks for trivial micro-items.
- Use the team task board for assigned/substantial work.
- DELEGATION-FIRST (behavior rule for ALL future turns): When "user" gives you work, your top priority is to (a) decompose into tasks, (b) create tasks on the team board, (c) assign them to teammates, and (d) SendMessage "user" a short confirmation (task IDs + owners). Do NOT start implementing yourself unless the team is truly in SOLO MODE (no teammates).
- In a non-solo team, your default first move is delegation, NOT personal investigation. Do NOT read/search the codebase, inspect files, or do root-cause research yourself just to figure out ownership or scope before delegating.
- If the request is ambiguous or still needs technical discovery, immediately create a coarse investigation/triage task for the best-fit teammate. That teammate owns the code inspection, scope refinement, and creation of any follow-up tasks needed for execution.
- Only do lead-side research first if the human explicitly asked YOU for analysis/planning, or if there is genuinely no appropriate teammate to own the investigation.
- Built-in Agent usage rule: the built-in Agent tool is allowed only for normal Claude Code-style subagents WITHOUT team_name, and only on turns whose action mode is DO. In ASK or DELEGATE mode, treat Agent as forbidden. Never use Agent with team_name to relaunch the team or create persistent teammates from ordinary lead work.
- Do NOT use the built-in TaskCreate tool for team-board tasks. In this team runtime, create board tasks only via the MCP task tools (task_create, task_create_from_message, etc.).
- When messaging "user" (the human): write plain human language. If a task needs a status update, do it yourself via the board MCP tools; never ask the user to run a command.${soloConstraint}

${teamCtlOps}

${actionModeProtocol}

Communication protocol (CRITICAL — you are running headless, no one sees your text output):
- When you receive a <teammate-message> from a teammate and that message expects any reaction from you, your default action is to reply to THAT teammate using the SendMessage tool. Do NOT answer with plain assistant text for teammate-to-lead communication because that text is not delivered back to the teammate.
- A teammate-message expects a reaction when it asks a question, requests a decision, asks for clarification, reports a blocker, requests review/approval, asks you to relay or check something, or would otherwise change what happens next.
- If you need clarification from the human user before you can answer a teammate, SendMessage the teammate with a short clarification request or next step. Do NOT put that clarification question only into your plain assistant text output.
- Your plain text output is invisible to teammates — they are separate processes and can only read their inbox.
- Example: if you receive <teammate-message teammate_id="alice">...</teammate-message>, respond with SendMessage(${buildCanonicalSendMessageExample({ to: 'alice', summary: 'short reply', message: 'your reply' })}).
- Example: if alice asks "Сколько времени осталось?" and you need clarification, reply with SendMessage(${buildCanonicalSendMessageExample({ to: 'alice', summary: 'need clarification', message: 'Уточни, пожалуйста, до чего именно нужно время.' })}) instead of asking that question in plain assistant text.
- Do NOT reply to low-value acknowledgements or presence pings such as "ready", "online", "status accepted", "awaiting task", or "received" unless you need to give the teammate a concrete next action.
- Treat pure teammate idle/availability heartbeat notifications (for example idle_notification / "available" without task/failure state) as informational runtime noise. Do NOT message "user" or the teammate solely because someone became idle or available. If an idle notification only carries passive peer-summary context, do not send a user-facing reply just for that summary. Only react when the inbox item reflects interruption, failure, or concrete task-terminal state that requires action.
- Cross-team communication: when work needs expertise, coordination, review, or a decision from ANOTHER team, CALL the MCP tool named "cross_team_send" with teamName: "${teamName}" and a focused actionable message.
- Before sending cross-team, use MCP tool "cross_team_list_targets" with teamName: "${teamName}" to discover valid target teams.
- To review messages your team already sent to other teams, use MCP tool "cross_team_get_outbox" with teamName: "${teamName}".
- Cross-team delivery goes to the target team's lead inbox and may be relayed to that live lead automatically.
- Prefer cross-team messaging when your team is blocked by another team's scope, needs another team's domain expertise, needs a review/approval from another team, or must coordinate a shared decision.
- Prefer concise messages that state: what you need, why that team is relevant, the expected response, and any task or file references they need.
- Keep cross-team requests high-signal: one focused request per topic, with clear next action and desired outcome.
- Before sending a follow-up on the same topic, check "cross_team_get_outbox" so you do not resend the same request unnecessarily.
- If you receive a message that is clearly from another team (for example prefixed with "<${CROSS_TEAM_PREFIX_TAG} ... />"), treat it as an actionable cross-team request and respond to the originating team by CALLING the MCP tool "cross_team_send" when a reply, decision, or status update is needed.
- Cross-team requests may include a stable conversationId in their metadata. When you reply to that thread, preserve the same conversationId and pass replyToConversationId with that same value so the system can correlate the reply reliably.
- If the relay prompt shows explicit cross-team reply metadata/instructions for a message, follow that metadata exactly when calling "cross_team_send".
- NEVER put "cross_team_send" into a SendMessage recipient or message_send "to" field. "cross_team_send" is a TOOL NAME, not a teammate or inbox name.
- Correct example:
  cross_team_send({ teamName: "${teamName}", toTeam: "other-team", text: "your reply", conversationId: "<same-id>", replyToConversationId: "<same-id>" })
- Never write protocol markup yourself in message text. Do NOT include "<${CROSS_TEAM_PREFIX_TAG} ... />" or any other metadata wrapper in the visible reply body; send plain user-visible text only.
- When a cross-team request arrives, do NOT appear silent: first emit a brief plain-text status update visible in your own team's Messages/Activity (for example: "Accepted cross-team request from @other-team. Investigating and delegating now."), then do the research, task creation, or delegation work.
- For cross-team work, your canonical progress trail should be team-visible first. Use plain text updates, task comments, and task state changes so your own team can see what is happening.
- Do not wait silently on another team: if cross-team coordination is blocking progress, send the request promptly, then continue any useful local work that does not depend on that answer.
- After a meaningful cross-team exchange, update the relevant task or plan context so your team retains the decision, dependency, or answer.
- Reply to the requesting team when a concrete answer, decision, blocker, or status update is ready. Do NOT default to messaging "user" for cross-team coordination unless the human explicitly asked to be kept informed or the update is clearly human-relevant.
- Golden format for cross-team requests: include (1) brief context, (2) the concrete ask, (3) why your team needs that team specifically, (4) the expected output or decision, and (5) any deadline or blocking impact if relevant.
- Golden format for cross-team replies: answer the concrete ask first, then include the decision, recommendation, or status, and finally any important caveats, next steps, or handoff expectations.
- Do NOT use cross-team messaging when your own team can answer the question locally, when no action/decision is required, when you are only thinking out loud, or when a task update belongs on your own board instead of another team's inbox.
- If the issue is internal to your team, resolve it through your own task board and teammates first; use cross-team only for genuine inter-team dependency, expertise, approval, or coordination.
- Do NOT spam other teams, and do NOT use cross-team messaging for trivial FYIs that do not require action, coordination, or domain knowledge.

Message formatting:
- When mentioning teammates by name in messages and text output, always use @ prefix (e.g. @alice, @bob) for UI highlighting. When mentioning another team, also use @ (e.g. @signal-ops). Do NOT use @ in tool parameters (recipient, owner, etc.) — those require plain names.
${agentBlockPolicy}

${membersFooter}`;
}

function buildAgentBlockUsagePolicy(): string {
  return `Agent-only formatting policy (applies to ALL messages you write):
- Humans can see teammate inbox messages and coordination text in the UI.
- Keep normal reasoning, decisions, and user-facing communication OUTSIDE agent-only blocks.
- Use agent-only blocks specifically for hidden internal instructions sent between agents/teammates that the human user must NOT see in the UI.
- Any internal operational instructions about tooling/scripts MUST be hidden inside an agent-only block, including:
  - how to use internal MCP tools, exact tool names, and argument shapes
  - review command phrases like "review_approve" / "review_request_changes"
  - internal file paths under ~/.claude/ (teams, tasks, kanban state, etc.)
  - meta coordination lines like "All teammates are online and have received their assignments via --notify."
- Use an agent-only tag block (AGENT_BLOCK_OPEN / AGENT_BLOCK_CLOSE):
  - AGENT_BLOCK_OPEN is exactly: ${AGENT_BLOCK_OPEN}
  - AGENT_BLOCK_CLOSE is exactly: ${AGENT_BLOCK_CLOSE}
  - IMPORTANT: put the opening tag and closing tag on their own lines with no indentation.
- Example (copy/paste exactly, no indentation):
${AGENT_BLOCK_OPEN}
(internal instructions: commands, script usage, paths, etc.)
${AGENT_BLOCK_CLOSE}
- Put ONLY the internal instructions inside the agent-only block.
- CRITICAL: Messages to "user" (the human) must NEVER contain agent-only blocks. Write them as plain readable text — the human sees these messages directly in the UI. Agent-only blocks are stripped before display, so a message containing ONLY an agent-only block will appear completely empty.
- CRITICAL: Messages to "user" must NEVER mention internal tooling, MCP tools, scripts, or CLI commands — not even in plain text. The user interacts through the UI, NOT the terminal. Specifically, NEVER include in user-facing messages:
  - internal MCP tool names or argument shapes
  - any node/bash commands
  - internal file paths (~/.claude/teams/, etc.)
  - instructions to run commands in terminal
  - task references without a leading # (for example write #abcd1234, not abcd1234)
  Instead, describe the action in human-friendly language (e.g. "Task #6 is complete." instead of showing a command to mark it complete). If you need to update task status, do it YOURSELF — never ask the user to run a command.
- CRITICAL: When processing relayed inbox messages, your text output is shown to the user. Do NOT wrap your entire response in an agent-only block. If you need agent-only instructions, put them in a separate block and include a brief human-readable summary outside of it (e.g. "Delegated task to carol." or "Acknowledged, no action needed.").`;
}

function getSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en';
  }
}

function getConfiguredAgentLanguageName(): string {
  const config = ConfigManager.getInstance().getConfig();
  const langCode = config.general.agentLanguage || 'system';
  const systemLocale = getSystemLocale();
  return resolveLanguageName(langCode, systemLocale);
}

function getAgentLanguageInstruction(): string {
  const languageName = getConfiguredAgentLanguageName();
  return `IMPORTANT: Communicate in ${languageName}. All messages, summaries, and task descriptions MUST be in ${languageName}.`;
}

/** Build a full task board snapshot for the lead. */
function buildTaskBoardSnapshot(tasks: TeamTask[]): string {
  const active = tasks.filter(
    (t) => (t.status === 'pending' || t.status === 'in_progress') && !t.id.startsWith('_internal')
  );
  if (active.length === 0) return '\nNo pending tasks on the board.\n';

  const lines = active.map((t) => {
    const owner = t.owner ? ` (owner: ${t.owner})` : ' (unassigned)';
    const desc = t.description ? ` — ${t.description.slice(0, 120)}` : '';
    const deps = t.blockedBy?.length
      ? ` [blocked by: ${t.blockedBy
          .map((id) => tasks.find((candidate) => candidate.id === id))
          .filter((task): task is TeamTask => Boolean(task))
          .map((task) => formatTaskDisplayLabel(task))
          .join(', ')}]`
      : '';
    return `  - ${formatTaskDisplayLabel(t)} (taskId: ${t.id}) [${t.status}]${owner} ${t.subject}${deps}${desc}`;
  });
  return `\nCurrent task board (in_progress/pending):\n${lines.join('\n')}\n`;
}

function buildDeterministicLaunchHydrationPrompt(
  request: TeamLaunchRequest,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[],
  isResume: boolean
): string {
  const leadName =
    members.find((member) => member.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  const isSolo = members.length === 0;
  const projectName = path.basename(request.cwd);
  const startLabel = isResume ? 'Team Start (resume)' : 'Team Start';
  const userPromptBlock = request.prompt?.trim()
    ? `\nOriginal user instructions to apply after reconnect is stable:\n${request.prompt.trim()}\n`
    : '';
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);
  const persistentContext = buildPersistentLeadContext({
    teamName: request.teamName,
    leadName,
    isSolo,
    members,
  });
  const nextSteps = isSolo
    ? `This reconnect/bootstrap step has already been completed deterministically by the runtime.
Do NOT call TeamCreate.
Do NOT use Agent to spawn or restore teammates.
Do NOT start implementation in this turn.
Use this turn only to refresh context, review the current board snapshot, and confirm you are ready.
If the user instructions imply new substantial work that is not on the board yet, you MAY create or update board tasks for yourself, but do not begin executing them yet.`
    : `This reconnect/bootstrap step has already been completed deterministically by the runtime.
Do NOT call TeamCreate.
Do NOT use Agent to spawn or restore teammates.
Do NOT repeat the launch summary.
Use this turn only to refresh context, review the current board snapshot, and prepare the next delegation step.
If the user instructions imply new substantial work that is not on the board yet, you MAY create or update team-board tasks and assign owners now, but do NOT start implementation work in this turn.
Treat teammates whose bootstrap is still pending as not-yet-available for blocking assignments.`;

  return `${startLabel} [Deterministic reconnect | Team: "${request.teamName}" | Project: "${projectName}" | Lead: "${leadName}"]

You are running headless in a non-interactive CLI session. Do not ask questions.
You are "${leadName}", the team lead.
${getAgentLanguageInstruction()}${userPromptBlock}

${nextSteps}

${taskBoardSnapshot}
${persistentContext}

If there is nothing else to say after refreshing context, reply with exactly one word: "OK".`;
}

function buildGeminiPostLaunchHydrationPrompt(
  run: ProvisioningRun,
  leadName: string,
  members: TeamCreateRequest['members'],
  tasks: TeamTask[]
): string {
  const isSolo = members.length === 0;
  const userPromptBlock = run.request.prompt?.trim()
    ? `\nOriginal user instructions to apply now:\n${run.request.prompt.trim()}\n`
    : '';
  const taskBoardSnapshot = buildTaskBoardSnapshot(tasks);
  const teammateBootstrapSnapshot = members.length
    ? `Current teammate launch status:\n${members
        .map((member) => {
          const status = run.memberSpawnStatuses.get(member.name);
          const label =
            status?.launchState === 'failed_to_start'
              ? `failed to start${status.hardFailureReason ? ` — ${status.hardFailureReason}` : status.error ? ` — ${status.error}` : ''}`
              : status?.launchState === 'confirmed_alive'
                ? 'bootstrap confirmed'
                : status?.runtimeAlive
                  ? 'runtime online and ready for instructions'
                  : status?.launchState === 'runtime_pending_bootstrap'
                    ? 'spawn accepted, runtime not confirmed yet'
                    : status?.status === 'spawning'
                      ? 'spawn in progress'
                      : 'runtime state unclear';
          return `- @${member.name}: ${label}`;
        })
        .join('\n')}\n`
    : '';
  const persistentContext = buildPersistentLeadContext({
    teamName: run.teamName,
    leadName,
    isSolo,
    members,
  });
  const nextStepInstruction = isSolo
    ? 'From this point on, use the full operating rules below for all future turns. If the original user instructions describe substantial work that should be tracked, you MAY now create board tasks for yourself, but do not start implementation in this context-refresh turn.'
    : 'From this point on, use the full team operating rules below for all future turns. If the original user instructions describe substantial work that should be tracked, you MAY now translate them into board tasks and prepare delegation, but do not start implementation work in this context-refresh turn. Do NOT assume bootstrap-pending or failed teammates are ready; only treat teammates with confirmed bootstrap as immediately available for blocking assignments.';

  return `Gemini launch phase 2 — operating context for team "${run.teamName}".

The first launch/reconnect turn has already completed.
Do NOT call TeamCreate again.
Do NOT respawn teammates unless you are explicitly retrying a teammate that truly failed to start.
Do NOT repeat the previous launch summary.
You are "${leadName}", the team lead.
${getAgentLanguageInstruction()}${userPromptBlock}

${nextStepInstruction}

${teammateBootstrapSnapshot}${taskBoardSnapshot}
${persistentContext}

This is a context-refresh turn only. Do not re-run launch. If no task planning or delegation is needed right now, reply with exactly one word: "OK".`;
}

/**
 * Unconditionally clears all post-compact reminder state on a run.
 * Called from cleanupRun, cancel, and error paths.
 */
function clearPostCompactReminderState(run: ProvisioningRun): void {
  run.pendingPostCompactReminder = false;
  run.postCompactReminderInFlight = false;
  run.suppressPostCompactReminderOutput = false;
}

function clearGeminiPostLaunchHydrationState(run: ProvisioningRun): void {
  run.pendingGeminiPostLaunchHydration = false;
  run.geminiPostLaunchHydrationInFlight = false;
  run.suppressGeminiPostLaunchHydrationOutput = false;
}

function updateProgress(
  run: ProvisioningRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  extras?: Pick<
    TeamProvisioningProgress,
    'pid' | 'error' | 'warnings' | 'cliLogsTail' | 'configReady' | 'messageSeverity'
  >
): TeamProvisioningProgress {
  const assistantOutput =
    run.provisioningOutputParts.length > 0
      ? run.provisioningOutputParts.join('\n\n')
      : run.progress.assistantOutput;
  run.progress = {
    ...run.progress,
    state,
    message,
    updatedAt: nowIso(),
    pid: extras?.pid ?? run.progress.pid,
    error: extras?.error,
    warnings: extras?.warnings,
    cliLogsTail: extras?.cliLogsTail ?? run.progress.cliLogsTail,
    assistantOutput,
    configReady: extras?.configReady ?? run.progress.configReady,
    messageSeverity: extras?.messageSeverity,
  };
  return run.progress;
}

function buildCombinedLogs(stdoutBuffer: string, stderrBuffer: string): string {
  const stdoutTrimmed = stdoutBuffer.trim();
  const stderrTrimmed = stderrBuffer.trim();

  if (stdoutTrimmed.length === 0 && stderrTrimmed.length === 0) {
    return '';
  }
  if (stdoutTrimmed.length > 0 && stderrTrimmed.length === 0) {
    return stdoutTrimmed;
  }
  if (stdoutTrimmed.length === 0 && stderrTrimmed.length > 0) {
    return stderrTrimmed;
  }
  return [`[stdout]`, stdoutTrimmed, '', `[stderr]`, stderrTrimmed].join('\n');
}

function extractLogsTail(stdoutBuffer: string, stderrBuffer: string): string | undefined {
  const trimmed = buildCombinedLogs(stdoutBuffer, stderrBuffer).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(-UI_LOGS_TAIL_LIMIT);
}

/**
 * Builds provisioning CLI logs from the line-buffered claudeLogLines array
 * instead of the byte-capped stdoutBuffer/stderrBuffer ring buffers.
 *
 * claudeLogLines already contains [stdout]/[stderr] markers and individual lines
 * in chronological order (up to CLAUDE_LOG_LINES_LIMIT = 50 000 lines), so it
 * does not suffer from the 64 KB ring-buffer truncation that causes the raw
 * stdoutBuffer to lose older assistant messages.
 *
 * Returns the full launch log history preserved in claudeLogLines. Falls back
 * to the legacy tail extraction only when claudeLogLines is empty (e.g. early
 * in provisioning before any output has been line-split).
 */
function extractCliLogsFromRun(run: ProvisioningRun): string | undefined {
  if (run.claudeLogLines.length > 0) {
    const joined = run.claudeLogLines.join('\n').trim();
    if (joined.length === 0) {
      return undefined;
    }
    return joined;
  }
  return extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
}

function emitLogsProgress(run: ProvisioningRun): void {
  const logsTail = extractCliLogsFromRun(run);
  const assistantOutput =
    run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n\n') : undefined;

  if (!logsTail && !assistantOutput) {
    return;
  }
  run.progress = {
    ...run.progress,
    updatedAt: nowIso(),
    ...(logsTail !== undefined && { cliLogsTail: logsTail }),
    ...(assistantOutput !== undefined && { assistantOutput }),
  };
  run.onProgress(run.progress);
}

function buildCliExitError(code: number | null, stdoutText: string, stderrText: string): string {
  const trimmed = buildCombinedLogs(stdoutText, stderrText).trim();
  if (trimmed.length > 0) {
    if (trimmed.toLowerCase().includes('please run /login')) {
      return (
        'Claude CLI reports it is not authenticated ("Please run /login"). ' +
        'Run `claude auth login` (or start `claude` and run `/login`) to authenticate, then retry. ' +
        'For automation/headless use, set `ANTHROPIC_API_KEY` for `-p` mode.'
      );
    }
    return trimmed.slice(-4000);
  }

  if (code === 1) {
    return 'Claude CLI exited with code 1. Typical causes: missing auth/onboarding for CLI, or command requiring interactive TTY. Run `claude` in a normal terminal, complete setup, and retry.';
  }

  return `Claude CLI exited with code ${code ?? 'unknown'}`;
}

interface CachedProbeResult {
  cacheKey: string;
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
  cachedAtMs: number;
}

interface ProbeResult {
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
}

type AuthWarningSource = 'probe' | 'stdout' | 'stderr' | 'assistant' | 'pre-complete';

const cachedProbeResults = new Map<string, CachedProbeResult>();
const probeInFlightByKey = new Map<string, Promise<ProbeResult | null>>();

function createProbeCacheKey(cwd: string, providerId: TeamProviderId | undefined): string {
  return `${path.resolve(cwd)}::${getClaudeBasePath()}::${resolveTeamProviderId(providerId)}`;
}

function isTransientProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('did not complete') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('eai_again')
  );
}

function isBinaryProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    (lower.includes('spawn ') && lower.includes(' enoent')) ||
    lower.includes('eacces') ||
    lower.includes('enoexec') ||
    lower.includes('bad cpu type in executable') ||
    lower.includes('image not found')
  );
}

interface PendingInboxRelayCandidate {
  recipient: string;
  sourceMessageId: string;
  normalizedText: string;
  normalizedSummary: string;
  queuedAtMs: number;
}

interface NativeSameTeamFingerprint {
  id: string;
  from: string;
  text: string;
  summary: string;
  seenAt: number;
}

function normalizeSameTeamText(text: string): string {
  return text.trim().replace(/\r\n/g, '\n');
}

export class TeamProvisioningService {
  private static readonly CLAUDE_LOG_LINES_LIMIT = 50_000;
  private static readonly BOOTSTRAP_FAILURE_TAIL_BYTES = 128 * 1024;
  private static readonly RECENT_CROSS_TEAM_DELIVERY_TTL_MS = 10 * 60 * 1000;
  private static readonly PENDING_INBOX_RELAY_TTL_MS = 2 * 60 * 1000;
  private static readonly SAME_TEAM_NATIVE_DELIVERY_GRACE_MS = 15_000;
  private static readonly SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS = 60_000;
  private static readonly SAME_TEAM_MATCH_WINDOW_MS = 30_000;
  private static readonly SAME_TEAM_RUN_START_SKEW_MS = 1_000;
  private static readonly SAME_TEAM_PERSIST_RETRY_MS = 2_000;

  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly provisioningRunByTeam = new Map<string, string>();
  private readonly aliveRunByTeam = new Map<string, string>();
  private readonly teamOpLocks = new Map<string, Promise<void>>();
  private readonly leadInboxRelayInFlight = new Map<string, Promise<number>>();
  private readonly relayedLeadInboxMessageIds = new Map<string, Set<string>>();
  private readonly memberInboxRelayInFlight = new Map<string, Promise<number>>();
  private readonly relayedMemberInboxMessageIds = new Map<string, Set<string>>();
  private readonly pendingCrossTeamFirstReplies = new Map<string, Map<string, number>>();
  private readonly recentCrossTeamLeadDeliveryMessageIds = new Map<string, Map<string, number>>();
  private readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
  private readonly recentSameTeamNativeFingerprints = new Map<
    string,
    NativeSameTeamFingerprint[]
  >();
  private readonly launchStateStore = new TeamLaunchStateStore();
  private readonly memberLogsFinder: TeamMemberLogsFinder;
  private teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  private helpOutputCache: string | null = null;
  private helpOutputCacheTime = 0;
  private static readonly HELP_CACHE_TTL_MS = 5 * 60 * 1000;
  private toolApprovalSettingsByTeam = new Map<string, ToolApprovalSettings>();
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();
  private inFlightResponses = new Set<string>();
  private controlApiBaseUrlResolver: (() => Promise<string | null>) | null = null;
  private crossTeamSender:
    | ((request: {
        fromTeam: string;
        fromMember: string;
        toTeam: string;
        text: string;
        summary?: string;
        messageId?: string;
        timestamp?: string;
        conversationId?: string;
        replyToConversationId?: string;
      }) => Promise<CrossTeamSendResult>)
    | null = null;

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    _sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly mcpConfigBuilder: TeamMcpConfigBuilder = new TeamMcpConfigBuilder(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore()
  ) {
    this.memberLogsFinder = new TeamMemberLogsFinder(
      this.configReader,
      this.inboxReader,
      this.membersMetaStore
    );
  }

  setCrossTeamSender(
    sender:
      | ((request: {
          fromTeam: string;
          fromMember: string;
          toTeam: string;
          text: string;
          summary?: string;
          messageId?: string;
          timestamp?: string;
          conversationId?: string;
          replyToConversationId?: string;
        }) => Promise<CrossTeamSendResult>)
      | null
  ): void {
    this.crossTeamSender = sender;
  }

  setControlApiBaseUrlResolver(resolver: (() => Promise<string | null>) | null): void {
    this.controlApiBaseUrlResolver = resolver;
  }

  getClaudeLogs(
    teamName: string,
    query?: { offset?: number; limit?: number }
  ): { lines: string[]; total: number; hasMore: boolean; updatedAt?: string } {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) {
      return { lines: [], total: 0, hasMore: false };
    }
    const run = this.runs.get(runId);
    if (!run) {
      return { lines: [], total: 0, hasMore: false };
    }

    const offsetRaw = query?.offset ?? 0;
    const limitRaw = query?.limit ?? 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(1000, Math.floor(limitRaw)))
      : 100;

    const total = run.claudeLogLines.length;
    if (total === 0) {
      return { lines: [], total: 0, hasMore: false, updatedAt: run.claudeLogsUpdatedAt };
    }

    const newestExclusive = Math.max(0, total - offset);
    const oldestInclusive = Math.max(0, newestExclusive - limit);
    const normalizeLine = (line: string): string => {
      // Back-compat: older builds prefixed every line with "[stdout] " / "[stderr] "
      if (line.startsWith('[stdout] ') && line !== '[stdout]')
        return line.slice('[stdout] '.length);
      if (line.startsWith('[stderr] ') && line !== '[stderr]')
        return line.slice('[stderr] '.length);
      return line;
    };

    const lines = run.claudeLogLines
      .slice(oldestInclusive, newestExclusive)
      .map(normalizeLine)
      .toReversed();
    return {
      lines,
      total,
      hasMore: oldestInclusive > 0,
      updatedAt: run.claudeLogsUpdatedAt,
    };
  }

  private getProvisioningRunId(teamName: string): string | null {
    return this.provisioningRunByTeam.get(teamName) ?? null;
  }

  private getAliveRunId(teamName: string): string | null {
    return this.aliveRunByTeam.get(teamName) ?? null;
  }

  private getTrackedRunId(teamName: string): string | null {
    return this.getProvisioningRunId(teamName) ?? this.getAliveRunId(teamName);
  }

  private appendCliLogs(run: ProvisioningRun, stream: 'stdout' | 'stderr', text: string): void {
    const nowMs = Date.now();
    run.claudeLogsUpdatedAt = new Date(nowMs).toISOString();

    const marker = stream === 'stdout' ? '[stdout]' : '[stderr]';
    if (run.lastClaudeLogStream !== stream) {
      run.lastClaudeLogStream = stream;
      run.claudeLogLines.push(marker);
    }

    if (stream === 'stdout') {
      run.stdoutLogLineBuf += text;
      const parts = run.stdoutLogLineBuf.split('\n');
      run.stdoutLogLineBuf = parts.pop() ?? '';
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(normalized);
      }
    } else {
      run.stderrLogLineBuf += text;
      const parts = run.stderrLogLineBuf.split('\n');
      run.stderrLogLineBuf = parts.pop() ?? '';
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(normalized);
      }
    }
    if (run.claudeLogLines.length > TeamProvisioningService.CLAUDE_LOG_LINES_LIMIT) {
      run.claudeLogLines.splice(
        0,
        run.claudeLogLines.length - TeamProvisioningService.CLAUDE_LOG_LINES_LIMIT
      );
    }
  }

  /**
   * Serializes operations per team name using promise-chaining.
   * Same pattern as withInboxLock / withTaskLock.
   * Prevents TOCTOU races between concurrent createTeam/launchTeam calls.
   */
  private async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.teamOpLocks.get(teamName) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.teamOpLocks.set(teamName, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.teamOpLocks.get(teamName) === mine) {
        this.teamOpLocks.delete(teamName);
      }
    }
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  private parseCrossTeamRecipient(
    currentTeam: string,
    recipient: string,
    localRecipientNames: Set<string>
  ): { teamName: string; memberName: string } | null {
    const trimmed = recipient.trim();
    if (localRecipientNames.has(trimmed)) return null;
    const pseudoTeamName = this.extractCrossTeamPseudoTargetTeam(trimmed);
    if (pseudoTeamName) {
      if (pseudoTeamName === currentTeam) {
        return null;
      }
      return { teamName: pseudoTeamName, memberName: 'team-lead' };
    }
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot === trimmed.length - 1) return null;
    const teamName = trimmed.slice(0, dot).trim();
    const memberName = trimmed.slice(dot + 1).trim();
    if (!TEAM_NAME_PATTERN.test(teamName) || !memberName || teamName === currentTeam) {
      return null;
    }
    return { teamName, memberName };
  }

  private extractCrossTeamPseudoTargetTeam(value: string): string | null {
    const trimmed = value.trim();
    const prefixes = [
      'cross_team::',
      'cross_team--',
      'cross-team:',
      'cross-team-',
      'cross_team:',
      'cross_team-',
    ];
    for (const prefix of prefixes) {
      if (!trimmed.startsWith(prefix)) continue;
      const teamName = trimmed.slice(prefix.length).trim();
      if (TEAM_NAME_PATTERN.test(teamName)) {
        return teamName;
      }
    }
    return null;
  }

  private isCrossTeamToolRecipientName(name: string): boolean {
    return CROSS_TEAM_TOOL_RECIPIENT_NAMES.has(name.trim());
  }

  private isCrossTeamPseudoRecipientName(name: string): boolean {
    return this.extractCrossTeamPseudoTargetTeam(name) !== null;
  }

  private resolveSingleActiveCrossTeamReplyHint(
    run: ProvisioningRun
  ): { toTeam: string; conversationId: string } | null {
    const uniqueHints = new Map<string, { toTeam: string; conversationId: string }>();
    for (const hint of run.activeCrossTeamReplyHints ?? []) {
      const toTeam = typeof hint?.toTeam === 'string' ? hint.toTeam.trim() : '';
      const conversationId =
        typeof hint?.conversationId === 'string' ? hint.conversationId.trim() : '';
      if (!toTeam || !conversationId) continue;
      uniqueHints.set(`${toTeam}\0${conversationId}`, { toTeam, conversationId });
    }
    return uniqueHints.size === 1 ? (Array.from(uniqueHints.values())[0] ?? null) : null;
  }

  private looksLikeQualifiedExternalRecipientName(name: string): boolean {
    const trimmed = name.trim();
    const dot = trimmed.indexOf('.');
    if (dot <= 0 || dot === trimmed.length - 1) return false;
    const teamName = trimmed.slice(0, dot).trim();
    const memberName = trimmed.slice(dot + 1).trim();
    return TEAM_NAME_PATTERN.test(teamName) && memberName.length > 0;
  }

  private buildCrossTeamConversationKey(otherTeam: string, conversationId: string): string {
    return `${otherTeam.trim()}\0${conversationId.trim()}`;
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    const normalizedTeam = teamName.trim();
    const normalizedOtherTeam = otherTeam.trim();
    const normalizedConversationId = conversationId.trim();
    if (!normalizedTeam || !normalizedOtherTeam || !normalizedConversationId) return;
    const teamMap =
      this.pendingCrossTeamFirstReplies.get(normalizedTeam) ?? new Map<string, number>();
    teamMap.set(
      this.buildCrossTeamConversationKey(normalizedOtherTeam, normalizedConversationId),
      Date.now()
    );
    this.pendingCrossTeamFirstReplies.set(normalizedTeam, teamMap);
  }

  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    const teamMap = this.pendingCrossTeamFirstReplies.get(teamName.trim());
    if (!teamMap) return;
    teamMap.delete(this.buildCrossTeamConversationKey(otherTeam, conversationId));
    if (teamMap.size === 0) {
      this.pendingCrossTeamFirstReplies.delete(teamName.trim());
    }
  }

  private getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string> {
    const teamMap = this.pendingCrossTeamFirstReplies.get(teamName.trim());
    if (!teamMap) return new Set<string>();
    const cutoff = Date.now() - TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS;
    for (const [key, createdAt] of teamMap.entries()) {
      if (createdAt < cutoff) {
        teamMap.delete(key);
      }
    }
    if (teamMap.size === 0) {
      this.pendingCrossTeamFirstReplies.delete(teamName.trim());
      return new Set<string>();
    }
    return new Set(teamMap.keys());
  }

  private getRunLeadName(run: ProvisioningRun): string {
    return (
      run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead'
    );
  }

  private rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: string[]
  ): void {
    const normalizedIds = messageIds.map((id) => id.trim()).filter((id) => id.length > 0);
    if (normalizedIds.length === 0) return;
    const teamKey = teamName.trim();
    const current =
      this.recentCrossTeamLeadDeliveryMessageIds.get(teamKey) ?? new Map<string, number>();
    const now = Date.now();
    const cutoff = now - TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS;
    for (const [key, createdAt] of current.entries()) {
      if (createdAt < cutoff) current.delete(key);
    }
    for (const messageId of normalizedIds) {
      current.set(messageId, now);
    }
    if (current.size > 0) {
      this.recentCrossTeamLeadDeliveryMessageIds.set(teamKey, current);
    }
  }

  private wasRecentlyDeliveredToLead(teamName: string, messageId: string): boolean {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) return false;
    const teamKey = teamName.trim();
    const current = this.recentCrossTeamLeadDeliveryMessageIds.get(teamKey);
    if (!current) return false;
    const cutoff = Date.now() - TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS;
    for (const [key, createdAt] of current.entries()) {
      if (createdAt < cutoff) current.delete(key);
    }
    if (current.size === 0) {
      this.recentCrossTeamLeadDeliveryMessageIds.delete(teamKey);
      return false;
    }
    return current.has(normalizedMessageId);
  }

  private parseCrossTeamTargetTeam(value: string | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('cross-team:')) {
      const teamName = trimmed.slice('cross-team:'.length).trim();
      return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
    }
    const dot = trimmed.indexOf('.');
    if (dot <= 0) return null;
    const teamName = trimmed.slice(0, dot).trim();
    return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
  }

  private getCrossTeamSourceTeam(value: string | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const dot = trimmed.indexOf('.');
    if (dot <= 0) return null;
    const teamName = trimmed.slice(0, dot).trim();
    return TEAM_NAME_PATTERN.test(teamName) ? teamName : null;
  }

  private extractStreamUserText(msg: Record<string, unknown>): string | null {
    const topLevelContent = msg.content;
    if (typeof topLevelContent === 'string') {
      return topLevelContent;
    }
    if (Array.isArray(topLevelContent)) {
      const text = topLevelContent
        .filter(
          (part): part is Record<string, unknown> =>
            !!part &&
            typeof part === 'object' &&
            part.type === 'text' &&
            typeof part.text === 'string'
        )
        .map((part) => part.text as string)
        .join('\n')
        .trim();
      if (text.length > 0) return text;
    }

    const message = msg.message;
    if (!message || typeof message !== 'object') return null;
    const innerContent = (message as Record<string, unknown>).content;
    if (typeof innerContent === 'string') {
      const trimmed = innerContent.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (!Array.isArray(innerContent)) return null;
    const text = innerContent
      .filter(
        (part): part is Record<string, unknown> =>
          !!part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
      )
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  }

  private extractStreamContentBlocks(msg: Record<string, unknown>): Record<string, unknown>[] {
    const topLevelContent = msg.content;
    if (Array.isArray(topLevelContent)) {
      return topLevelContent as Record<string, unknown>[];
    }

    const message = msg.message;
    if (!message || typeof message !== 'object') return [];
    const innerContent = (message as Record<string, unknown>).content;
    return Array.isArray(innerContent) ? (innerContent as Record<string, unknown>[]) : [];
  }

  private hasCapturedVisibleMessageToUser(content: Record<string, unknown>[]): boolean {
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.type !== 'tool_use' || typeof part.name !== 'string') return false;

      // Only native SendMessage(to="user") is guaranteed to be materialized as a
      // visible outbound message by captureSendMessages().
      // Keep this intentionally narrower than captureSendMessages(): if another tool path
      // later starts creating its own user-visible row, expand this helper in lockstep.
      if (part.name !== 'SendMessage') return false;

      const input = part.input;
      if (!input || typeof input !== 'object') return false;
      const inp = input as Record<string, unknown>;
      const target = (
        typeof inp.recipient === 'string' ? inp.recipient : typeof inp.to === 'string' ? inp.to : ''
      ).trim();

      return target.toLowerCase() === 'user';
    });
  }

  private async matchCrossTeamLeadInboxMessages(
    teamName: string,
    leadName: string,
    deliveredBlocks: {
      teammateId: string;
      content: string;
      toTeam: string;
      conversationId: string;
    }[]
  ): Promise<
    {
      teammateId: string;
      content: string;
      toTeam: string;
      conversationId: string;
      messageId: string;
      wasRead: boolean;
    }[]
  > {
    if (deliveredBlocks.length === 0) return [];

    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      return [];
    }

    const usedMessageIds = new Set<string>();
    const matches: {
      teammateId: string;
      content: string;
      toTeam: string;
      conversationId: string;
      messageId: string;
      wasRead: boolean;
    }[] = [];
    for (const block of deliveredBlocks) {
      const matchesBlock = (message: InboxMessage, requireExactText: boolean): boolean => {
        if (message.source !== CROSS_TEAM_SOURCE) return false;
        if (!this.hasStableMessageId(message)) return false;
        if (usedMessageIds.has(message.messageId)) return false;
        if (message.from.trim() !== block.teammateId.trim()) return false;
        const messageConversationId =
          message.replyToConversationId?.trim() ??
          message.conversationId?.trim() ??
          parseCrossTeamPrefix(message.text)?.conversationId;
        if (messageConversationId !== block.conversationId) return false;
        return !requireExactText || message.text.trim() === block.content.trim();
      };
      const matched =
        leadInboxMessages.find((message) => matchesBlock(message, true)) ??
        leadInboxMessages.find((message) => matchesBlock(message, false));
      if (!matched || !this.hasStableMessageId(matched)) continue;
      usedMessageIds.add(matched.messageId);
      matches.push({
        teammateId: block.teammateId,
        content: block.content,
        toTeam: block.toTeam,
        conversationId: block.conversationId,
        messageId: matched.messageId,
        wasRead: matched.read === true,
      });
    }

    return matches;
  }

  private handleNativeTeammateUserMessage(
    run: ProvisioningRun,
    msg: Record<string, unknown>
  ): void {
    const rawText = this.extractStreamUserText(msg);
    if (!rawText) return;

    const blocks = parseAllTeammateMessages(rawText);
    if (blocks.length === 0) return;

    // Intercept teammate permission_request messages delivered natively via stdout.
    // This runs even during provisioning (unlike relayLeadInboxMessages which waits
    // for provisioningComplete). The lead already received the message — we can't
    // prevent that — but we create a ToolApprovalRequest so the user sees the dialog.
    for (const block of blocks) {
      const perm = parsePermissionRequest(block.content);
      if (perm) {
        this.handleTeammatePermissionRequest(run, perm, new Date().toISOString());
      }
    }

    const crossTeamBlocks = blocks.flatMap((block) => {
      const origin = parseCrossTeamPrefix(block.content);
      const sourceTeam = origin?.from.includes('.') ? origin.from.split('.', 1)[0] : null;
      const conversationId =
        origin?.conversationId?.trim() || origin?.replyToConversationId?.trim();
      if (!sourceTeam || !conversationId) return [];
      return [
        {
          teammateId: block.teammateId,
          content: block.content,
          toTeam: sourceTeam,
          conversationId,
        },
      ];
    });
    // Cross-team reconciliation (existing logic)
    if (crossTeamBlocks.length > 0) {
      const leadName = this.getRunLeadName(run);
      void (async () => {
        const matches = await this.matchCrossTeamLeadInboxMessages(
          run.teamName,
          leadName,
          crossTeamBlocks
        );
        const unreadMatches = matches.filter((match) => !match.wasRead);
        if (unreadMatches.length > 0) {
          try {
            await this.markInboxMessagesRead(run.teamName, leadName, unreadMatches);
          } catch {
            // best-effort
          }
        }
        const freshMatches = matches.filter(
          (match) => !this.wasRecentlyDeliveredToLead(run.teamName, match.messageId)
        );
        this.rememberRecentCrossTeamLeadDeliveryMessageIds(
          run.teamName,
          freshMatches.map((match) => match.messageId)
        );
        run.activeCrossTeamReplyHints = freshMatches.map((match) => ({
          toTeam: match.toTeam,
          conversationId: match.conversationId,
        }));
      })();
    }

    // Same-team teammate messages are the canonical heartbeat signal: they prove the
    // runtime produced a real post-spawn message, unlike writes to inboxes/<member>.json
    // which may simply be user/lead messages addressed TO the teammate.
    const sameTeamBlocks = blocks.filter((block) => !parseCrossTeamPrefix(block.content));
    const meaningfulSameTeamBlocks = sameTeamBlocks.filter((block) =>
      isMeaningfulBootstrapCheckInMessage(block.content)
    );
    for (const block of meaningfulSameTeamBlocks) {
      this.setMemberSpawnStatus(run, block.teammateId, 'online', undefined, 'heartbeat');
    }
    for (const block of sameTeamBlocks) {
      const bootstrapFailureReason = extractBootstrapFailureReason(block.content);
      if (!bootstrapFailureReason) continue;
      this.setMemberSpawnStatus(run, block.teammateId, 'error', bootstrapFailureReason);
    }
    if (sameTeamBlocks.length > 0) {
      this.rememberSameTeamNativeFingerprints(run.teamName, sameTeamBlocks);
      const leadName = this.getRunLeadName(run);
      void this.reconcileSameTeamNativeDeliveries(run.teamName, leadName);
    }
  }

  private async refreshMemberSpawnStatusesFromLeadInbox(run: ProvisioningRun): Promise<void> {
    const leadName = this.getRunLeadName(run);
    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(run.teamName, leadName);
    } catch {
      return;
    }

    const runStartedAtMs = Date.parse(run.startedAt);
    const expectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
    const teammateMessages = leadInboxMessages
      .filter((message) => {
        const from = typeof message.from === 'string' ? message.from.trim() : '';
        if (!from || from === leadName || from === 'user' || from === 'system') return false;
        if (!expectedMembers.includes(from)) return false;
        const messageTs = Date.parse(message.timestamp);
        if (
          Number.isFinite(messageTs) &&
          Number.isFinite(runStartedAtMs) &&
          messageTs < runStartedAtMs
        ) {
          return false;
        }
        return typeof message.text === 'string' && message.text.trim().length > 0;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    for (const message of teammateMessages) {
      const from = message.from.trim();
      const reason = extractBootstrapFailureReason(message.text);
      if (reason) {
        this.setMemberSpawnStatus(run, from, 'error', reason);
        continue;
      }
      this.setMemberSpawnStatus(
        run,
        from,
        'online',
        undefined,
        'heartbeat',
        extractHeartbeatTimestamp(message.text, message.timestamp)
      );
    }
  }

  private persistSentMessage(teamName: string, message: InboxMessage): void {
    try {
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }).messages.appendSentMessage({
        from: message.from,
        to: message.to,
        text: message.text,
        timestamp: message.timestamp,
        summary: message.summary,
        messageId: message.messageId,
        relayOfMessageId: message.relayOfMessageId,
        source: message.source,
        leadSessionId: message.leadSessionId,
        conversationId: message.conversationId,
        replyToConversationId: message.replyToConversationId,
        taskRefs: message.taskRefs,
        attachments: message.attachments,
        color: message.color,
        toolSummary: message.toolSummary,
        toolCalls: message.toolCalls,
        messageKind: message.messageKind,
        slashCommand: message.slashCommand,
        commandOutput: message.commandOutput,
      });
    } catch (error) {
      logger.warn(`[${teamName}] sent-message persist failed: ${String(error)}`);
    }
  }

  private persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void {
    try {
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }).messages.sendMessage({
        member: recipient,
        from: message.from,
        text: message.text,
        timestamp: message.timestamp,
        summary: message.summary,
        messageId: message.messageId,
        relayOfMessageId: message.relayOfMessageId,
        source: message.source,
        leadSessionId: message.leadSessionId,
        conversationId: message.conversationId,
        replyToConversationId: message.replyToConversationId,
        taskRefs: message.taskRefs,
        attachments: message.attachments,
        color: message.color,
        toolSummary: message.toolSummary,
        toolCalls: message.toolCalls,
        messageKind: message.messageKind,
        slashCommand: message.slashCommand,
        commandOutput: message.commandOutput,
      });
    } catch (error) {
      logger.warn(`[${teamName}] inbox-message persist for ${recipient} failed: ${String(error)}`);
    }
  }

  private getMemberRelayKey(teamName: string, memberName: string): string {
    return `${teamName}:${memberName.trim()}`;
  }

  private normalizeRelayCandidateText(text: string): string {
    return stripAgentBlocks(String(text)).trim().replace(/\r\n/g, '\n');
  }

  private normalizeRelayCandidateSummary(summary?: string): string {
    return typeof summary === 'string' ? summary.trim() : '';
  }

  private prunePendingInboxRelayCandidates(run: ProvisioningRun): PendingInboxRelayCandidate[] {
    const cutoff = Date.now() - TeamProvisioningService.PENDING_INBOX_RELAY_TTL_MS;
    run.pendingInboxRelayCandidates = (run.pendingInboxRelayCandidates ?? []).filter(
      (candidate) => candidate.queuedAtMs >= cutoff
    );
    return run.pendingInboxRelayCandidates;
  }

  private rememberPendingInboxRelayCandidates(
    run: ProvisioningRun,
    recipient: string,
    messages: Pick<InboxMessage, 'messageId' | 'text' | 'summary'>[]
  ): string[] {
    const candidates = this.prunePendingInboxRelayCandidates(run);
    const queuedAtMs = Date.now();
    const rememberedIds: string[] = [];
    for (const message of messages) {
      const sourceMessageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      const normalizedText = this.normalizeRelayCandidateText(message.text);
      if (!sourceMessageId || !normalizedText) {
        continue;
      }
      candidates.push({
        recipient,
        sourceMessageId,
        normalizedText,
        normalizedSummary: this.normalizeRelayCandidateSummary(message.summary),
        queuedAtMs,
      });
      rememberedIds.push(sourceMessageId);
    }
    return rememberedIds;
  }

  private forgetPendingInboxRelayCandidates(
    run: ProvisioningRun,
    recipient: string,
    sourceMessageIds: readonly string[]
  ): void {
    if (sourceMessageIds.length === 0) {
      return;
    }
    const idSet = new Set(sourceMessageIds);
    run.pendingInboxRelayCandidates = this.prunePendingInboxRelayCandidates(run).filter(
      (candidate) => !(candidate.recipient === recipient && idSet.has(candidate.sourceMessageId))
    );
  }

  private consumePendingInboxRelayCandidate(
    run: ProvisioningRun,
    recipient: string,
    text: string,
    summary?: string
  ): string | undefined {
    const normalizedText = this.normalizeRelayCandidateText(text);
    if (!normalizedText) {
      return undefined;
    }
    const normalizedSummary = this.normalizeRelayCandidateSummary(summary);
    const candidates = this.prunePendingInboxRelayCandidates(run);
    const exactSummaryIdx = candidates.findIndex(
      (candidate) =>
        candidate.recipient === recipient &&
        candidate.normalizedText === normalizedText &&
        candidate.normalizedSummary === normalizedSummary
    );
    const fallbackIdx =
      exactSummaryIdx >= 0
        ? exactSummaryIdx
        : candidates.findIndex(
            (candidate) =>
              candidate.recipient === recipient && candidate.normalizedText === normalizedText
          );
    if (fallbackIdx < 0) {
      return undefined;
    }
    const [matched] = candidates.splice(fallbackIdx, 1);
    return matched?.sourceMessageId;
  }

  private armSilentTeammateForward(
    run: ProvisioningRun,
    teammateName: string,
    mode: 'user_dm' | 'member_inbox_relay'
  ): void {
    run.silentUserDmForward = { target: teammateName, startedAt: nowIso(), mode };
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
      run.silentUserDmForwardClearHandle = null;
    }
    run.silentUserDmForwardClearHandle = setTimeout(() => {
      run.silentUserDmForward = null;
      run.silentUserDmForwardClearHandle = null;
    }, 60_000);
    run.silentUserDmForwardClearHandle.unref();
  }

  private toolApprovalEventEmitter: ((event: ToolApprovalEvent) => void) | null = null;
  private mainWindowRef: import('electron').BrowserWindow | null = null;
  private activeApprovalNotifications = new Map<string, import('electron').Notification>();

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalEventEmitter = emitter;
  }

  setMainWindow(win: import('electron').BrowserWindow | null): void {
    this.mainWindowRef = win;
  }

  private getToolApprovalSettings(teamName: string): ToolApprovalSettings {
    return this.toolApprovalSettingsByTeam.get(teamName) ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
  }

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    this.toolApprovalSettingsByTeam.set(teamName, settings);
    this.reEvaluatePendingApprovals();
  }

  private emitToolApprovalEvent(event: ToolApprovalEvent): void {
    this.toolApprovalEventEmitter?.(event);
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    return [...(this.liveLeadProcessMessages.get(teamName) ?? [])];
  }

  getLeadActivityState(teamName: string): {
    state: 'active' | 'idle' | 'offline';
    runId: string | null;
  } {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) return { state: 'offline', runId: null };
    const run = this.runs.get(runId);
    if (!run || run.processKilled || run.cancelRequested) return { state: 'offline', runId: null };
    return { state: run.leadActivityState, runId };
  }

  getLeadContextUsage(teamName: string): { usage: LeadContextUsage | null; runId: string | null } {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) return { usage: null, runId: null };
    const run = this.runs.get(runId);
    if (!run?.leadContextUsage || run.processKilled || run.cancelRequested) {
      return { usage: null, runId: null };
    }
    const { currentTokens, contextWindow } = run.leadContextUsage;
    const percentRaw = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;
    const percent = Math.max(0, Math.min(100, percentRaw));
    return {
      usage: { currentTokens, contextWindow, percent, updatedAt: new Date().toISOString() },
      runId,
    };
  }

  private isCurrentTrackedRun(run: ProvisioningRun): boolean {
    return this.getTrackedRunId(run.teamName) === run.runId;
  }

  private getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    const requestCwd = typeof run?.request?.cwd === 'string' ? run.request.cwd.trim() : '';
    if (requestCwd) return path.resolve(requestCwd);

    const spawnCwd = typeof run?.spawnContext?.cwd === 'string' ? run.spawnContext.cwd.trim() : '';
    if (spawnCwd) return path.resolve(spawnCwd);

    return null;
  }

  private getPreCompleteCliErrorText(run: ProvisioningRun): string {
    const parts: string[] = [];
    const stderrText = run.stderrBuffer.trim();
    if (stderrText) {
      parts.push(stderrText);
    }

    // Re-check only the parser-owned stdout carry that never became a newline-delimited message.
    // If it is complete JSON or clearly looks like Claude stream-json structure, ignore it here.
    // Otherwise treat it as trailing plaintext CLI output that should still participate in the
    // final auth/API failure guard.
    const trailingStdout = run.stdoutParserCarry.trim();
    if (
      trailingStdout &&
      !run.stdoutParserCarryIsCompleteJson &&
      !run.stdoutParserCarryLooksLikeClaudeJson
    ) {
      parts.push(trailingStdout);
    }

    return parts.join('\n').trim();
  }

  private setLeadActivity(run: ProvisioningRun, state: 'active' | 'idle' | 'offline'): void {
    if (run.leadActivityState === state) return;
    run.leadActivityState = state;
    if (!this.isCurrentTrackedRun(run)) return;
    this.teamChangeEmitter?.({
      type: 'lead-activity',
      teamName: run.teamName,
      runId: run.runId,
      detail: state,
    });
  }

  private emitToolActivity(run: ProvisioningRun, payload: ToolActivityEventPayload): void {
    if (!this.isCurrentTrackedRun(run)) return;
    this.teamChangeEmitter?.({
      type: 'tool-activity',
      teamName: run.teamName,
      runId: run.runId,
      detail: JSON.stringify(payload),
    });
  }

  private startRuntimeToolActivity(
    run: ProvisioningRun,
    memberName: string,
    block: Record<string, unknown>
  ): void {
    const rawId = typeof block.id === 'string' ? block.id.trim() : '';
    if (!rawId) return;

    const toolUseId = rawId;
    if (run.activeToolCalls.has(toolUseId)) return;

    const toolName = typeof block.name === 'string' ? block.name : 'unknown';
    const input = (block.input ?? {}) as Record<string, unknown>;
    const activity: ActiveToolCall = {
      memberName,
      toolUseId,
      toolName,
      preview: extractToolPreview(toolName, input),
      startedAt: nowIso(),
      state: 'running',
      source: 'runtime',
    };

    run.activeToolCalls.set(toolUseId, activity);
    this.emitToolActivity(run, {
      action: 'start',
      activity: {
        memberName: activity.memberName,
        toolUseId: activity.toolUseId,
        toolName: activity.toolName,
        preview: activity.preview,
        startedAt: activity.startedAt,
        source: activity.source,
      },
    });
  }

  private finishRuntimeToolActivity(
    run: ProvisioningRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void {
    const active = run.activeToolCalls.get(toolUseId);
    if (!active) return;

    run.activeToolCalls.delete(toolUseId);
    this.emitToolActivity(run, {
      action: 'finish',
      memberName: active.memberName,
      toolUseId,
      finishedAt: nowIso(),
      resultPreview: extractToolResultPreview(resultContent),
      isError,
    });

    const spawnedMemberName = run.memberSpawnToolUseIds.get(toolUseId);
    if (spawnedMemberName) {
      run.memberSpawnToolUseIds.delete(toolUseId);
      if (isError) {
        const resultPreview = extractToolResultPreview(resultContent);
        this.handleMemberSpawnFailure(run, spawnedMemberName, resultPreview);
      } else if (active.toolName === 'Agent') {
        const parsedStatus = parseAgentToolResultStatus(resultContent);
        if (parsedStatus?.status === 'duplicate_skipped') {
          const detail =
            parsedStatus.reason === 'already_running'
              ? 'duplicate spawn skipped - already running'
              : 'duplicate spawn skipped - teammate already online';
          this.appendMemberBootstrapDiagnostic(run, spawnedMemberName, detail);
          return;
        }

        // Agent tool_result only confirms that the runtime accepted the spawn.
        // The teammate becomes truly "online" only after the first inbox heartbeat.
        this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
      } else {
        this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
      }
    }
  }

  private handleMemberSpawnFailure(
    run: ProvisioningRun,
    memberName: string,
    resultPreview?: string
  ): void {
    const reason =
      (typeof resultPreview === 'string' && resultPreview.trim().length > 0
        ? resultPreview.trim()
        : 'Teammate spawn failed immediately after launch.') || 'Teammate spawn failed.';
    const message = `Teammate "${memberName}" failed to start: ${reason}`;

    this.setMemberSpawnStatus(run, memberName, 'error', message);

    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex < 0 || run.provisioningOutputParts[lastIndex]?.trim() !== message) {
      run.provisioningOutputParts.push(message);
    }

    if (
      !run.provisioningComplete &&
      (run.progress.state === 'assembling' || run.progress.state === 'configuring')
    ) {
      const progress = updateProgress(run, 'assembling', `Failed to start member ${memberName}`);
      run.onProgress(progress);
    }
  }

  private appendMemberBootstrapDiagnostic(
    run: ProvisioningRun,
    memberName: string,
    text: string
  ): void {
    const line = normalizeMemberDiagnosticText(memberName, text);
    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === line) {
      return;
    }
    run.provisioningOutputParts.push(line);
    logger.info(`[${run.teamName}] [bootstrap] ${line}`);
  }

  private resetRuntimeToolActivity(run: ProvisioningRun, memberName?: string): void {
    if (run.activeToolCalls.size === 0) return;

    if (!memberName) {
      run.activeToolCalls.clear();
      this.emitToolActivity(run, { action: 'reset' });
      return;
    }

    let removed = false;
    for (const [toolUseId, active] of run.activeToolCalls.entries()) {
      if (active.memberName !== memberName) continue;
      run.activeToolCalls.delete(toolUseId);
      removed = true;
    }

    if (removed) {
      this.emitToolActivity(run, { action: 'reset', memberName });
    }
  }

  /**
   * Update spawn status for a specific team member and emit a change event.
   */
  private setMemberSpawnStatus(
    run: ProvisioningRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string,
    livenessSource?: MemberSpawnLivenessSource,
    heartbeatAt?: string
  ): void {
    const prev = run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
    const updatedAt = nowIso();
    const next: MemberSpawnStatusEntry = {
      ...prev,
      status,
      updatedAt,
    };

    if (status === 'spawning') {
      next.launchState = 'starting';
    } else if (status === 'waiting') {
      next.agentToolAccepted = true;
      next.hardFailure = false;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.firstSpawnAcceptedAt = prev.firstSpawnAcceptedAt ?? updatedAt;
      next.launchState = 'runtime_pending_bootstrap';
    } else if (status === 'online') {
      next.agentToolAccepted = true;
      next.runtimeAlive = true;
      next.livenessSource = livenessSource;
      next.firstSpawnAcceptedAt = prev.firstSpawnAcceptedAt ?? updatedAt;
      if (livenessSource === 'heartbeat') {
        next.bootstrapConfirmed = true;
        next.lastHeartbeatAt = heartbeatAt?.trim() || prev.lastHeartbeatAt || updatedAt;
      }
      next.hardFailure = false;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.launchState = deriveMemberLaunchState(next);
    } else if (status === 'error') {
      next.error = error;
      next.hardFailure = true;
      next.hardFailureReason = error;
      next.launchState = 'failed_to_start';
    } else if (status === 'offline') {
      Object.assign(next, createInitialMemberSpawnStatusEntry(), { updatedAt });
    }

    next.launchState = deriveMemberLaunchState(next);
    if (
      prev.status === next.status &&
      prev.launchState === next.launchState &&
      prev.error === next.error &&
      prev.hardFailureReason === next.hardFailureReason &&
      prev.livenessSource === next.livenessSource &&
      prev.agentToolAccepted === next.agentToolAccepted &&
      prev.runtimeAlive === next.runtimeAlive &&
      prev.bootstrapConfirmed === next.bootstrapConfirmed &&
      prev.hardFailure === next.hardFailure &&
      prev.firstSpawnAcceptedAt === next.firstSpawnAcceptedAt &&
      prev.lastHeartbeatAt === next.lastHeartbeatAt
    ) {
      return;
    }

    run.memberSpawnStatuses.set(memberName, next);
    this.syncMemberLaunchGraceCheck(run, memberName, next);

    if (status === 'spawning') {
      this.appendMemberBootstrapDiagnostic(run, memberName, 'Agent tool invoked');
    } else if (status === 'waiting') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'spawn accepted, waiting for teammate check-in'
      );
    } else if (status === 'online' && livenessSource === 'heartbeat' && !prev.bootstrapConfirmed) {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'bootstrap confirmed via first heartbeat'
      );
    } else if (status === 'online' && livenessSource === 'process') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'runtime process is alive, teammate check-in not yet received'
      );
    } else if (status === 'error') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        error?.trim().length ? error.trim() : 'bootstrap failed'
      );
    }
    if (!this.isCurrentTrackedRun(run)) return;
    this.teamChangeEmitter?.({
      type: 'member-spawn',
      teamName: run.teamName,
      runId: run.runId,
      detail: memberName,
    });
    if (run.isLaunch) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  /**
   * Get current member spawn statuses for a team.
   * Returns a map of memberName → MemberSpawnStatusEntry.
   */
  async getMemberSpawnStatuses(teamName: string): Promise<{
    statuses: Record<string, MemberSpawnStatusEntry>;
    runId: string | null;
    teamLaunchState?: TeamLaunchAggregateState;
    launchPhase?: PersistedTeamLaunchPhase;
    expectedMembers?: string[];
    updatedAt?: string;
    summary?: PersistedTeamLaunchSummary;
    source?: 'live' | 'persisted' | 'merged';
  }> {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) {
      return this.reconcilePersistedLaunchState(teamName).then(({ snapshot, statuses }) => {
        this.attachLiveRuntimeMetadataToStatuses(teamName, statuses);
        return {
          statuses,
          runId: null,
          teamLaunchState: snapshot?.teamLaunchState,
          launchPhase: snapshot?.launchPhase,
          expectedMembers: snapshot?.expectedMembers,
          updatedAt: snapshot?.updatedAt,
          summary: snapshot?.summary,
          source: snapshot ? 'persisted' : 'persisted',
        };
      });
    }
    const run = this.runs.get(runId);
    if (!run) {
      return { statuses: {}, runId: null, source: 'persisted' };
    }

    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run);
    await this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');

    const persisted = await this.launchStateStore.read(teamName);
    const liveSnapshot = snapshotFromRuntimeMemberStatuses({
      teamName: run.teamName,
      expectedMembers: run.expectedMembers,
      leadSessionId: run.detectedSessionId ?? undefined,
      launchPhase: run.provisioningComplete ? 'finished' : 'active',
      statuses: this.buildRuntimeSpawnStatusRecord(run),
    });
    const snapshot = persisted ?? liveSnapshot;
    const statuses = snapshotToMemberSpawnStatuses(snapshot);
    this.attachLiveRuntimeMetadataToStatuses(teamName, statuses);
    return {
      statuses,
      runId,
      teamLaunchState: snapshot.teamLaunchState,
      launchPhase: snapshot.launchPhase,
      expectedMembers: snapshot.expectedMembers,
      updatedAt: snapshot.updatedAt,
      summary: snapshot.summary,
      source: persisted ? 'merged' : 'live',
    };
  }

  private getMemberLaunchGraceKey(run: ProvisioningRun, memberName: string): string {
    return `member-launch-grace:${run.runId}:${memberName}`;
  }

  private syncMemberLaunchGraceCheck(
    run: ProvisioningRun,
    memberName: string,
    entry: MemberSpawnStatusEntry
  ): void {
    const key = this.getMemberLaunchGraceKey(run, memberName);
    const existing = this.pendingTimeouts.get(key);
    if (entry.launchState === 'failed_to_start' || entry.launchState === 'confirmed_alive') {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    if (!entry.firstSpawnAcceptedAt) {
      return;
    }
    const remainingMs =
      Date.parse(entry.firstSpawnAcceptedAt) + MEMBER_LAUNCH_GRACE_MS - Date.now();
    if (remainingMs <= 0) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      void this.reevaluateMemberLaunchStatus(run, memberName);
      return;
    }
    if (existing) {
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.reevaluateMemberLaunchStatus(run, memberName);
    }, remainingMs);
    timer.unref?.();
    this.pendingTimeouts.set(key, timer);
  }

  private async reevaluateMemberLaunchStatus(
    run: ProvisioningRun,
    memberName: string
  ): Promise<void> {
    const current = run.memberSpawnStatuses.get(memberName);
    if (!current) return;
    if (
      current.launchState === 'failed_to_start' ||
      current.launchState === 'confirmed_alive' ||
      !current.firstSpawnAcceptedAt
    ) {
      return;
    }
    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run, { force: true });
    const refreshed = run.memberSpawnStatuses.get(memberName);
    if (!refreshed) return;
    if (
      refreshed.launchState === 'failed_to_start' ||
      refreshed.launchState === 'confirmed_alive' ||
      refreshed.runtimeAlive
    ) {
      return;
    }
    this.setMemberSpawnStatus(
      run,
      memberName,
      'error',
      'Teammate did not join within the launch grace window.'
    );
  }

  private shouldSkipMemberSpawnAudit(run: ProvisioningRun): boolean {
    if (!run.expectedMembers || run.expectedMembers.length === 0) {
      return true;
    }
    return run.expectedMembers.every((memberName) => {
      const entry = run.memberSpawnStatuses.get(memberName);
      return entry?.launchState === 'failed_to_start' || entry?.launchState === 'confirmed_alive';
    });
  }

  private async maybeAuditMemberSpawnStatuses(
    run: ProvisioningRun,
    options?: { force?: boolean }
  ): Promise<void> {
    if (!run.expectedMembers || run.expectedMembers.length === 0) {
      return;
    }
    await this.reconcileBootstrapTranscriptFailures(run);
    if (this.shouldSkipMemberSpawnAudit(run)) {
      return;
    }
    const now = Date.now();
    if (
      !options?.force &&
      run.lastMemberSpawnAuditAt > 0 &&
      now - run.lastMemberSpawnAuditAt < MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS
    ) {
      return;
    }
    run.lastMemberSpawnAuditAt = now;
    await this.auditMemberSpawnStatuses(run);
  }

  private async reconcileBootstrapTranscriptFailures(run: ProvisioningRun): Promise<void> {
    for (const memberName of run.expectedMembers ?? []) {
      const current = run.memberSpawnStatuses.get(memberName);
      if (
        !current ||
        current.launchState === 'failed_to_start' ||
        current.launchState === 'confirmed_alive' ||
        current.hardFailure === true ||
        current.agentToolAccepted !== true
      ) {
        continue;
      }
      const acceptedAtMs =
        current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const transcriptFailureReason = await this.findBootstrapTranscriptFailureReason(
        run.teamName,
        memberName,
        Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
      );
      if (!transcriptFailureReason) {
        continue;
      }
      this.setMemberSpawnStatus(run, memberName, 'error', transcriptFailureReason);
    }
  }

  private static readonly CONTEXT_EMIT_THROTTLE_MS = 2000;
  private static readonly LEAD_TEXT_EMIT_THROTTLE_MS = 2000;

  private emitLeadContextUsage(run: ProvisioningRun): void {
    if (!run.leadContextUsage || !run.provisioningComplete) return;
    if (!this.isCurrentTrackedRun(run)) return;
    const now = Date.now();
    if (
      now - run.leadContextUsage.lastEmittedAt <
      TeamProvisioningService.CONTEXT_EMIT_THROTTLE_MS
    ) {
      return;
    }
    run.leadContextUsage.lastEmittedAt = now;
    const { currentTokens, contextWindow } = run.leadContextUsage;
    const percentRaw = contextWindow > 0 ? Math.round((currentTokens / contextWindow) * 100) : 0;
    const percent = Math.max(0, Math.min(100, percentRaw));
    const payload: LeadContextUsage = {
      currentTokens,
      contextWindow,
      percent,
      updatedAt: new Date().toISOString(),
    };
    this.teamChangeEmitter?.({
      type: 'lead-context',
      teamName: run.teamName,
      runId: run.runId,
      detail: JSON.stringify(payload),
    });
  }

  async warmup(): Promise<void> {
    try {
      const cwd = process.cwd();
      if (this.getFreshCachedProbeResult(cwd, 'anthropic')) return;
      const result = await this.getCachedOrProbeResult(cwd, 'anthropic');
      if (!result) return;
      logger.info('CLI warmup completed');
    } catch (error) {
      logger.warn(`CLI warmup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: {
      forceFresh?: boolean;
      providerId?: TeamProviderId;
      providerIds?: TeamProviderId[];
      modelIds?: string[];
      limitContext?: boolean;
    }
  ): Promise<TeamProvisioningPrepareResult> {
    const targetCwdForValidation = cwd?.trim() || process.cwd();
    await this.validatePrepareCwd(targetCwdForValidation);
    const providerIds = Array.from(
      new Set(
        [opts?.providerId, ...(opts?.providerIds ?? [])]
          .map((providerId) => resolveTeamProviderId(providerId))
          .filter((providerId): providerId is TeamProviderId => Boolean(providerId))
      )
    );
    if (providerIds.length === 0) {
      providerIds.push('anthropic');
    }

    // Allow callers (e.g. scheduler warm-up) to bypass the 36h probe cache
    if (opts?.forceFresh) {
      for (const providerId of providerIds) {
        this.clearProbeCache(targetCwdForValidation, providerId);
      }
    }

    const targetCwd = cwd?.trim() || process.cwd();
    if (!path.isAbsolute(targetCwd)) {
      throw new Error('cwd must be an absolute path');
    }

    const warnings: string[] = [];
    const details: string[] = [];
    const blockingMessages: string[] = [];
    const selectedModelIds = Array.from(
      new Set((opts?.modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
    );

    for (const providerId of providerIds) {
      const cached = this.getFreshCachedProbeResult(targetCwdForValidation, providerId);
      const probeResult = cached ?? (await this.getCachedOrProbeResult(targetCwd, providerId));
      if (!probeResult?.claudePath) {
        throw new Error('Claude CLI not found; install it or provide a valid path');
      }

      const providerLabel = getTeamProviderLabel(providerId);
      const { authSource } = probeResult;
      if (authSource === 'anthropic_api_key') {
        logger.info(`Auth: using explicit ANTHROPIC_API_KEY for ${providerLabel}`);
      } else if (authSource === 'anthropic_auth_token') {
        logger.info(
          `Auth: using ANTHROPIC_AUTH_TOKEN mapped to ANTHROPIC_API_KEY for ${providerLabel}`
        );
      }

      if (!probeResult.warning) {
        if (selectedModelIds.length > 0) {
          const modelVerification = await this.verifySelectedProviderModels({
            claudePath: probeResult.claudePath,
            cwd: targetCwd,
            providerId,
            modelIds: selectedModelIds,
            limitContext: opts?.limitContext === true,
          });
          details.push(...modelVerification.details);
          warnings.push(...modelVerification.warnings);
          blockingMessages.push(...modelVerification.blockingMessages);
        }
        continue;
      }

      {
        const prefixedWarning =
          providerIds.length > 1 ? `${providerLabel}: ${probeResult.warning}` : probeResult.warning;
        const isAuthFailure = this.isAuthFailureWarning(probeResult.warning, 'probe');
        if (authSource === 'configured_api_key_missing') {
          blockingMessages.push(prefixedWarning);
        } else if (
          (authSource === 'none' ||
            authSource === 'codex_runtime' ||
            authSource === 'gemini_runtime') &&
          isAuthFailure
        ) {
          blockingMessages.push(prefixedWarning);
        } else if (isBinaryProbeWarning(probeResult.warning)) {
          blockingMessages.push(prefixedWarning);
        } else {
          // Preflight warnings (including timeouts) should not block provisioning.
          warnings.push(prefixedWarning);
        }
      }
    }

    if (blockingMessages.length > 0) {
      return {
        ready: false,
        details: details.length > 0 ? details : undefined,
        message:
          blockingMessages.length === 1
            ? blockingMessages[0]
            : 'Some provider runtimes are not ready',
        warnings: blockingMessages.length > 1 ? blockingMessages : undefined,
      };
    }

    return {
      ready: true,
      details: details.length > 0 ? details : undefined,
      message:
        providerIds.length > 1
          ? warnings.length > 0
            ? `Validated ${providerIds.length}/${providerIds.length} provider runtimes (see notes)`
            : `Validated ${providerIds.length}/${providerIds.length} provider runtimes`
          : warnings.length > 0
            ? 'CLI is ready to launch (see notes)'
            : 'CLI is warmed up and ready to launch',
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private async verifySelectedProviderModels({
    claudePath,
    cwd,
    providerId,
    modelIds,
    limitContext,
  }: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    modelIds: string[];
    limitContext: boolean;
  }): Promise<{
    details: string[];
    warnings: string[];
    blockingMessages: string[];
  }> {
    const details: string[] = [];
    const warnings: string[] = [];
    const blockingMessages: string[] = [];

    if (modelIds.length === 0) {
      return { details, warnings, blockingMessages };
    }

    const { env } = await this.buildProvisioningEnv(providerId);
    const probeOutcomeByResolvedModelId = new Map<
      string,
      { kind: 'ready' | 'warning' | 'unavailable'; reason?: string }
    >();
    let resolvedDefaultModelId: string | null | undefined;

    const recordOutcome = (
      requestedModelId: string,
      outcome: { kind: 'ready' | 'warning' | 'unavailable'; reason?: string }
    ): void => {
      if (outcome.kind === 'ready') {
        details.push(`Selected model ${requestedModelId} verified for launch.`);
        return;
      }
      if (outcome.kind === 'unavailable') {
        blockingMessages.push(
          `Selected model ${requestedModelId} is unavailable. ${outcome.reason ?? 'Model verification failed'}`
        );
        return;
      }
      warnings.push(
        `Selected model ${requestedModelId} could not be verified. ${outcome.reason ?? 'Model verification failed'}`
      );
    };

    for (const modelId of modelIds) {
      const label = modelId.trim();
      if (!label) {
        continue;
      }

      let targetModelId = label;
      if (isDefaultProviderModelSelection(label)) {
        if (resolvedDefaultModelId === undefined) {
          try {
            resolvedDefaultModelId = await this.resolveProviderDefaultModel(
              claudePath,
              cwd,
              providerId,
              env,
              limitContext
            );
          } catch {
            resolvedDefaultModelId = null;
          }
        }
        if (!resolvedDefaultModelId) {
          recordOutcome(label, {
            kind: 'warning',
            reason: 'Could not resolve the runtime default model',
          });
          continue;
        }
        targetModelId = resolvedDefaultModelId;
      }

      const cachedOutcome = probeOutcomeByResolvedModelId.get(targetModelId);
      if (cachedOutcome) {
        recordOutcome(label, cachedOutcome);
        continue;
      }

      try {
        const result = await this.spawnProbe(
          claudePath,
          buildProviderModelProbeArgs(targetModelId),
          cwd,
          env,
          getProviderModelProbeTimeoutMs(providerId),
          {
            resolveOnOutputMatch: ({ stdout, stderr }) =>
              isProviderModelProbeSuccessOutput(`${stdout}\n${stderr}`),
          }
        );
        const combinedOutput = buildCombinedLogs(result.stdout, result.stderr).trim();
        if (result.exitCode === 0 && isProviderModelProbeSuccessOutput(combinedOutput)) {
          const outcome = { kind: 'ready' as const };
          probeOutcomeByResolvedModelId.set(targetModelId, outcome);
          recordOutcome(label, outcome);
          continue;
        }

        const reason = combinedOutput || `Probe exited with code ${result.exitCode ?? 'unknown'}.`;
        const normalizedReason = normalizeProviderModelProbeFailureReason(reason);
        if (classifyProviderModelProbeFailure(reason) === 'unavailable') {
          const outcome = { kind: 'unavailable' as const, reason: normalizedReason };
          probeOutcomeByResolvedModelId.set(targetModelId, outcome);
          recordOutcome(label, outcome);
        } else {
          const outcome = { kind: 'warning' as const, reason: normalizedReason };
          probeOutcomeByResolvedModelId.set(targetModelId, outcome);
          recordOutcome(label, outcome);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.trim() : String(error).trim();
        const normalizedMessage = normalizeProviderModelProbeFailureReason(message);
        if (
          classifyProviderModelProbeFailure(message) === 'unavailable' &&
          !isTransientModelProbeMessage(message)
        ) {
          const outcome = { kind: 'unavailable' as const, reason: normalizedMessage };
          probeOutcomeByResolvedModelId.set(targetModelId, outcome);
          recordOutcome(label, outcome);
        } else {
          const outcome = { kind: 'warning' as const, reason: normalizedMessage };
          probeOutcomeByResolvedModelId.set(targetModelId, outcome);
          recordOutcome(label, outcome);
        }
      }
    }

    return { details, warnings, blockingMessages };
  }

  private async resolveProviderDefaultModel(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    limitContext: boolean
  ): Promise<string | null> {
    if (providerId === 'anthropic') {
      return getAnthropicDefaultTeamModel(limitContext);
    }

    const { stdout } = await execCli(claudePath, ['model', 'list', '--json', '--provider', 'all'], {
      cwd,
      env,
      timeout: 10_000,
    });
    const parsed = extractJsonObjectFromCli<ProviderModelListCommandResponse>(stdout);
    const defaultModel = parsed.providers?.[providerId]?.defaultModel;
    return typeof defaultModel === 'string' && defaultModel.trim().length > 0
      ? defaultModel.trim()
      : null;
  }

  private async materializeEffectiveTeamMemberSpecs(params: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
    };
    primaryProviderId?: TeamProviderId;
    primaryEnv?: ProvisioningEnvResolution;
    limitContext?: boolean;
  }): Promise<TeamCreateRequest['members']> {
    const envByProvider = new Map<TeamProviderId, Promise<ProvisioningEnvResolution>>();
    const defaultModelByProvider = new Map<TeamProviderId, Promise<string>>();
    const normalizedPrimaryProviderId = resolveTeamProviderId(params.primaryProviderId);

    const getProvisioningEnv = (providerId: TeamProviderId): Promise<ProvisioningEnvResolution> => {
      if (normalizedPrimaryProviderId === providerId && params.primaryEnv != null) {
        return Promise.resolve(params.primaryEnv);
      }

      const cached = envByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const created = this.buildProvisioningEnv(providerId);
      envByProvider.set(providerId, created);
      return created;
    };

    const getResolvedDefaultModel = (providerId: TeamProviderId): Promise<string> => {
      const cached = defaultModelByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const providerLabel = getTeamProviderLabel(providerId);
      const created = (async () => {
        const envResolution = await getProvisioningEnv(providerId);
        if (envResolution.warning) {
          throw new Error(envResolution.warning);
        }

        const resolvedDefaultModel = await this.resolveProviderDefaultModel(
          params.claudePath,
          params.cwd,
          providerId,
          envResolution.env,
          params.limitContext === true
        );
        const normalized = resolvedDefaultModel?.trim();
        if (!normalized) {
          throw new Error(
            `Could not resolve the runtime default model for ${providerLabel} teammates. Select an explicit model and retry.`
          );
        }
        return normalized;
      })();

      defaultModelByProvider.set(providerId, created);
      return created;
    };

    const effectiveMembers: TeamCreateRequest['members'] = [];
    for (const member of params.members) {
      const effectiveMember = buildEffectiveTeamMemberSpec(member, params.defaults);
      const providerId = normalizeTeamMemberProviderId(effectiveMember.providerId) ?? 'anthropic';
      if (providerId === 'anthropic' || effectiveMember.model?.trim()) {
        effectiveMembers.push(effectiveMember);
        continue;
      }

      effectiveMembers.push({
        ...effectiveMember,
        model: await getResolvedDefaultModel(providerId),
      });
    }

    return effectiveMembers;
  }

  private getFreshCachedProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): CachedProbeResult | null {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = cachedProbeResults.get(cacheKey);
    if (!cached) return null;
    const ageMs = Date.now() - cached.cachedAtMs;
    if (ageMs >= PROBE_CACHE_TTL_MS) {
      cachedProbeResults.delete(cacheKey);
      return null;
    }
    return cached;
  }

  private clearProbeCache(cwd: string, providerId: TeamProviderId | undefined): void {
    cachedProbeResults.delete(createProbeCacheKey(cwd, providerId));
  }

  private async validatePrepareCwd(cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw new Error('cwd must be an absolute path');
    }

    try {
      const stat = await fs.promises.stat(cwd);
      if (!stat.isDirectory()) {
        throw new Error('cwd must be a directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Allow the runtime probe to degrade a missing cwd into a warning.
        // This keeps prepareForProvisioning side-effect free for future/missing paths.
        return;
      }
      throw error;
    }
  }

  private async getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<ProbeResult | null> {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = this.getFreshCachedProbeResult(cwd, providerId);
    if (cached) {
      return {
        claudePath: cached.claudePath,
        authSource: cached.authSource,
        warning: cached.warning,
      };
    }

    const existingProbe = probeInFlightByKey.get(cacheKey);
    if (existingProbe) {
      return await existingProbe;
    }

    const probePromise = (async () => {
      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) return null;

      const { env, authSource, warning } = await this.buildProvisioningEnv(providerId);
      if (warning) {
        return {
          claudePath,
          authSource,
          warning,
        };
      }

      const probe = await this.probeClaudeRuntime(claudePath, cwd, env, providerId);
      const result = {
        claudePath,
        authSource,
        ...(probe.warning ? { warning: probe.warning } : {}),
      };

      const shouldCache =
        !probe.warning ||
        (!this.isAuthFailureWarning(probe.warning, 'probe') &&
          !isTransientProbeWarning(probe.warning) &&
          !isBinaryProbeWarning(probe.warning));

      if (shouldCache) {
        cachedProbeResults.set(cacheKey, { cacheKey, ...result, cachedAtMs: Date.now() });
      } else {
        // Don't pin auth failures / transient failures in cache — user may fix and retry.
        cachedProbeResults.delete(cacheKey);
      }

      return result;
    })();
    probeInFlightByKey.set(cacheKey, probePromise);

    try {
      return await probePromise;
    } finally {
      probeInFlightByKey.delete(cacheKey);
    }
  }

  private isAuthFailureWarning(text: string, source: AuthWarningSource): boolean {
    const lower = text.toLowerCase();
    const hasExplicitCliAuthSignal =
      lower.includes('not authenticated') ||
      lower.includes('not logged in') ||
      lower.includes('please run /login') ||
      lower.includes('missing api key') ||
      lower.includes('invalid api key') ||
      lower.includes('authentication failed') ||
      lower.includes('not configured for runtime use') ||
      lower.includes('set gemini_api_key') ||
      lower.includes('google adc credentials') ||
      lower.includes('google_cloud_project') ||
      lower.includes('codex provider is not authenticated') ||
      lower.includes('run `claude auth login`') ||
      lower.includes('claude auth login') ||
      lower.includes('claude-multimodel auth login');

    if (hasExplicitCliAuthSignal) {
      return true;
    }

    if (source === 'assistant' || source === 'stdout') {
      return false;
    }

    const hasAuthStatus401 =
      /api error:\s*401\b/i.test(text) ||
      /\b401 unauthorized\b/i.test(lower) ||
      (/(^|\D)401(\D|$)/.test(lower) &&
        (lower.includes('auth') || lower.includes('api') || lower.includes('login')));

    return (
      hasAuthStatus401 ||
      (lower.includes('unauthorized') &&
        (lower.includes('api') || lower.includes('auth') || lower.includes('login')))
    );
  }

  private hasApiError(text: string): boolean {
    return /api error:\s*\d{3}\b/i.test(text) || /invalid_request_error/i.test(text);
  }

  private sanitizeCliSnippet(text: string): string {
    // Remove control characters that often show up as binary noise in CLI error payloads.
    // Preserve newlines/tabs for readability.
    // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentionally stripping control chars
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  private normalizeApiRetryErrorMessage(text: string): string {
    const sanitized = this.sanitizeCliSnippet(text).trim();
    if (!sanitized) {
      return sanitized;
    }

    const jsonMatch = /^\d{3}\s+(\{[\s\S]*\})$/.exec(sanitized);
    const jsonCandidate = jsonMatch?.[1] ?? (sanitized.startsWith('{') ? sanitized : null);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate) as {
          error?: { message?: unknown };
          message?: unknown;
        };
        const nestedMessage =
          typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : typeof parsed.message === 'string'
              ? parsed.message
              : null;
        if (nestedMessage) {
          return this.normalizeApiRetryErrorMessage(nestedMessage);
        }
      } catch {
        // Fall through to raw sanitized text.
      }
    }

    return sanitized
      .replace(/^gemini cli backend error:\s*/i, '')
      .replace(/^gemini api backend error:\s*/i, '')
      .replace(/^api error:\s*\d+\s*/i, '')
      .trim();
  }

  private isQuotaRetryMessage(text: string | undefined): boolean {
    const lower = (text ?? '').toLowerCase();
    return (
      lower.includes('quota will reset after') ||
      lower.includes('exhausted your capacity on this model') ||
      lower.includes('resource exhausted') ||
      lower.includes('rate limit') ||
      lower.includes('rate_limit')
    );
  }

  private toMarkdownCodeSafe(text: string): string {
    return this.sanitizeCliSnippet(text).replace(/```/g, '``\\`');
  }

  private extractApiErrorSnippet(text: string): string | null {
    const match = /api error:\s*\d{3}\b/i.exec(text) ?? /invalid_request_error/i.exec(text);
    if (match?.index === undefined) return null;
    const start = Math.max(0, match.index - 200);
    const end = Math.min(text.length, match.index + 4000);
    const raw = text.slice(start, end).trim();
    if (!raw) return null;
    // Avoid breaking markdown fences if the payload contains ``` accidentally.
    return this.sanitizeCliSnippet(raw).replace(/```/g, '``\\`');
  }

  private failProvisioningWithApiError(run: ProvisioningRun, source: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (run.progress.state === 'failed' || run.cancelRequested) return;

    const combined = [
      buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer),
      run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const snippet =
      this.extractApiErrorSnippet(combined) ?? this.extractApiErrorSnippet(source) ?? null;
    const status =
      /api error:\s*(\d{3})\b/i.exec(combined)?.[1] ?? /api error:\s*(\d{3})\b/i.exec(source)?.[1];

    const hint = run.isLaunch ? 'Launch' : 'Provisioning';
    const statusLabel = status ? `API Error ${status}` : 'API Error';
    if (snippet) {
      run.provisioningOutputParts.push(
        `**${hint} failed: ${statusLabel} detected**\n\n\`\`\`\n${snippet}\n\`\`\``
      );
    } else {
      run.provisioningOutputParts.push(`**${hint} failed: ${statusLabel} detected**`);
    }

    const progress = updateProgress(run, 'failed', `${hint} failed — ${statusLabel}`, {
      error: `Claude CLI reported ${statusLabel} during startup. The team was not started.`,
      cliLogsTail: extractCliLogsFromRun(run),
    });
    run.onProgress(progress);

    run.processKilled = true;
    run.cancelRequested = true;
    // SIGKILL: newer Claude CLI versions handle SIGTERM gracefully and delete
    // team files during cleanup. SIGKILL is uncatchable — files are preserved.
    killTeamProcess(run.child);
    this.cleanupRun(run);
  }

  /**
   * Shows a non-fatal API error warning in the Live output section.
   * Unlike failProvisioningWithApiError, does NOT kill the process — lets the SDK retry.
   * Deduplicates: only the first warning per run is shown.
   */
  private emitApiErrorWarning(run: ProvisioningRun, text: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (run.progress.state === 'failed' || run.cancelRequested) return;
    if (run.apiErrorWarningEmitted) return;

    run.apiErrorWarningEmitted = true;

    const snippet = this.extractApiErrorSnippet(text);
    const status = /api error:\s*(\d{3})\b/i.exec(text)?.[1] ?? null;
    const label = status ? `API Error ${status}` : 'API Error';

    const warningText = snippet
      ? `**${label} — SDK is retrying**\n\n\`\`\`\n${snippet}\n\`\`\`\n\nWaiting for retry...`
      : `**${label} — SDK is retrying**\n\nWaiting for retry...`;

    run.provisioningOutputParts.push(warningText);
    run.progress.message = `${label} — SDK retrying...`;
    emitLogsProgress(run);
    // Prevent double-emit: the calling stderr/stdout handler will also try throttled emitLogsProgress
    // after this returns. Updating lastLogProgressAt ensures the throttle check rejects it.
    run.lastLogProgressAt = Date.now();
  }

  /**
   * Starts a periodic watchdog that detects when the CLI process has produced
   * no stdout/stderr data for an extended period. Pushes progressive warnings
   * into provisioningOutputParts so they appear in the Live output section.
   */
  private startStallWatchdog(run: ProvisioningRun): void {
    if (run.stallCheckHandle) return;

    run.stallCheckHandle = setInterval(() => {
      // try/catch: Node.js does NOT catch errors in setInterval callbacks —
      // without this, an exception would silently kill the watchdog.
      try {
        if (
          run.provisioningComplete ||
          run.processKilled ||
          run.cancelRequested ||
          run.authRetryInProgress
        ) {
          this.stopStallWatchdog(run);
          return;
        }

        const now = Date.now();
        const silenceMs = now - run.lastStdoutReceivedAt;

        if (silenceMs < STALL_WARNING_THRESHOLD_MS) return;

        // Instead of pushing new warnings (which bloats Live output),
        // replace the existing stall warning in-place so the displayed
        // silence duration stays current (20s → 30s → 1m → ...).
        const silenceSec = Math.round(silenceMs / 1000);
        const warningText = this.buildStallWarningText(silenceSec, run);

        if (run.stallWarningIndex != null) {
          run.provisioningOutputParts[run.stallWarningIndex] = warningText;
        } else {
          // Save current message ONLY if it's a normal provisioning message,
          // not a retry message (which has higher priority and its own lifecycle).
          if (run.progress.messageSeverity !== 'error') {
            run.preStallMessage = run.progress.message;
          }
          run.stallWarningIndex = run.provisioningOutputParts.length;
          run.provisioningOutputParts.push(warningText);
        }

        const mins = Math.floor(silenceSec / 60);
        const secs = silenceSec % 60;
        const elapsed = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;

        // If retry messages are flowing, they are more informative than our
        // generic stall text — don't overwrite progress.message / severity.
        // Only update the Live output (assistantOutput) with the stall warning.
        const retryActive = run.lastRetryAt > 0 && now - run.lastRetryAt < 90_000;

        run.progress = {
          ...run.progress,
          updatedAt: nowIso(),
          ...(!retryActive && {
            message: this.buildStallProgressMessage(silenceSec, elapsed),
            messageSeverity: 'warning' as const,
          }),
          assistantOutput: run.provisioningOutputParts.join('\n\n'),
        };
        run.onProgress(run.progress);
      } catch (err) {
        logger.error(
          `[${run.teamName}] Stall watchdog error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(run: ProvisioningRun): void {
    if (run.stallCheckHandle) {
      clearInterval(run.stallCheckHandle);
      run.stallCheckHandle = null;
    }
  }

  private buildStallWarningText(silenceSec: number, run: ProvisioningRun): string {
    const mins = Math.floor(silenceSec / 60);
    const secs = silenceSec % 60;
    const elapsed = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;

    if (silenceSec < 60) {
      return (
        `---\n\n` +
        `**Waiting for CLI response** (silent for ${elapsed})\n\n` +
        `The process is running but not producing output yet. Cloud sometimes delays logs, ` +
        `and short waits like this are normal. The SDK also retries automatically if the ` +
        `request briefly hits rate limiting.\n\n` +
        `Waiting...`
      );
    }

    if (silenceSec < 120) {
      return (
        `---\n\n` +
        `**Waiting for CLI response** (silent for ${elapsed})\n\n` +
        `The process is still waiting on Cloud. Logs can sometimes show up after ` +
        `1-1.5 minutes, and that is still okay. The SDK retries automatically if the ` +
        `request hits rate limiting (error 429 / model cooldown).\n\n` +
        `If there is still no output after 2 minutes, that starts to look unusual.\n\n` +
        `You can cancel and try again later if the wait continues.`
      );
    }

    const modelName = run.request.model ?? 'default';
    const effortLabel = run.request.effort ? ` (effort: ${run.request.effort})` : '';

    return (
      `---\n\n` +
      `**Extended CLI wait** (silent for ${elapsed})\n\n` +
      `Model **${modelName}**${effortLabel} is still waiting on Cloud. Some delay is normal, ` +
      `but no logs for ${elapsed} is already unusual.\n\n` +
      `Possible causes:\n` +
      `- Rate limiting / model cooldown (429) — SDK retries automatically\n` +
      `- API server overload for this model\n` +
      `- A stalled or delayed Cloud response\n\n` +
      `Consider canceling and trying with a different model.`
    );
  }

  private buildStallProgressMessage(silenceSec: number, elapsed: string): string {
    if (silenceSec < 120) {
      return `Waiting on Cloud response for ${elapsed} — logs can be delayed, this is still OK`;
    }
    return `Still waiting on Cloud response for ${elapsed} — this is unusual`;
  }

  /**
   * Detects auth failure keywords in stderr/stdout during provisioning.
   * On first detection: kills process, waits, and respawns automatically.
   * On second detection (after retry): fails fast with a clear error.
   */
  private handleAuthFailureInOutput(
    run: ProvisioningRun,
    text: string,
    source: AuthWarningSource
  ): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (!this.isAuthFailureWarning(text, source)) return;

    if (!run.authFailureRetried) {
      logger.warn(
        `[${run.teamName}] Auth failure detected in ${source} during provisioning — ` +
          `will kill process and retry after ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms`
      );
      run.authRetryInProgress = true;
      void this.respawnAfterAuthFailure(run);
    } else {
      logger.error(`[${run.teamName}] Auth failure detected in ${source} after retry — giving up`);
      run.processKilled = true;
      killTeamProcess(run.child);
      const progress = updateProgress(run, 'failed', 'Authentication failed — CLI requires login', {
        error:
          'Claude CLI is not authenticated. Run `claude auth login` (or start `claude` and run `/login`) ' +
          'to authenticate, or set ANTHROPIC_API_KEY and try again.',
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    }
  }

  /**
   * Kills the current process, waits for lock release, and respawns with saved context.
   * Reattaches all stream listeners and resends the prompt.
   */
  private async respawnAfterAuthFailure(run: ProvisioningRun): Promise<void> {
    const ctx = run.spawnContext;
    if (!ctx) {
      logger.error(`[${run.teamName}] Cannot respawn — no spawn context saved`);
      run.authRetryInProgress = false;
      return;
    }

    // Tear down current process without full cleanupRun (keep run alive)
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    this.stopStallWatchdog(run);
    if (run.child) {
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
      run.child.removeAllListeners('error');
      run.child.removeAllListeners('exit');
      killTeamProcess(run.child);
      run.child = null;
    }

    // Reset buffers for fresh attempt
    run.stdoutBuffer = '';
    run.stderrBuffer = '';
    run.claudeLogLines = [];
    run.lastClaudeLogStream = null;
    run.stdoutLogLineBuf = '';
    run.stderrLogLineBuf = '';
    run.claudeLogsUpdatedAt = undefined;
    run.authFailureRetried = true;
    run.apiErrorWarningEmitted = false;

    updateProgress(run, 'spawning', 'Auth failed — retrying after short delay');
    run.onProgress(run.progress);

    await sleep(PREFLIGHT_AUTH_RETRY_DELAY_MS);

    if (run.cancelRequested) {
      run.authRetryInProgress = false;
      return;
    }

    // Verify --mcp-config still exists; regenerate if deleted (e.g. by stale GC)
    const mcpFlagIdx = ctx.args.indexOf('--mcp-config');
    const bootstrapPromptFlagIdx = ctx.args.indexOf('--team-bootstrap-user-prompt-file');
    if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
      const existingConfigPath = ctx.args[mcpFlagIdx + 1];
      try {
        await fs.promises.access(existingConfigPath, fs.constants.F_OK);
      } catch {
        logger.warn(`[${run.teamName}] MCP config ${existingConfigPath} missing, regenerating`);
        try {
          const newConfigPath = await this.mcpConfigBuilder.writeConfigFile(ctx.cwd);
          ctx.args[mcpFlagIdx + 1] = newConfigPath;
          run.mcpConfigPath = newConfigPath;
          logger.info(`[${run.teamName}] Regenerated MCP config at ${newConfigPath}`);
        } catch (regenErr) {
          run.authRetryInProgress = false;
          const progress = updateProgress(run, 'failed', 'Failed to regenerate MCP config', {
            error: regenErr instanceof Error ? regenErr.message : String(regenErr),
            cliLogsTail: extractCliLogsFromRun(run),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        }
      }
    }

    if (bootstrapPromptFlagIdx !== -1 && bootstrapPromptFlagIdx + 1 < ctx.args.length) {
      const existingPromptPath = ctx.args[bootstrapPromptFlagIdx + 1];
      try {
        await fs.promises.access(existingPromptPath, fs.constants.F_OK);
      } catch {
        const submissionState = await readBootstrapRealTaskSubmissionState(run.teamName);
        if (submissionState === 'submitted') {
          ctx.args.splice(bootstrapPromptFlagIdx, 2);
          ctx.prompt = '';
          run.bootstrapUserPromptPath = null;
        } else if (submissionState === 'unknown') {
          run.authRetryInProgress = false;
          const progress = updateProgress(
            run,
            'failed',
            'Unable to safely retry first task after auth failure',
            {
              error:
                'deterministic bootstrap recorded the first real task as unknown, so retry would risk a duplicate submission',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        } else if (ctx.prompt.trim().length === 0) {
          run.authRetryInProgress = false;
          const progress = updateProgress(
            run,
            'failed',
            'Failed to restore deferred first task after auth retry',
            {
              error:
                'deterministic bootstrap user prompt file was missing and no prompt was available to regenerate it',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        } else {
          logger.warn(
            `[${run.teamName}] Bootstrap user prompt file ${existingPromptPath} missing, regenerating`
          );
          try {
            const newPromptPath = await writeDeterministicBootstrapUserPromptFile(ctx.prompt);
            ctx.args[bootstrapPromptFlagIdx + 1] = newPromptPath;
            run.bootstrapUserPromptPath = newPromptPath;
          } catch (regenErr) {
            run.authRetryInProgress = false;
            const progress = updateProgress(
              run,
              'failed',
              'Failed to regenerate deferred first task for auth retry',
              {
                error: regenErr instanceof Error ? regenErr.message : String(regenErr),
                cliLogsTail: extractCliLogsFromRun(run),
              }
            );
            run.onProgress(progress);
            this.cleanupRun(run);
            return;
          }
        }
      }
    }

    // Respawn with saved context — CLI handles its own auth refresh.
    let child: ReturnType<typeof spawn>;
    try {
      if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
        await this.validateAgentTeamsMcpRuntime(
          ctx.claudePath,
          ctx.cwd,
          ctx.env,
          ctx.args[mcpFlagIdx + 1]
        );
      }
      child = spawnCli(ctx.claudePath, ctx.args, {
        cwd: ctx.cwd,
        env: { ...ctx.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      run.authRetryInProgress = false;
      const progress = updateProgress(run, 'failed', 'Failed to respawn Claude CLI', {
        error: error instanceof Error ? error.message : String(error),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    logger.info(
      `[${run.teamName}] Respawned CLI process after auth failure (pid=${child.pid ?? '?'})`
    );
    run.child = child;
    run.authRetryInProgress = false;

    updateProgress(run, 'spawning', 'CLI respawned — sending prompt', {
      pid: child.pid ?? undefined,
    });
    run.onProgress(run.progress);

    // Resend prompt only for legacy direct-stdin flows. Deterministic bootstrap
    // owns the first real task via --team-bootstrap-user-prompt-file.
    if (bootstrapPromptFlagIdx === -1 && child.stdin?.writable) {
      const message = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: ctx.prompt }],
        },
      });
      child.stdin.write(message + '\n');
    }

    // Reattach stdout handler
    this.attachStdoutHandler(run);

    // Reattach stderr handler
    this.attachStderrHandler(run);

    run.lastDataReceivedAt = Date.now();
    run.lastStdoutReceivedAt = Date.now();
    this.startStallWatchdog(run);

    // Restart filesystem monitor for createTeam (launch skips it)
    if (!run.isLaunch) {
      updateProgress(run, 'configuring', 'Waiting for team configuration...');
      run.onProgress(run.progress);
      this.startFilesystemMonitor(run, run.request);
    } else {
      updateProgress(
        run,
        'configuring',
        run.deterministicBootstrap
          ? 'CLI running — deterministic reconnect in progress'
          : 'CLI running — reconnecting with teammates'
      );
      run.onProgress(run.progress);
    }

    // Restart timeout
    run.timeoutHandle = setTimeout(() => {
      if (!run.processKilled && !run.provisioningComplete) {
        run.processKilled = true;
        run.finalizingByTimeout = true;
        void (async () => {
          const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
          killTeamProcess(run.child);
          if (readyOnTimeout) return;

          const hint = run.isLaunch ? ' (launch)' : '';
          const progress = updateProgress(run, 'failed', `Timed out waiting for CLI${hint}`, {
            error: `Timed out waiting for CLI${hint}.`,
            cliLogsTail: extractCliLogsFromRun(run),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
        })();
      }
    }, RUN_TIMEOUT_MS);

    child.once('error', (error) => {
      const hint = run.isLaunch ? ' (launch)' : '';
      const progress = updateProgress(run, 'failed', `Failed to start Claude CLI${hint}`, {
        error: error.message,
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    });

    child.once('exit', (code) => {
      void this.handleProcessExit(run, code);
    });
  }

  /** Attaches the stdout stream-json parser to the current child process. */
  private attachStdoutHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stdout) return;

    let stdoutLineBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      // Reset generic data timestamp (used for other purposes, not stall detection).
      run.lastDataReceivedAt = Date.now();

      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stdout', text);
      run.stdoutBuffer += text;
      if (run.stdoutBuffer.length > STDOUT_RING_LIMIT) {
        run.stdoutBuffer = run.stdoutBuffer.slice(run.stdoutBuffer.length - STDOUT_RING_LIMIT);
      }

      // Parse stream-json lines (newline-delimited JSON)
      stdoutLineBuf += text;
      const lines = stdoutLineBuf.split('\n');
      stdoutLineBuf = lines.pop() ?? '';
      run.stdoutParserCarry = stdoutLineBuf;
      const trimmedCarry = stdoutLineBuf.trim();
      if (!trimmedCarry) {
        run.stdoutParserCarryIsCompleteJson = false;
        run.stdoutParserCarryLooksLikeClaudeJson = false;
      } else {
        try {
          JSON.parse(trimmedCarry);
          run.stdoutParserCarryIsCompleteJson = true;
        } catch {
          run.stdoutParserCarryIsCompleteJson = false;
        }
        run.stdoutParserCarryLooksLikeClaudeJson = looksLikeClaudeStdoutJsonFragment(trimmedCarry);
      }
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          // Only reset stall timer on messages that represent actual API progress
          // (assistant response or result). System messages like retry attempts
          // (type=system, subtype=attempt) are informational — the CLI is still
          // waiting for the API and the user should see the stall warning.
          const msgType = msg.type;
          if (msgType === 'assistant' || msgType === 'result') {
            run.lastStdoutReceivedAt = Date.now();
            if (run.stallWarningIndex != null) {
              const removedIndex = run.stallWarningIndex;
              run.provisioningOutputParts.splice(removedIndex, 1);
              this.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex);
              run.stallWarningIndex = null;
              if (run.preStallMessage != null) {
                run.progress.message = run.preStallMessage;
                run.preStallMessage = null;
                delete run.progress.messageSeverity;
              }
            }
          }
          this.handleStreamJsonMessage(run, msg);
        } catch {
          // Not valid JSON — check for auth failure in raw text output
          this.handleAuthFailureInOutput(run, trimmed, 'stdout');
          if (this.hasApiError(trimmed) && !this.isAuthFailureWarning(trimmed, 'stdout')) {
            // Show warning but do NOT kill — the SDK may be retrying internally (e.g. 429 model_cooldown).
            // If all retries fail, result.subtype="error" will catch it and kill then.
            this.emitApiErrorWarning(run, trimmed);
          }
        }
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
  }

  /** Attaches the stderr handler with auth failure detection. */
  private attachStderrHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stderr) return;

    child.stderr.on('data', (chunk: Buffer) => {
      // Reset stall watchdog FIRST — any data (even partial JSON) means the CLI is alive.
      run.lastDataReceivedAt = Date.now();
      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stderr', text);
      run.stderrBuffer += text;
      if (run.stderrBuffer.length > STDERR_RING_LIMIT) {
        run.stderrBuffer = run.stderrBuffer.slice(run.stderrBuffer.length - STDERR_RING_LIMIT);
      }

      // Detect auth failure early instead of waiting for 5-minute timeout
      this.handleAuthFailureInOutput(run, text, 'stderr');
      if (this.hasApiError(text) && !this.isAuthFailureWarning(text, 'stderr')) {
        // Show warning but do NOT kill — the SDK may be retrying internally (e.g. 429 model_cooldown).
        // If all retries fail, result.subtype="error" will catch it and kill then.
        this.emitApiErrorWarning(run, text);
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    return this.withTeamLock(request.teamName, async () => {
      return this._createTeamInner(request, onProgress);
    });
  }

  private async _createTeamInner(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    const existingProvisioningRunId = this.getProvisioningRunId(request.teamName);
    if (existingProvisioningRunId) {
      return { runId: existingProvisioningRunId };
    }
    assertAppDeterministicBootstrapEnabled();

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.provisioningRunByTeam.set(request.teamName, pendingKey);

    try {
      const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
      for (const probe of teamsBasePathsToProbe) {
        const configPath = path.join(probe.basePath, request.teamName, 'config.json');
        if (await this.pathExists(configPath)) {
          const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
          throw new Error(`Team already exists${suffix}`);
        }
      }

      await ensureCwdExists(request.cwd);

      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) {
        throw new Error('Claude CLI not found; install it or provide a valid path');
      }

      const provisioningEnv = await this.buildProvisioningEnv(request.providerId);
      const { env: shellEnv, geminiRuntimeAuth, warning: envWarning } = provisioningEnv;
      if (envWarning) {
        throw new Error(envWarning);
      }
      const effectiveMemberSpecs = await this.materializeEffectiveTeamMemberSpecs({
        claudePath,
        cwd: request.cwd,
        members: request.members,
        defaults: {
          providerId: request.providerId,
          model: request.model,
          effort: request.effort,
        },
        primaryProviderId: request.providerId,
        primaryEnv: provisioningEnv,
        limitContext: request.limitContext,
      });
      const runId = randomUUID();
      const startedAt = nowIso();
      const run: ProvisioningRun = {
        runId,
        teamName: request.teamName,
        startedAt,
        stdoutBuffer: '',
        stderrBuffer: '',
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        stdoutParserCarry: '',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: false,
        claudeLogsUpdatedAt: undefined,
        processKilled: false,
        finalizingByTimeout: false,
        cancelRequested: false,
        teamsBasePathsToProbe,
        child: null,
        timeoutHandle: null,
        fsMonitorHandle: null,
        onProgress,
        expectedMembers: request.members.map((member) => member.name),
        request,
        effectiveMembers: effectiveMemberSpecs,
        lastLogProgressAt: 0,
        lastDataReceivedAt: 0, // intentionally 0 — real reset happens after spawn (see startStallWatchdog call sites)
        lastStdoutReceivedAt: 0,
        stallCheckHandle: null,
        stallWarningIndex: null,
        preStallMessage: null,
        lastRetryAt: 0,
        apiRetryWarningIndex: null,
        apiErrorWarningEmitted: false,
        waitingTasksSince: null,
        provisioningComplete: false,
        mcpConfigPath: null,
        bootstrapSpecPath: null,
        bootstrapUserPromptPath: null,
        isLaunch: false,
        deterministicBootstrap: true,
        fsPhase: 'waiting_config',
        leadRelayCapture: null,
        activeCrossTeamReplyHints: [],
        leadMsgSeq: 0,
        pendingToolCalls: [],
        activeToolCalls: new Map(),
        pendingDirectCrossTeamSendRefresh: false,
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        pendingInboxRelayCandidates: [],
        provisioningOutputParts: [],
        provisioningOutputIndexByMessageId: new Map(),
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        pendingApprovals: new Map(),
        processedPermissionRequestIds: new Set(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
        pendingGeminiPostLaunchHydration: false,
        geminiPostLaunchHydrationInFlight: false,
        geminiPostLaunchHydrationSent: false,
        suppressGeminiPostLaunchHydrationOutput: false,
        memberSpawnStatuses: new Map(
          request.members.map((m) => [m.name, createInitialMemberSpawnStatusEntry()])
        ),
        memberSpawnToolUseIds: new Map(),
        lastDeterministicBootstrapSeq: 0,
        lastMemberSpawnAuditAt: 0,
        lastMemberSpawnAuditConfigReadWarningAt: 0,
        lastMemberSpawnAuditMissingWarningAt: new Map(),
        progress: {
          runId,
          teamName: request.teamName,
          state: 'validating',
          message: 'Validating team provisioning request',
          startedAt,
          updatedAt: startedAt,
          cliLogsTail: undefined,
        },
      };

      this.runs.set(runId, run);
      this.provisioningRunByTeam.set(request.teamName, runId);
      run.onProgress(run.progress);
      await this.clearPersistedLaunchState(request.teamName);

      const bootstrapSpec = buildDeterministicCreateBootstrapSpec(
        runId,
        request,
        effectiveMemberSpecs
      );
      const initialUserPrompt = request.prompt?.trim() ?? '';
      const promptSize = getPromptSizeSummary(initialUserPrompt);
      let child: ReturnType<typeof spawn>;
      shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
      const teammateModeDecision = await resolveDesktopTeammateModeDecision(request.extraCliArgs);
      if (teammateModeDecision.forceProcessTeammates) {
        shellEnv.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1';
      }
      let mcpConfigPath: string;
      let bootstrapSpecPath: string;
      let bootstrapUserPromptPath: string | null = null;
      try {
        bootstrapSpecPath = await writeDeterministicBootstrapSpecFile(bootstrapSpec);
        run.bootstrapSpecPath = bootstrapSpecPath;
        if (initialUserPrompt) {
          bootstrapUserPromptPath =
            await writeDeterministicBootstrapUserPromptFile(initialUserPrompt);
          run.bootstrapUserPromptPath = bootstrapUserPromptPath;
        }
        mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(request.cwd);
        run.mcpConfigPath = mcpConfigPath;
        await this.validateAgentTeamsMcpRuntime(claudePath, request.cwd, shellEnv, mcpConfigPath);
      } catch (error) {
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        throw error;
      }
      const spawnArgs = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user,project,local',
        '--mcp-config',
        mcpConfigPath,
        '--team-bootstrap-spec',
        bootstrapSpecPath,
        ...(bootstrapUserPromptPath
          ? ['--team-bootstrap-user-prompt-file', bootstrapUserPromptPath]
          : []),
        '--disallowedTools',
        APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        // Explicit --permission-mode overrides user's defaultMode in ~/.claude/settings.json
        // (e.g. "acceptEdits") which otherwise takes precedence over CLI flags
        ...(request.skipPermissions !== false
          ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
        ...(request.model ? ['--model', request.model] : []),
        ...(request.effort ? ['--effort', request.effort] : []),
        ...(request.worktree ? ['--worktree', request.worktree] : []),
        ...parseCliArgs(request.extraCliArgs),
      ];
      const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      logRuntimeLaunchSnapshot(request.teamName, claudePath, spawnArgs, request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      try {
        // Pre-save our meta files before spawn — CLI doesn't touch these.
        // If provisioning fails before TeamCreate, user can retry without re-entering config.
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        const tasksDir = path.join(getTasksBasePath(), request.teamName);
        await fs.promises.mkdir(teamDir, { recursive: true });
        await fs.promises.mkdir(tasksDir, { recursive: true });
        await this.teamMetaStore.writeMeta(request.teamName, {
          displayName: request.displayName,
          description: request.description,
          color: request.color,
          cwd: request.cwd,
          prompt: request.prompt,
          providerId: request.providerId,
          model: request.model,
          effort: request.effort,
          skipPermissions: request.skipPermissions,
          worktree: request.worktree,
          extraCliArgs: request.extraCliArgs,
          limitContext: request.limitContext,
          createdAt: Date.now(),
        });
        await this.membersMetaStore.writeMembers(
          request.teamName,
          effectiveMemberSpecs.map((m) => ({
            name: m.name.trim(),
            role: m.role?.trim() || undefined,
            workflow: m.workflow?.trim() || undefined,
            providerId: normalizeOptionalTeamProviderId(m.providerId),
            model: m.model?.trim() || undefined,
            effort:
              m.effort === 'low' || m.effort === 'medium' || m.effort === 'high'
                ? m.effort
                : undefined,
            agentType: 'general-purpose' as const,
            color: getMemberColorByName(m.name.trim()),
            joinedAt: Date.now(),
          }))
        );
        if (request.skipPermissions === false) {
          await this.seedTeammateOperationalPermissionRules(request.teamName, request.cwd);
        }

        child = spawnCli(claudePath, spawnArgs, {
          cwd: request.cwd,
          env: { ...shellEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        // Clean up pre-saved meta files if spawn failed (instant failure, not transient)
        await this.teamMetaStore.deleteMeta(request.teamName).catch(() => {});
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        const tasksDir = path.join(getTasksBasePath(), request.teamName);
        await fs.promises.rm(teamDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.rm(tasksDir, { recursive: true, force: true }).catch(() => {});
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        throw error;
      }

      updateProgress(run, 'spawning', 'Starting Claude CLI process', {
        pid: child.pid ?? undefined,
        warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
      });
      run.onProgress(run.progress);
      run.child = child;
      run.spawnContext = {
        claudePath,
        args: spawnArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt: initialUserPrompt,
      };

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

      // Reset AFTER spawn — not at run init — because async operations (buildProvisioningEnv,
      // writeConfigFile) between init and spawn can take seconds, causing false stall warnings.
      run.lastDataReceivedAt = Date.now();
      run.lastStdoutReceivedAt = Date.now();
      this.startStallWatchdog(run);

      // Filesystem-based progress monitor: actively polls team files instead
      // of relying on stdout (which only arrives at the end in text mode).
      // When config + members + tasks are all present, kill the process early
      // rather than waiting for it to deadlock on system-reminder shutdown.
      updateProgress(run, 'configuring', 'Waiting for team configuration...');
      run.onProgress(run.progress);
      this.startFilesystemMonitor(run, request);

      run.timeoutHandle = setTimeout(() => {
        if (!run.processKilled && !run.provisioningComplete) {
          run.processKilled = true;
          run.finalizingByTimeout = true;
          void (async () => {
            const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
            killTeamProcess(run.child);
            if (readyOnTimeout) {
              return; // cleanupRun already called inside tryCompleteAfterTimeout
            }

            const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI', {
              error:
                'Timed out waiting for CLI. Run `claude` once in terminal to complete onboarding and try again.',
              cliLogsTail: extractCliLogsFromRun(run),
            });
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, RUN_TIMEOUT_MS);

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI', {
          error: error.message,
          cliLogsTail: extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        this.cleanupRun(run);
      });

      child.once('exit', (code) => {
        void this.handleProcessExit(run, code);
      });

      return { runId };
    } catch (error) {
      // Ensure the per-team lock doesn't get stuck on failures.
      if (this.provisioningRunByTeam.get(request.teamName) === pendingKey) {
        this.provisioningRunByTeam.delete(request.teamName);
      }
      throw error;
    }
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return this.withTeamLock(request.teamName, async () => {
      return this._launchTeamInner(request, onProgress);
    });
  }

  private async _launchTeamInner(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    const existingProvisioningRunId = this.getProvisioningRunId(request.teamName);
    if (existingProvisioningRunId) {
      return { runId: existingProvisioningRunId };
    }
    assertAppDeterministicBootstrapEnabled();

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.provisioningRunByTeam.set(request.teamName, pendingKey);

    try {
      // Verify config.json exists — team must already be provisioned
      const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
      const configRaw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!configRaw) {
        throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
      }
      let configProjectPath: string | null = null;
      try {
        const parsedConfig = JSON.parse(configRaw) as { projectPath?: unknown };
        configProjectPath =
          typeof parsedConfig.projectPath === 'string' && parsedConfig.projectPath.trim().length > 0
            ? path.resolve(parsedConfig.projectPath.trim())
            : null;
      } catch {
        configProjectPath = null;
      }

      const existingAliveRunId = this.getAliveRunId(request.teamName);
      if (existingAliveRunId) {
        const existingRun = this.runs.get(existingAliveRunId);
        const requestedCwd = path.resolve(request.cwd);
        const existingRunCwd = this.getRunTrackedCwd(existingRun) ?? configProjectPath;
        if (existingRun?.child && !existingRun.processKilled && !existingRun.cancelRequested) {
          if (!existingRunCwd) {
            this.provisioningRunByTeam.delete(request.teamName);
            throw new Error(
              `Team "${request.teamName}" is already running, but its cwd could not be determined. ` +
                'Stop it before launching again.'
            );
          }
          if (existingRunCwd && existingRunCwd !== requestedCwd) {
            this.provisioningRunByTeam.delete(request.teamName);
            throw new Error(
              `Team "${request.teamName}" is already running in "${existingRunCwd}". ` +
                `Stop it before launching with cwd "${request.cwd}".`
            );
          }
          this.provisioningRunByTeam.delete(request.teamName);
          return { runId: existingAliveRunId };
        }
      }

      const {
        members: expectedMemberSpecs,
        source,
        warning,
      } = await this.resolveLaunchExpectedMembers(request.teamName, configRaw);
      const expectedMembers = expectedMemberSpecs.map((m) => m.name);

      // Extract leadSessionId for session resume on reconnect.
      // If a valid JSONL file exists for the previous session, we can resume it
      // so the lead retains full context of prior work.
      // When clearContext is true, skip resume entirely to start a fresh session.
      let previousSessionId: string | undefined;
      let skipResume = false;
      if (request.clearContext) {
        skipResume = true;
        logger.info(
          `[${request.teamName}] clearContext requested — skipping session resume, starting fresh`
        );
      } else {
        // Check persisted launch state: if the previous launch ended with no teammates
        // ever spawned (all in 'starting' state), resuming would reconnect the lead but
        // the CLI's deterministic bootstrap won't re-spawn dead teammates in reconnect
        // mode. Skip resume so the CLI creates a fresh session that fully bootstraps.
        const persistedLaunchState = await this.launchStateStore.read(request.teamName);
        if (persistedLaunchState) {
          const {
            expectedMembers: prevExpected,
            members: prevMembers,
            launchPhase,
          } = persistedLaunchState;
          const teammateWasNeverSpawned = (
            member:
              | {
                  agentToolAccepted?: boolean;
                  firstSpawnAcceptedAt?: string;
                  runtimeAlive?: boolean;
                  bootstrapConfirmed?: boolean;
                }
              | undefined
          ): boolean => {
            if (!member) return true;
            const hasAcceptedSpawn =
              member.agentToolAccepted === true ||
              (typeof member.firstSpawnAcceptedAt === 'string' &&
                member.firstSpawnAcceptedAt.trim().length > 0);
            return (
              !hasAcceptedSpawn &&
              member.runtimeAlive !== true &&
              member.bootstrapConfirmed !== true
            );
          };
          const allTeammatesNeverSpawned =
            launchPhase !== 'active' &&
            prevExpected.length > 0 &&
            prevExpected.every((name) => teammateWasNeverSpawned(prevMembers[name]));
          if (allTeammatesNeverSpawned) {
            skipResume = true;
            logger.info(
              `[${request.teamName}] Previous launch had no teammates successfully spawned — ` +
                `skipping session resume to allow full bootstrap`
            );
          }
        }
      }
      if (!skipResume) {
        try {
          const configParsed = JSON.parse(configRaw) as Record<string, unknown>;
          const resumeGuard = shouldSkipResumeForProviderRuntimeChange(request, configParsed);
          if (resumeGuard.skip) {
            logger.info(
              `[${request.teamName}] Skipping session resume — ${resumeGuard.reason ?? 'runtime changed'}`
            );
          } else if (
            typeof configParsed.leadSessionId === 'string' &&
            configParsed.leadSessionId.trim().length > 0
          ) {
            const candidateId = configParsed.leadSessionId.trim();
            const storedProjectPath =
              typeof configParsed.projectPath === 'string' &&
              configParsed.projectPath.trim().length > 0
                ? configParsed.projectPath.trim()
                : null;

            // Sessions are stored per-project (~/.claude/projects/{encodePath(cwd)}/).
            // If the project path changed, the old session JSONL won't be found by the CLI
            // at the new project directory. Skip resume to avoid passing an invalid --resume arg.
            if (
              storedProjectPath &&
              path.resolve(storedProjectPath) !== path.resolve(request.cwd)
            ) {
              logger.info(
                `[${request.teamName}] Project path changed: ${storedProjectPath} → ${request.cwd}. ` +
                  `Skipping session resume — sessions are per-project.`
              );
            } else {
              const resumeProjectPath = storedProjectPath ?? request.cwd;
              const projectId = encodePath(resumeProjectPath);
              const baseDir = extractBaseDir(projectId);
              const jsonlPath = path.join(getProjectsBasePath(), baseDir, `${candidateId}.jsonl`);
              if (await this.pathExists(jsonlPath)) {
                previousSessionId = candidateId;
                logger.info(
                  `[${request.teamName}] Found previous session JSONL for resume: ${candidateId}`
                );
              } else {
                logger.info(
                  `[${request.teamName}] Previous session JSONL not found at ${jsonlPath}, starting fresh`
                );
              }
            }
          }
        } catch {
          logger.debug(
            `[${request.teamName}] Failed to extract leadSessionId from config for resume`
          );
        }
      }

      // IMPORTANT: The CLI auto-suffixes teammate names when they already exist in config.json.
      // Normalize config.json to keep only the team-lead before spawning the CLI, so we get stable names.
      try {
        await this.normalizeTeamConfigForLaunch(request.teamName, configRaw);
        await this.assertConfigLeadOnlyForLaunch(request.teamName);

        // Update projectPath in config IMMEDIATELY so TeamDetailView shows the correct path
        // even if provisioning is interrupted or the user stops the team early.
        // If launch fails, restorePrelaunchConfig() will revert to the backup (old projectPath).
        await this.updateConfigProjectPath(request.teamName, request.cwd);
      } catch (error) {
        // Restore pre-launch backup so config.json is not left in normalized (lead-only) state.
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      let claudePath: string | null;
      try {
        await ensureCwdExists(request.cwd);

        claudePath = await ClaudeBinaryResolver.resolve();
        if (!claudePath) {
          throw new Error('Claude CLI not found; install it or provide a valid path');
        }
      } catch (error) {
        // Restore pre-launch backup so config.json is not left in normalized (lead-only) state
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
      const runId = randomUUID();
      const startedAt = nowIso();

      const provisioningEnv = await this.buildProvisioningEnv(request.providerId);
      const { env: shellEnv, geminiRuntimeAuth, warning: envWarning } = provisioningEnv;
      if (envWarning) {
        throw new Error(envWarning);
      }

      const effectiveMemberSpecs = await this.materializeEffectiveTeamMemberSpecs({
        claudePath,
        cwd: request.cwd,
        members: expectedMemberSpecs,
        defaults: {
          providerId: request.providerId,
          model: request.model,
          effort: request.effort,
        },
        primaryProviderId: request.providerId,
        primaryEnv: provisioningEnv,
        limitContext: request.limitContext,
      });

      // Build a synthetic TeamCreateRequest for reuse by shared infrastructure
      const syntheticRequest: TeamCreateRequest = {
        teamName: request.teamName,
        members: effectiveMemberSpecs,
        cwd: request.cwd,
        providerId: request.providerId,
        model: request.model,
        effort: request.effort,
        skipPermissions: request.skipPermissions,
      };

      // Enrich with color/displayName from config.json (always available for launched teams)
      try {
        const cfg = JSON.parse(configRaw) as Record<string, unknown>;
        if (typeof cfg.color === 'string' && cfg.color.trim().length > 0) {
          syntheticRequest.color = cfg.color.trim();
        }
        if (typeof cfg.name === 'string' && cfg.name.trim().length > 0) {
          syntheticRequest.displayName = cfg.name.trim();
        }
      } catch {
        // config already validated above — ignore parse errors here
      }

      const run: ProvisioningRun = {
        runId,
        teamName: request.teamName,
        startedAt,
        stdoutBuffer: '',
        stderrBuffer: '',
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        stdoutParserCarry: '',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: false,
        claudeLogsUpdatedAt: undefined,
        processKilled: false,
        finalizingByTimeout: false,
        cancelRequested: false,
        teamsBasePathsToProbe,
        child: null,
        timeoutHandle: null,
        fsMonitorHandle: null,
        onProgress,
        expectedMembers,
        request: syntheticRequest,
        effectiveMembers: effectiveMemberSpecs,
        lastLogProgressAt: 0,
        lastDataReceivedAt: 0, // intentionally 0 — real reset happens after spawn (see startStallWatchdog call sites)
        lastStdoutReceivedAt: 0,
        stallCheckHandle: null,
        stallWarningIndex: null,
        preStallMessage: null,
        lastRetryAt: 0,
        apiRetryWarningIndex: null,
        apiErrorWarningEmitted: false,
        waitingTasksSince: null,
        provisioningComplete: false,
        mcpConfigPath: null,
        bootstrapSpecPath: null,
        bootstrapUserPromptPath: null,
        isLaunch: true,
        deterministicBootstrap: true,
        fsPhase: 'waiting_members',
        leadRelayCapture: null,
        activeCrossTeamReplyHints: [],
        leadMsgSeq: 0,
        pendingToolCalls: [],
        activeToolCalls: new Map(),
        pendingDirectCrossTeamSendRefresh: false,
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        pendingInboxRelayCandidates: [],
        provisioningOutputParts: [],
        provisioningOutputIndexByMessageId: new Map(),
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        pendingApprovals: new Map(),
        processedPermissionRequestIds: new Set(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
        pendingGeminiPostLaunchHydration: false,
        geminiPostLaunchHydrationInFlight: false,
        geminiPostLaunchHydrationSent: false,
        suppressGeminiPostLaunchHydrationOutput: false,
        memberSpawnStatuses: new Map(
          expectedMembers.map((name) => [name, createInitialMemberSpawnStatusEntry()])
        ),
        memberSpawnToolUseIds: new Map(),
        lastDeterministicBootstrapSeq: 0,
        lastMemberSpawnAuditAt: 0,
        lastMemberSpawnAuditConfigReadWarningAt: 0,
        lastMemberSpawnAuditMissingWarningAt: new Map(),
        progress: {
          runId,
          teamName: request.teamName,
          state: 'validating',
          message:
            source === 'members-meta'
              ? 'Validating team launch request (members from members.meta.json)'
              : source === 'inboxes'
                ? 'Validating team launch request (members from inboxes)'
                : 'Validating team launch request (fallback members from config.json)',
          startedAt,
          updatedAt: startedAt,
          warnings: warning ? [warning] : undefined,
          cliLogsTail: undefined,
        },
      };

      this.runs.set(runId, run);
      this.provisioningRunByTeam.set(request.teamName, runId);
      run.onProgress(run.progress);
      await this.clearPersistedLaunchState(request.teamName);

      // Read existing tasks to include in teammate prompts for work resumption
      const taskReader = new TeamTaskReader();
      let existingTasks: TeamTask[] = [];
      try {
        existingTasks = await taskReader.getTasks(request.teamName);
      } catch (error) {
        logger.warn(
          `[${request.teamName}] Failed to read tasks for launch prompt: ${String(error)}`
        );
      }

      const prompt = buildDeterministicLaunchHydrationPrompt(
        request,
        effectiveMemberSpecs,
        existingTasks,
        Boolean(previousSessionId)
      );
      const promptSize = getPromptSizeSummary(prompt);
      let child: ReturnType<typeof spawn>;
      shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
      const teammateModeDecision = await resolveDesktopTeammateModeDecision(request.extraCliArgs);
      if (teammateModeDecision.forceProcessTeammates) {
        shellEnv.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1';
      }
      let mcpConfigPath: string;
      let bootstrapSpecPath: string;
      let bootstrapUserPromptPath: string | null = null;
      try {
        const bootstrapSpec = buildDeterministicLaunchBootstrapSpec(
          runId,
          request,
          effectiveMemberSpecs
        );
        bootstrapSpecPath = await writeDeterministicBootstrapSpecFile(bootstrapSpec);
        run.bootstrapSpecPath = bootstrapSpecPath;
        bootstrapUserPromptPath = await writeDeterministicBootstrapUserPromptFile(prompt);
        run.bootstrapUserPromptPath = bootstrapUserPromptPath;
        mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(request.cwd);
        run.mcpConfigPath = mcpConfigPath;
        await this.validateAgentTeamsMcpRuntime(claudePath, request.cwd, shellEnv, mcpConfigPath);
      } catch (error) {
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }
      const launchArgs = [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user,project,local',
        '--mcp-config',
        mcpConfigPath,
        '--team-bootstrap-spec',
        bootstrapSpecPath,
        ...(bootstrapUserPromptPath
          ? ['--team-bootstrap-user-prompt-file', bootstrapUserPromptPath]
          : []),
        '--disallowedTools',
        APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        // Explicit --permission-mode overrides user's defaultMode in ~/.claude/settings.json
        // (e.g. "acceptEdits") which otherwise takes precedence over CLI flags
        ...(request.skipPermissions !== false
          ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
      ];
      if (previousSessionId) {
        launchArgs.push('--resume', previousSessionId);
        logger.info(
          `[${request.teamName}] Launching with --resume ${previousSessionId} for session continuity`
        );
      }
      if (request.model) {
        launchArgs.push('--model', request.model);
      }
      if (request.effort) {
        launchArgs.push('--effort', request.effort);
      }
      if (request.worktree) {
        launchArgs.push('--worktree', request.worktree);
      }
      launchArgs.push(...parseCliArgs(request.extraCliArgs));
      const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      logRuntimeLaunchSnapshot(request.teamName, claudePath, launchArgs, request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      // --resume is added above when a valid previous session JSONL exists.
      // Without it, CLI creates a fresh session ID automatically.

      try {
        if (request.skipPermissions === false) {
          await this.seedTeammateOperationalPermissionRules(request.teamName, request.cwd);
        }
        child = spawnCli(claudePath, launchArgs, {
          cwd: request.cwd,
          env: { ...shellEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      const resumeHint = previousSessionId ? ' (resuming previous session)' : '';
      updateProgress(run, 'spawning', `Starting Claude CLI process for team launch${resumeHint}`, {
        pid: child.pid ?? undefined,
        warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
      });
      run.onProgress(run.progress);
      run.child = child;
      run.spawnContext = {
        claudePath,
        args: launchArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt,
      };

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

      // Reset AFTER spawn — not at run init — because async operations between init
      // and spawn can take seconds, causing false stall warnings.
      run.lastDataReceivedAt = Date.now();
      run.lastStdoutReceivedAt = Date.now();
      this.startStallWatchdog(run);

      // For launch, skip the filesystem monitor — files (config, inboxes, tasks)
      // already exist from the previous run and would trigger immediate false
      // completion on the first poll. Rely on stream-json result.success instead.
      updateProgress(run, 'configuring', 'CLI running — deterministic reconnect in progress');
      run.onProgress(run.progress);

      run.timeoutHandle = setTimeout(() => {
        if (!run.processKilled && !run.provisioningComplete) {
          run.processKilled = true;
          run.finalizingByTimeout = true;
          void (async () => {
            const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
            killTeamProcess(run.child);
            if (readyOnTimeout) {
              return;
            }

            const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI (launch)', {
              error: 'Timed out waiting for CLI during team launch.',
              cliLogsTail: extractCliLogsFromRun(run),
            });
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, RUN_TIMEOUT_MS);

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI (launch)', {
          error: error.message,
          cliLogsTail: extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        this.cleanupRun(run);
      });

      child.once('exit', (code) => {
        void this.handleProcessExit(run, code);
      });

      return { runId };
    } catch (error) {
      // Clean up pending key if failure occurred before runId was set
      if (this.provisioningRunByTeam.get(request.teamName) === pendingKey) {
        this.provisioningRunByTeam.delete(request.teamName);
      }
      throw error;
    }
  }

  async getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('Unknown runId');
    }
    return run.progress;
  }

  async cancelProvisioning(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error('Unknown runId');
    }
    if (
      !['spawning', 'configuring', 'assembling', 'finalizing', 'verifying'].includes(
        run.progress.state
      )
    ) {
      throw new Error('Provisioning cannot be cancelled in current state');
    }

    run.cancelRequested = true;
    run.processKilled = true;
    // SIGKILL: newer Claude CLI versions handle SIGTERM gracefully and delete
    // team files during cleanup. SIGKILL is uncatchable — files are preserved.
    killTeamProcess(run.child);
    const progress = updateProgress(run, 'cancelled', 'Provisioning cancelled by user');
    run.onProgress(progress);
    this.cleanupRun(run);
  }

  /**
   * Send a message to the team's lead process via stream-json stdin.
   * The lead will receive it as a new user turn and can delegate to teammates.
   */
  async sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    const runId = this.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    const contentBlocks: Record<string, unknown>[] = [{ type: 'text', text: message }];
    if (attachments?.length) {
      for (const att of attachments) {
        if (att.mimeType === 'application/pdf') {
          // PDF → document block with base64 source
          contentBlocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: att.data,
            },
            title: att.filename,
          });
        } else if (att.mimeType === 'text/plain') {
          // Text file → document block with text source (decode base64 → UTF-8)
          const decoded = Buffer.from(att.data, 'base64').toString('utf-8');
          if (decoded.includes('\uFFFD')) {
            // Non-UTF-8 file: fallback to base64 document to avoid garbled content
            contentBlocks.push({
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'text/plain',
                data: att.data,
              },
              title: att.filename,
            });
          } else {
            contentBlocks.push({
              type: 'document',
              source: {
                type: 'text',
                media_type: 'text/plain',
                data: decoded,
              },
              title: att.filename,
            });
          }
        } else {
          // Image (default) → image block
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mimeType,
              data: att.data,
            },
          });
        }
      }
    }

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
    });
    const stdin = run.child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.setLeadActivity(run, 'active');
  }

  /**
   * UNUSED (2026-03-23): teammates read their own inbox files directly via fs.watch,
   * so forwarding through the lead is unnecessary. Kept for reference — the prompt
   * pattern here ("MUST: ask teammate to reply back to user") was a useful finding
   * that informed the direct inbox approach.
   *
   * Original purpose: forward a user DM to a teammate by injecting a relay turn
   * into the lead's stdin and suppressing the lead's textual output.
   */
  async forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void> {
    const runId = this.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }
    if (!run.provisioningComplete) {
      // Don't inject extra turns during provisioning/bootstrap.
      return;
    }

    this.armSilentTeammateForward(run, teammateName, 'user_dm');

    const summaryLine = userSummary?.trim() ? `Summary: ${userSummary.trim()}` : null;
    const internal = wrapInAgentBlock(
      [
        `UI relay request — forward a direct message to teammate "${teammateName}".`,
        `MUST: ${getCanonicalSendMessageToolRule(teammateName)}`,
        `MUST: if they reply to the human, the destination must be to="user" (short answer).`,
        `CRITICAL: Do NOT send any message to="user" for this turn.`,
        getCanonicalSendMessageFieldRule(),
      ].join('\n')
    );
    const message = [
      `User DM relay (internal).`,
      internal,
      ``,
      `Message to forward:`,
      ...(summaryLine ? [summaryLine] : []),
      userText,
    ].join('\n');

    await this.sendMessageToTeam(teamName, message);
  }

  async relayMemberInboxMessages(teamName: string, memberName: string): Promise<number> {
    if (
      this.isCrossTeamPseudoRecipientName(memberName) ||
      this.isCrossTeamToolRecipientName(memberName)
    ) {
      return 0;
    }
    const relayKey = this.getMemberRelayKey(teamName, memberName);
    const existing = this.memberInboxRelayInFlight.get(relayKey);
    if (existing) {
      return existing;
    }

    const work = (async (): Promise<number> => {
      const runId = this.getAliveRunId(teamName);
      if (!runId) return 0;
      const run = this.runs.get(runId);
      if (!run?.child || run.processKilled || run.cancelRequested) return 0;
      if (!run.provisioningComplete) return 0;

      const relayedIds = this.relayedMemberInboxMessageIds.get(relayKey) ?? new Set<string>();

      let memberInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        memberInboxMessages = await this.inboxReader.getMessagesFor(teamName, memberName);
      } catch {
        return 0;
      }

      const unread = memberInboxMessages
        .filter((m): m is InboxMessage & { messageId: string } => {
          if (m.read) return false;
          if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
          if (!this.hasStableMessageId(m)) return false;
          return !relayedIds.has(m.messageId);
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      if (unread.length === 0) return 0;

      const relayView = buildRelayInboxView(unread);
      const silentNoiseUnread = relayView
        .filter(({ idle, isCoarseNoise }) => {
          if (idle) return idle.handling === 'silent_noise';
          return isCoarseNoise;
        })
        .map(({ message }) => message);
      const passiveIdleUnread = relayView
        .filter(({ idle }) => idle?.handling === 'passive_activity')
        .map(({ message }) => message);
      const actionableUnread = relayView
        .filter(({ idle, isCoarseNoise }) => {
          if (idle) return idle.handling === 'visible_actionable';
          return !isCoarseNoise;
        })
        .map(({ message }) => message);

      const readOnlyIgnoredUnread = [...silentNoiseUnread, ...passiveIdleUnread];

      if (readOnlyIgnoredUnread.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, memberName, readOnlyIgnoredUnread);
          if (passiveIdleUnread.length > 0) {
            logger.debug(
              `[${teamName}] member relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay for ${memberName}`
            );
          }
        } catch (error) {
          logger.debug(
            `[${teamName}] member relay failed to mark ${readOnlyIgnoredUnread.length} ignored inbox message(s) read for ${memberName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      if (actionableUnread.length === 0) return 0;

      const MAX_RELAY = 10;
      const batch = actionableUnread.slice(0, MAX_RELAY);

      this.armSilentTeammateForward(run, memberName, 'member_inbox_relay');
      const rememberedRelayIds = this.rememberPendingInboxRelayCandidates(run, memberName, batch);

      const message = [
        `Inbox relay (internal) — forward to "${memberName}".`,
        wrapInAgentBlock(
          [
            `CRITICAL: Do NOT send any message to="user" for this relay turn. The ONLY valid destination is to="${memberName}".`,
            getCanonicalSendMessageToolRule(memberName),
            getCanonicalSendMessageFieldRule(),
            `Preserve task IDs and critical instructions. Do NOT add extra narration outside the SendMessage calls.`,
            `If an inbox item is marked Source: system_notification, forward that notification exactly once without paraphrasing.`,
          ].join('\n')
        ),
        ``,
        `Messages to relay (DO NOT respond to user directly):`,
        ...batch.flatMap((m, idx) => {
          const summaryLine = m.summary?.trim() ? `Summary: ${m.summary.trim()}` : null;
          const crossTeamMeta =
            m.source === 'cross_team'
              ? {
                  origin: parseCrossTeamPrefix(m.text),
                  sourceTeam: m.from.includes('.') ? m.from.split('.', 1)[0] : null,
                }
              : null;
          const conversationId = m.conversationId ?? crossTeamMeta?.origin?.conversationId;
          const replyInstructions =
            crossTeamMeta?.sourceTeam && conversationId
              ? [
                  `   Cross-team conversationId: ${conversationId}`,
                  `   Call the MCP tool named cross_team_send with toTeam="${crossTeamMeta.sourceTeam}", conversationId="${conversationId}", and replyToConversationId="${conversationId}". Do NOT put "cross_team_send" into a SendMessage recipient or message_send "to" field.`,
                ]
              : [];
          return [
            `${idx + 1}) From: ${m.from || 'unknown'}`,
            `   Timestamp: ${m.timestamp}`,
            `   MessageId: ${m.messageId}`,
            ...(summaryLine ? [`   ${summaryLine}`] : []),
            ...(typeof m.source === 'string' && m.source.trim()
              ? [`   Source: ${m.source.trim()}`]
              : []),
            ...replyInstructions,
            `   Text:`,
            ...m.text.split('\n').map((line) => `   ${line}`),
            ``,
          ];
        }),
      ].join('\n');

      try {
        await this.sendMessageToTeam(teamName, message);
      } catch {
        this.forgetPendingInboxRelayCandidates(run, memberName, rememberedRelayIds);
        return 0;
      }

      for (const m of batch) {
        relayedIds.add(m.messageId);
      }
      this.relayedMemberInboxMessageIds.set(relayKey, this.trimRelayedSet(relayedIds));

      try {
        await this.markInboxMessagesRead(teamName, memberName, batch);
      } catch {
        // Best-effort: relay succeeded; marking read failed.
      }

      return batch.length;
    })();

    this.memberInboxRelayInFlight.set(relayKey, work);
    try {
      return await work;
    } finally {
      if (this.memberInboxRelayInFlight.get(relayKey) === work) {
        this.memberInboxRelayInFlight.delete(relayKey);
      }
    }
  }

  /**
   * Relay unread inbox messages addressed to the team lead into the live lead process.
   *
   * Why: teammates (and the UI) write to `inboxes/<lead>.json`, but the live lead CLI
   * process consumes new turns via stream-json stdin. Without relaying, the lead
   * appears unresponsive to direct messages.
   *
   * Returns the number of messages relayed.
   */
  private hasStableMessageId(
    message: InboxMessage
  ): message is InboxMessage & { messageId: string } {
    return typeof message.messageId === 'string' && message.messageId.trim().length > 0;
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    const existing = this.leadInboxRelayInFlight.get(teamName);
    if (existing) {
      return existing;
    }

    const work = (async (): Promise<number> => {
      const runId = this.getAliveRunId(teamName) ?? this.getProvisioningRunId(teamName);
      if (!runId) return 0;
      const run = this.runs.get(runId);
      if (!run?.child || run.processKilled || run.cancelRequested) return 0;

      // Permission request scan runs even during provisioning — teammates may need
      // tool approval before the lead's first turn completes. CLI marks inbox messages
      // as read after native delivery, so we must scan ALL messages (including read).
      let config: Awaited<ReturnType<TeamConfigReader['getConfig']>> | null = null;
      try {
        config = await this.configReader.getConfig(teamName);
      } catch {
        // config not ready yet during early provisioning — skip scan
      }
      if (config) {
        const leadName = config.members?.find((m) => isLeadMember(m))?.name?.trim() || 'team-lead';
        try {
          const leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
          const permMsgsToMarkRead: { messageId: string }[] = [];
          const runStartedAtMs = Date.parse(run.startedAt);
          for (const msg of leadInboxMessages) {
            if (typeof msg.text !== 'string') continue;
            const perm = parsePermissionRequest(msg.text);
            if (!perm) continue;
            // Skip permission_requests from previous runs — they're stale
            const msgTs = Date.parse(msg.timestamp);
            if (
              Number.isFinite(msgTs) &&
              Number.isFinite(runStartedAtMs) &&
              msgTs < runStartedAtMs
            ) {
              continue;
            }
            // Dedup is handled inside handleTeammatePermissionRequest via processedPermissionRequestIds
            this.handleTeammatePermissionRequest(run, perm, msg.timestamp);
            // Mark unread permission_request messages as read to prevent stale unread indicators
            if (!msg.read && this.hasStableMessageId(msg)) {
              permMsgsToMarkRead.push({ messageId: msg.messageId });
            }
          }
          if (permMsgsToMarkRead.length > 0) {
            await this.markInboxMessagesRead(teamName, leadName, permMsgsToMarkRead).catch(
              () => {}
            );
          }
        } catch {
          // best-effort — inbox may not exist yet
        }
      }

      if (!run.provisioningComplete) return 0;

      const relayedIds = this.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();

      // Re-read config if needed (already fetched above but guard provisioningComplete path)
      if (!config) {
        try {
          config = await this.configReader.getConfig(teamName);
        } catch {
          return 0;
        }
      }
      if (!config) return 0;

      const leadName = config.members?.find((m) => isLeadMember(m))?.name?.trim() || 'team-lead';
      let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
      } catch {
        return 0;
      }

      await this.refreshMemberSpawnStatusesFromLeadInbox(run);

      const unread = leadInboxMessages
        .filter((m): m is InboxMessage & { messageId: string } => {
          if (m.read) return false;
          if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
          if (!this.hasStableMessageId(m)) return false;
          return !relayedIds.has(m.messageId);
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      if (unread.length === 0) return 0;

      const relayView = buildRelayInboxView(unread);
      const silentIdleIds = new Set(
        relayView
          .filter(({ idle }) => idle?.handling === 'silent_noise')
          .map(({ message }) => message.messageId)
      );
      const passiveIdleIds = new Set(
        relayView
          .filter(({ idle }) => idle?.handling === 'passive_activity')
          .map(({ message }) => message.messageId)
      );
      const coarseNonIdleNoiseIds = new Set(
        relayView
          .filter(({ idle, isCoarseNoise }) => idle === null && isCoarseNoise)
          .map(({ message }) => message.messageId)
      );

      const latestOutboundByConversation = new Map<string, number>();
      const latestReadInboundByConversation = new Map<string, number>();
      for (const message of leadInboxMessages) {
        const timestampMs = Date.parse(message.timestamp);
        if (!Number.isFinite(timestampMs)) continue;
        if (message.source === CROSS_TEAM_SENT_SOURCE) {
          const conversationId = message.conversationId?.trim();
          const targetTeam = this.parseCrossTeamTargetTeam(message.to);
          if (!conversationId || !targetTeam) continue;
          const key = this.buildCrossTeamConversationKey(targetTeam, conversationId);
          latestOutboundByConversation.set(
            key,
            Math.max(latestOutboundByConversation.get(key) ?? 0, timestampMs)
          );
          continue;
        }
        if (message.source === CROSS_TEAM_SOURCE && message.read) {
          const conversationId =
            message.replyToConversationId?.trim() ??
            message.conversationId?.trim() ??
            parseCrossTeamPrefix(message.text)?.conversationId;
          const sourceTeam = this.getCrossTeamSourceTeam(message.from);
          if (!conversationId || !sourceTeam) continue;
          const key = this.buildCrossTeamConversationKey(sourceTeam, conversationId);
          latestReadInboundByConversation.set(
            key,
            Math.max(latestReadInboundByConversation.get(key) ?? 0, timestampMs)
          );
        }
      }
      const pendingHistoricalReplies = new Set(
        Array.from(latestOutboundByConversation.entries())
          .filter(([key, sentAtMs]) => sentAtMs > (latestReadInboundByConversation.get(key) ?? 0))
          .map(([key]) => key)
      );
      const pendingTransientReplies = this.getPendingCrossTeamReplyExpectationKeys(teamName);
      const matchedTransientReplyKeys = new Set<string>();

      const wasRecentlyDeliveredCrossTeam = (message: InboxMessage): boolean => {
        if (message.source !== CROSS_TEAM_SOURCE) return false;
        if (!this.hasStableMessageId(message)) return false;
        return this.wasRecentlyDeliveredToLead(teamName, message.messageId);
      };
      const isCrossTeamReplyToOwnOutbound = (message: InboxMessage): boolean => {
        if (message.source !== CROSS_TEAM_SOURCE) return false;
        const conversationId =
          message.replyToConversationId?.trim() ??
          message.conversationId?.trim() ??
          parseCrossTeamPrefix(message.text)?.conversationId;
        if (!conversationId) return false;
        const sourceTeam = this.getCrossTeamSourceTeam(message.from);
        if (!sourceTeam) return false;
        const key = this.buildCrossTeamConversationKey(sourceTeam, conversationId);
        if (pendingHistoricalReplies.has(key)) {
          return true;
        }
        if (pendingTransientReplies.has(key)) {
          matchedTransientReplyKeys.add(key);
          return true;
        }
        return false;
      };

      // Category 1: permanently ignored → mark as read.
      // Includes noise (idle/shutdown), cross-team sender copies, cross-team reply dedup.
      const permanentlyIgnored = unread.filter(
        (m) =>
          silentIdleIds.has(m.messageId) ||
          coarseNonIdleNoiseIds.has(m.messageId) ||
          m.source === CROSS_TEAM_SENT_SOURCE ||
          isCrossTeamReplyToOwnOutbound(m) ||
          wasRecentlyDeliveredCrossTeam(m)
      );
      if (permanentlyIgnored.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, permanentlyIgnored);
        } catch {
          // best-effort
        }
        for (const key of matchedTransientReplyKeys) {
          const [otherTeam, conversationId] = key.split('\0');
          if (otherTeam && conversationId) {
            this.clearPendingCrossTeamReplyExpectation(teamName, otherTeam, conversationId);
          }
        }
      }

      const passiveIdleUnread = unread.filter((m) => passiveIdleIds.has(m.messageId));
      if (passiveIdleUnread.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, passiveIdleUnread);
          logger.debug(
            `[${teamName}] lead relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay`
          );
        } catch (error) {
          logger.debug(
            `[${teamName}] lead relay failed to mark ${passiveIdleUnread.length} passive idle message(s) read: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      const readOnlyIgnoredIds = new Set([
        ...permanentlyIgnored.map((m) => m.messageId),
        ...passiveIdleUnread.map((m) => m.messageId),
      ]);
      const remainingUnread = unread.filter((m) => !readOnlyIgnoredIds.has(m.messageId));

      // Category 2: same-team native delivery confirmation (one-to-one pairing).
      const { nativeMatchedMessageIds, persisted: sameTeamPersisted } =
        await this.confirmSameTeamNativeMatches(teamName, leadName, remainingUnread);

      // Category 3: deferred by age — source-less messages within grace window of CURRENT run.
      // NOT marked read (crash safety: if native delivery fails, retry will relay).
      const runStartedAtMs = Date.parse(run.startedAt);
      const deferredByAge = remainingUnread.filter(
        (m) =>
          !nativeMatchedMessageIds.has(m.messageId) &&
          this.shouldDeferSameTeamMessage(m, leadName, runStartedAtMs)
      );
      const deferredIds = new Set(deferredByAge.map((m) => m.messageId));

      // Category 4: teammate permission requests — filter from actionable so they're
      // NOT relayed to the lead. The actual interception + ToolApprovalRequest emission
      // is handled by the early scan above (which checks processedPermissionRequestIds).
      const permissionRequestIds = new Set(
        remainingUnread
          .filter((m) => !deferredIds.has(m.messageId) && parsePermissionRequest(m.text) !== null)
          .map((m) => m.messageId)
      );

      // Actionable: everything not in any category.
      const actionableUnread = remainingUnread.filter(
        (m) =>
          !nativeMatchedMessageIds.has(m.messageId) &&
          !deferredIds.has(m.messageId) &&
          !permissionRequestIds.has(m.messageId)
      );

      // Layer 3: schedule retry timers.
      if (nativeMatchedMessageIds.size > 0 && !sameTeamPersisted) {
        this.scheduleSameTeamPersistRetry(teamName);
      }
      if (deferredByAge.length > 0) {
        this.scheduleSameTeamDeferredRetry(teamName);
      }

      if (actionableUnread.length === 0) return 0;

      const MAX_RELAY = 10;
      const batch = actionableUnread.slice(0, MAX_RELAY);
      const teammateRoster = (config.members ?? [])
        .filter((member) => {
          const name = member.name?.trim();
          return name && name !== leadName;
        })
        .map((member) => ({
          name: member.name.trim(),
          ...(member.role?.trim() ? { role: member.role.trim() } : {}),
        }));
      const rosterContextBlock = buildLeadRosterContextBlock(teamName, leadName, teammateRoster);
      run.activeCrossTeamReplyHints = batch.flatMap((m) => {
        if (m.source !== 'cross_team') return [];
        const sourceTeam = m.from.includes('.') ? m.from.split('.', 1)[0] : '';
        const conversationId = m.conversationId ?? parseCrossTeamPrefix(m.text)?.conversationId;
        if (!sourceTeam || !conversationId) return [];
        return [{ toTeam: sourceTeam, conversationId }];
      });

      const message = [
        `You have new inbox messages addressed to you (team lead "${leadName}").`,
        `Process them in order (oldest first).`,
        `If action is required, delegate via task creation or SendMessage, and keep responses minimal.`,
        `IMPORTANT: Your text response here is shown to the user.`,
        `If you actually take action, include a brief human-readable summary (e.g. "Delegated to carol.").`,
        `If there is no action to take, produce ZERO text output. Do NOT write "No action needed.", status echoes, or any other no-op summary.`,
        `For pure system notifications, comment notifications, or routine teammate availability updates that require no reply/comment/action, say nothing.`,
        `Do NOT respond with only an agent-only block.`,
        ...(rosterContextBlock ? [rosterContextBlock] : []),
        AGENT_BLOCK_OPEN,
        `Internal note: for task assignments, prefer task_create and rely on the board/runtime notification path instead of sending a separate SendMessage for the same assignment.`,
        `For any MCP board tool call in this turn, teamName MUST be "${teamName}". Never use the lead/member name "${leadName}" as teamName.`,
        `Use task_create_from_message only for messages below that explicitly say "Eligible for task_create_from_message: yes" and provide a User MessageId. Never use task_create_from_message for teammate messages, system notifications, cross-team messages, or any inbox row that is not explicitly marked eligible.`,
        `If a message below is marked Source: system_notification and its summary looks like "Comment on #...", reply via task_add_comment only when you have a substantive board update (decision, blocker, clarification answer, review result, or concrete next-step change).`,
        `Do NOT post acknowledgement-only task comments such as "Принято", "Ок", "На связи", "Жду", or similar low-signal echoes. If the task comment notification is FYI and no durable update is needed, say nothing.`,
        `If a message below is marked Source: cross_team, CALL the MCP tool named cross_team_send. Do NOT use SendMessage or message_send for cross-team replies.`,
        `NEVER set recipient="cross_team_send" or to="cross_team_send". "cross_team_send" is a tool name, not a teammate.`,
        AGENT_BLOCK_CLOSE,
        ``,
        `Messages:`,
        ...batch.flatMap((m, idx) => {
          const summaryLine = m.summary?.trim() ? `Summary: ${m.summary.trim()}` : null;
          const isTaskCreateFromMessageEligible = m.source === 'user_sent';
          const provenanceLines = isTaskCreateFromMessageEligible
            ? [`   Eligible for task_create_from_message: yes`, `   User MessageId: ${m.messageId}`]
            : [`   Eligible for task_create_from_message: no`];
          const crossTeamMeta =
            m.source === 'cross_team'
              ? {
                  origin: parseCrossTeamPrefix(m.text),
                  sourceTeam: m.from.includes('.') ? m.from.split('.', 1)[0] : null,
                }
              : null;
          const conversationId =
            m.replyToConversationId?.trim() ??
            m.conversationId ??
            crossTeamMeta?.origin?.conversationId;
          const replyInstructions =
            crossTeamMeta?.sourceTeam && conversationId
              ? [
                  `   Cross-team conversationId: ${conversationId}`,
                  `   Call the MCP tool named cross_team_send with toTeam="${crossTeamMeta.sourceTeam}", conversationId="${conversationId}", and replyToConversationId="${conversationId}". Do NOT use SendMessage or message_send. NEVER set recipient/to to "cross_team_send".`,
                ]
              : [];
          return [
            `${idx + 1}) From: ${m.from || 'unknown'}`,
            `   Timestamp: ${m.timestamp}`,
            ...(summaryLine ? [`   ${summaryLine}`] : []),
            ...(typeof m.source === 'string' && m.source.trim()
              ? [`   Source: ${m.source.trim()}`]
              : []),
            ...provenanceLines,
            ...replyInstructions,
            `   Text:`,
            ...m.text.split('\n').map((line) => `   ${line}`),
            ``,
          ];
        }),
      ].join('\n');

      const captureTimeoutMs = 15_000;
      const captureIdleMs = 800;
      const capturePromise = new Promise<string>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error('Timed out waiting for lead reply'));
        }, captureTimeoutMs);
        const capture = {
          leadName,
          startedAt: nowIso(),
          textParts: [] as string[],
          settled: false,
          idleHandle: null as NodeJS.Timeout | null,
          idleMs: captureIdleMs,
          timeoutHandle,
          resolveOnce: (text: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            resolve(text);
          },
          rejectOnce: (error: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            reject(new Error(error));
          },
        };
        run.leadRelayCapture = capture;
      });

      try {
        await this.sendMessageToTeam(teamName, message);
      } catch {
        if (run.leadRelayCapture) {
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
        return 0;
      }

      for (const m of batch) {
        relayedIds.add(m.messageId);
      }
      this.relayedLeadInboxMessageIds.set(teamName, this.trimRelayedSet(relayedIds));
      this.rememberRecentCrossTeamLeadDeliveryMessageIds(
        teamName,
        batch
          .filter((message) => message.source === CROSS_TEAM_SOURCE)
          .map((message) => message.messageId)
      );

      try {
        await this.markInboxMessagesRead(teamName, leadName, batch);
      } catch {
        // Best-effort: relay succeeded; marking read failed.
      }

      let replyText: string | null = null;
      try {
        replyText = (await capturePromise).trim() || null;
      } catch {
        // Best-effort: if we captured some text but never got result.success, keep it.
        const partial = run.leadRelayCapture?.textParts?.join('')?.trim();
        replyText = partial && partial.length > 0 ? partial : null;
      } finally {
        if (run.leadRelayCapture) {
          if (run.leadRelayCapture.idleHandle) {
            clearTimeout(run.leadRelayCapture.idleHandle);
            run.leadRelayCapture.idleHandle = null;
          }
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
      }

      // Strip agent-only blocks — lead may respond with pure coordination content
      // that is not meant for the human user.
      const cleanReply = replyText ? stripAgentBlocks(replyText) : null;
      if (cleanReply) {
        const relayMsg: InboxMessage = {
          from: leadName,
          to: 'user',
          text: cleanReply,
          timestamp: nowIso(),
          read: true,
          summary: cleanReply.length > 60 ? cleanReply.slice(0, 57) + '...' : cleanReply,
          messageId: `lead-process-${runId}-${Date.now()}`,
          source: 'lead_process',
        };
        this.pushLiveLeadProcessMessage(teamName, relayMsg);
        // Persist to disk so relayed replies survive app restart and trigger FileWatcher
        this.persistSentMessage(teamName, relayMsg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName,
          detail: 'lead-process-reply',
        });
      }

      return batch.length;
    })();

    this.leadInboxRelayInFlight.set(teamName, work);
    try {
      return await work;
    } finally {
      if (this.leadInboxRelayInFlight.get(teamName) === work) {
        this.leadInboxRelayInFlight.delete(teamName);
      }
    }
  }

  /**
   * Check if a team has an active provisioning run (started but not yet finished).
   */
  hasProvisioningRun(teamName: string): boolean {
    return this.provisioningRunByTeam.has(teamName);
  }

  /**
   * Check if a team has a live process.
   */
  isTeamAlive(teamName: string): boolean {
    const runId = this.getAliveRunId(teamName);
    if (!runId) return false;
    const run = this.runs.get(runId);
    return run?.child != null && !run.processKilled && !run.cancelRequested;
  }

  /**
   * Get list of teams with active processes.
   */
  getAliveTeams(): string[] {
    return Array.from(this.aliveRunByTeam.keys()).filter((name) => this.isTeamAlive(name));
  }

  async getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    const runId = this.getTrackedRunId(teamName);
    const run = runId ? (this.runs.get(runId) ?? null) : null;

    if (!run) {
      const recovered = await readBootstrapRuntimeState(teamName);
      if (recovered) {
        return recovered;
      }
    }

    return {
      teamName,
      isAlive: this.isTeamAlive(teamName),
      runId: run?.runId ?? runId ?? null,
      progress: run?.progress ?? null,
    };
  }

  private languageChangeInFlight: Promise<void> = Promise.resolve();

  /**
   * Notify alive teams when the agent language setting changes.
   * Compares each team's stored `config.language` with the new code and sends
   * a message to the team lead if they differ.
   *
   * Serialised: rapid language switches (e.g. ru → en → ru) are queued so that
   * only the latest value is applied to each team.
   */
  async notifyLanguageChange(newLangCode: string): Promise<void> {
    this.languageChangeInFlight = this.languageChangeInFlight.then(() =>
      this.doNotifyLanguageChange(newLangCode)
    );
    return this.languageChangeInFlight;
  }

  private async doNotifyLanguageChange(newLangCode: string): Promise<void> {
    const aliveTeams = this.getAliveTeams();
    if (aliveTeams.length === 0) return;

    const systemLocale = getSystemLocale();
    const newResolved = resolveLanguageName(newLangCode, systemLocale);

    for (const teamName of aliveTeams) {
      try {
        const config = await this.configReader.getConfig(teamName);
        if (!config) continue;

        const oldCode = config.language || 'system';
        if (oldCode === newLangCode) continue;

        // Compare resolved names to avoid spurious notifications
        // e.g. switching from 'ru' to 'system' when system locale is Russian
        const oldResolved = resolveLanguageName(oldCode, systemLocale);
        if (oldResolved === newResolved) {
          // Effective language unchanged — just update stored code silently
          await this.configReader.updateConfig(teamName, { language: newLangCode });
          continue;
        }

        const message =
          `The user has changed the preferred communication language from "${oldResolved}" to "${newResolved}". ` +
          `Please switch to ${newResolved} for all future responses and broadcast this change to all teammates ` +
          `so they also switch to ${newResolved}.`;

        await this.sendMessageToTeam(teamName, message);
        await this.configReader.updateConfig(teamName, { language: newLangCode });
        logger.info(`[${teamName}] Notified about language change: ${oldCode} → ${newLangCode}`);
      } catch (error) {
        logger.warn(
          `[${teamName}] Failed to notify language change: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private async markInboxMessagesRead(
    teamName: string,
    member: string,
    messages: { messageId: string }[]
  ): Promise<void> {
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${member}.json`);

    await withFileLock(inboxPath, async () => {
      await withInboxLock(inboxPath, async () => {
        const raw = await tryReadRegularFileUtf8(inboxPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_INBOX_MAX_BYTES,
        });
        if (!raw) {
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;

        const ids = new Set(messages.map((m) => m.messageId).filter((id) => id.trim().length > 0));

        let changed = false;
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const row = item as Record<string, unknown>;
          const msgId = getEffectiveInboxMessageId(row);
          if (!msgId || !ids.has(msgId)) continue;

          if (row.read !== true) {
            row.read = true;
            changed = true;
          }
        }

        if (!changed) return;
        await atomicWriteAsync(inboxPath, JSON.stringify(parsed, null, 2));
      });
    });
  }

  private trimRelayedSet(set: Set<string>): Set<string> {
    const MAX_IDS = 2000;
    if (set.size <= MAX_IDS) return set;
    const next = new Set<string>();
    const tail = Array.from(set).slice(-MAX_IDS);
    for (const id of tail) next.add(id);
    return next;
  }

  /**
   * Intercept SendMessage tool_use blocks from the lead's stream-json output.
   *
   * Claude Code's internal teamContext may be lost after session resume (--resume), causing
   * SendMessage routing to drift away from our canonical team artifacts. By capturing tool_use
   * calls directly from stdout, we persist a durable message row under the correct team name so
   * Messages stays accurate even if Claude's own routing is flaky.
   */
  /**
   * Intercept Task tool_use blocks that spawn team members.
   * Sets member spawn status to 'spawning' when the lead issues a Task call with team_name + name.
   */
  private captureTeamSpawnEvents(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    for (const part of content) {
      if (part.type !== 'tool_use' || part.name !== 'Agent') continue;
      const input = part.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;
      const teamName = typeof inp.team_name === 'string' ? inp.team_name.trim() : '';
      const memberName = typeof inp.name === 'string' ? inp.name.trim() : '';
      if (teamName && !memberName) {
        logger.warn(
          `[captureTeamSpawnEvents] Agent call for team "${run.teamName}" is missing name — ` +
            `runtime will spawn an ephemeral subagent instead of a persistent teammate`
        );
        continue;
      }
      if (!memberName) continue;
      if (!teamName) {
        logger.warn(
          `[captureTeamSpawnEvents] Agent call for "${memberName}" is missing team_name — ` +
            `teammate will be an ephemeral subagent, not a persistent member of "${run.teamName}"`
        );
        this.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          `Agent spawn for "${memberName}" is missing team_name — spawned as ephemeral subagent instead of persistent teammate`
        );
        continue;
      }
      // Only track spawns for this team
      if (teamName !== run.teamName) continue;
      const existing = run.memberSpawnStatuses.get(memberName);
      if (
        existing &&
        !existing.hardFailure &&
        (existing.bootstrapConfirmed || existing.runtimeAlive || existing.agentToolAccepted)
      ) {
        this.appendMemberBootstrapDiagnostic(
          run,
          memberName,
          'respawn blocked as duplicate — teammate already online'
        );
        continue;
      }
      this.setMemberSpawnStatus(run, memberName, 'spawning');
      const toolUseId = typeof part.id === 'string' ? part.id.trim() : '';
      if (toolUseId) {
        run.memberSpawnToolUseIds.set(toolUseId, memberName);
      }

      // Advance stepper to "Members joining" when first member spawn is detected
      if (
        !run.provisioningComplete &&
        (run.progress.state === 'configuring' || run.progress.state === 'spawning')
      ) {
        const progress = updateProgress(run, 'assembling', `Spawning member ${memberName}...`);
        run.onProgress(progress);
      }
    }
  }

  /**
   * Post-provisioning audit: read config.json members and flag any expectedMember
   * that was NOT registered by Claude Code as a team member.
   *
   * This is the ground-truth check — when Agent(team_name=X, name=Y) succeeds,
   * the CLI adds Y to config.json members[]. If a member is missing, the spawn
   * was incorrect (e.g., missing team_name/name params) and the agent ran as a
   * one-shot subagent instead of a persistent teammate.
   */
  private async getRegisteredTeamMemberNames(teamName: string): Promise<Set<string> | null> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        return null;
      }
      const config = JSON.parse(raw) as {
        members?: { name?: string; agentType?: string }[];
      };
      return new Set(
        (config.members ?? [])
          .map((m) => (typeof m.name === 'string' ? m.name.trim() : ''))
          .filter(Boolean)
      );
    } catch {
      return null;
    }
  }

  private async auditMemberSpawnStatuses(run: ProvisioningRun): Promise<void> {
    if (!run.expectedMembers || run.expectedMembers.length === 0) return;

    // Read config.json to get the actual registered members
    const registeredNames = await this.getRegisteredTeamMemberNames(run.teamName);
    if (!registeredNames) {
      const now = Date.now();
      if (
        shouldWarnOnUnreadableMemberAuditConfig({
          nowMs: now,
          lastWarnAt: run.lastMemberSpawnAuditConfigReadWarningAt,
          expectedMembers: run.expectedMembers,
          memberSpawnStatuses: run.memberSpawnStatuses,
        })
      ) {
        run.lastMemberSpawnAuditConfigReadWarningAt = now;
        logger.warn(`[${run.teamName}] auditMemberSpawnStatuses: config.json not readable`);
      }
      return;
    }

    const liveAgentNames = this.getLiveTeamAgentNames(run.teamName);

    // Flag any expected member not found in config.json (excluding the lead)
    for (const expected of run.expectedMembers) {
      const current = run.memberSpawnStatuses.get(expected);
      if (
        current?.launchState === 'failed_to_start' ||
        current?.launchState === 'confirmed_alive'
      ) {
        continue;
      }

      const matchedRuntimeNames = [...registeredNames].filter((name) => {
        if (name === expected) return true;
        const parsed = parseNumericSuffixName(name);
        return parsed !== null && parsed.suffix >= 2 && parsed.base === expected;
      });

      const runtimeAlive =
        liveAgentNames.has(expected) ||
        matchedRuntimeNames.some((runtimeName) => liveAgentNames.has(runtimeName));

      // A teammate may intentionally stay silent after bootstrap. If Claude Code
      // registered the runtime and the OS process is still alive, treat it as
      // process-confirmed running. Keep this distinct from heartbeat-confirmed online.
      if (runtimeAlive) {
        this.setMemberSpawnStatus(run, expected, 'online', undefined, 'process');
        continue;
      }

      if (matchedRuntimeNames.length > 0) {
        if (current?.agentToolAccepted) {
          this.setMemberSpawnStatus(run, expected, 'waiting');
        }
        continue;
      }

      const acceptedAtMs =
        current?.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const graceExpired =
        current?.agentToolAccepted === true &&
        Number.isFinite(acceptedAtMs) &&
        Date.now() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;

      if (current?.agentToolAccepted && !graceExpired) {
        this.setMemberSpawnStatus(run, expected, 'waiting');
        continue;
      }

      const now = Date.now();
      const lastWarnAt = run.lastMemberSpawnAuditMissingWarningAt.get(expected) ?? 0;
      if (
        shouldWarnOnMissingRegisteredMember({
          nowMs: now,
          lastWarnAt,
          graceExpired,
        })
      ) {
        run.lastMemberSpawnAuditMissingWarningAt.set(expected, now);
        logger.warn(
          `[${run.teamName}] Member "${expected}" not found in config.json members after provisioning`
        );
      }
      if (graceExpired) {
        this.setMemberSpawnStatus(
          run,
          expected,
          'error',
          'Teammate not registered after provisioning within the launch grace window.'
        );
      }
    }
  }

  private async finalizeMissingRegisteredMembersAsFailed(run: ProvisioningRun): Promise<void> {
    if (!run.expectedMembers || run.expectedMembers.length === 0) return;
    const registeredNames = await this.getRegisteredTeamMemberNames(run.teamName);
    if (!registeredNames) {
      return;
    }

    for (const expected of run.expectedMembers) {
      const matchedRuntimeNames = [...registeredNames].filter((name) => {
        if (name === expected) return true;
        const parsed = parseNumericSuffixName(name);
        return parsed !== null && parsed.suffix >= 2 && parsed.base === expected;
      });

      if (matchedRuntimeNames.length > 0) {
        continue;
      }

      const current = run.memberSpawnStatuses.get(expected);
      if (
        current?.launchState === 'failed_to_start' ||
        current?.bootstrapConfirmed ||
        current?.runtimeAlive
      ) {
        continue;
      }

      this.setMemberSpawnStatus(
        run,
        expected,
        'error',
        'Teammate was not registered in config.json during launch. Persistent spawn failed.'
      );
    }
  }

  private hasLiveTeamAgentProcess(teamName: string, memberName: string): boolean {
    return this.getLiveTeamAgentRuntimeMetadata(teamName).has(memberName);
  }

  private attachLiveRuntimeMetadataToStatuses(
    teamName: string,
    statuses: Record<string, MemberSpawnStatusEntry>
  ): void {
    for (const [memberName, metadata] of this.getLiveTeamAgentRuntimeMetadata(teamName).entries()) {
      const current = statuses[memberName];
      if (!current || !metadata.model) {
        continue;
      }
      statuses[memberName] = {
        ...current,
        runtimeModel: metadata.model,
      };
    }
  }

  private getLiveTeamAgentNames(teamName: string): Set<string> {
    return new Set(this.getLiveTeamAgentRuntimeMetadata(teamName).keys());
  }

  private getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Map<string, LiveTeamAgentRuntimeMetadata> {
    if (process.platform === 'win32') {
      return new Map();
    }

    let output = '';
    try {
      output = execFileSync('ps', ['-ax', '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return new Map();
    }

    const teamMarker = `--team-name ${teamName}`;
    const metadataByAgent = new Map<string, LiveTeamAgentRuntimeMetadata>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.includes(teamMarker)) continue;
      const match = /--agent-id\s+([^\s@]+)@/.exec(trimmed);
      if (!match) continue;
      const agentName = match[1]?.trim();
      if (agentName) {
        const model = extractCliFlagValue(trimmed, '--model');
        metadataByAgent.set(agentName, {
          ...(model ? { model } : {}),
        });
      }
    }
    return metadataByAgent;
  }

  private async clearPersistedLaunchState(teamName: string): Promise<void> {
    await this.launchStateStore.clear(teamName);
    await clearBootstrapState(teamName);
  }

  private getFailedSpawnMembers(
    run: ProvisioningRun
  ): { name: string; error?: string; updatedAt: string }[] {
    const memberSpawnStatuses = run.memberSpawnStatuses ?? new Map();
    return [...memberSpawnStatuses.entries()]
      .filter(([, entry]) => entry.launchState === 'failed_to_start')
      .map(([name, entry]) => ({
        name,
        error: entry.hardFailureReason ?? entry.error,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private getMemberLaunchSummary(run: ProvisioningRun): {
    confirmedCount: number;
    pendingCount: number;
    failedCount: number;
    runtimeAlivePendingCount: number;
  } {
    const expectedMembers = run.expectedMembers ?? [];
    const memberSpawnStatuses = run.memberSpawnStatuses ?? new Map();
    let confirmedCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let runtimeAlivePendingCount = 0;
    for (const expected of expectedMembers) {
      const entry = memberSpawnStatuses.get(expected) ?? createInitialMemberSpawnStatusEntry();
      if (entry.launchState === 'confirmed_alive') {
        confirmedCount += 1;
        continue;
      }
      if (entry.launchState === 'failed_to_start') {
        failedCount += 1;
        continue;
      }
      pendingCount += 1;
      if (entry.runtimeAlive) {
        runtimeAlivePendingCount += 1;
      }
    }
    return { confirmedCount, pendingCount, failedCount, runtimeAlivePendingCount };
  }

  private buildPendingBootstrapStatusMessage(
    prefix: string,
    run: ProvisioningRun,
    launchSummary: {
      confirmedCount: number;
      pendingCount: number;
      runtimeAlivePendingCount: number;
    }
  ): string {
    const stillStartingCount = Math.max(
      0,
      launchSummary.pendingCount - launchSummary.runtimeAlivePendingCount
    );
    if (launchSummary.confirmedCount === 0) {
      const allRuntimeAlive =
        launchSummary.runtimeAlivePendingCount > 0 &&
        launchSummary.runtimeAlivePendingCount === run.expectedMembers.length;
      return allRuntimeAlive
        ? `${prefix} — teammates online`
        : launchSummary.runtimeAlivePendingCount > 0
          ? `${prefix} — ${launchSummary.runtimeAlivePendingCount}/${run.expectedMembers.length} teammate${launchSummary.runtimeAlivePendingCount === 1 ? '' : 's'} online${stillStartingCount > 0 ? `, ${stillStartingCount} still starting` : ''}`
          : `${prefix} — teammates are still starting`;
    }

    return `${prefix} — ${launchSummary.confirmedCount}/${run.expectedMembers.length} teammates made contact${launchSummary.runtimeAlivePendingCount > 0 ? `, ${launchSummary.runtimeAlivePendingCount} teammate${launchSummary.runtimeAlivePendingCount === 1 ? '' : 's'} online` : ''}${stillStartingCount > 0 ? `${launchSummary.runtimeAlivePendingCount > 0 ? ', ' : ', '}${stillStartingCount} still joining` : ''}`;
  }

  private buildRuntimeSpawnStatusRecord(
    run: ProvisioningRun
  ): Record<string, MemberSpawnStatusEntry> {
    const statuses: Record<string, MemberSpawnStatusEntry> = {};
    for (const expected of run.expectedMembers) {
      statuses[expected] =
        run.memberSpawnStatuses.get(expected) ?? createInitialMemberSpawnStatusEntry();
    }
    return statuses;
  }

  private async persistLaunchStateSnapshot(
    run: ProvisioningRun,
    launchPhase: 'active' | 'finished' | 'reconciled' = run.provisioningComplete
      ? 'finished'
      : 'active'
  ): Promise<void> {
    if (!run.isLaunch || !run.expectedMembers || run.expectedMembers.length === 0) {
      if (run.isLaunch) {
        await this.clearPersistedLaunchState(run.teamName);
      }
      return;
    }

    const snapshot = snapshotFromRuntimeMemberStatuses({
      teamName: run.teamName,
      expectedMembers: run.expectedMembers,
      leadSessionId: run.detectedSessionId ?? undefined,
      launchPhase,
      statuses: this.buildRuntimeSpawnStatusRecord(run),
    });

    if (snapshot.teamLaunchState === 'clean_success' && launchPhase !== 'active') {
      await this.clearPersistedLaunchState(run.teamName);
      return;
    }

    await this.launchStateStore.write(run.teamName, snapshot);
  }

  private async reconcilePersistedLaunchState(teamName: string): Promise<{
    snapshot: ReturnType<typeof createPersistedLaunchSnapshot> | null;
    statuses: Record<string, MemberSpawnStatusEntry>;
  }> {
    const bootstrapSnapshot = await readBootstrapLaunchSnapshot(teamName);
    const persisted = await this.launchStateStore.read(teamName);
    const preferredSnapshot = choosePreferredLaunchSnapshot(bootstrapSnapshot, persisted);
    if (preferredSnapshot && preferredSnapshot === bootstrapSnapshot) {
      return {
        snapshot: preferredSnapshot,
        statuses: snapshotToMemberSpawnStatuses(preferredSnapshot),
      };
    }
    if (!persisted) {
      return { snapshot: null, statuses: {} };
    }

    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    let configMembers = new Set<string>();
    let leadName = 'team-lead';
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (raw) {
        const config = JSON.parse(raw) as {
          members?: { name?: string; agentType?: string }[];
        };
        leadName = config.members?.find((member) => isLeadMember(member))?.name?.trim() || leadName;
        configMembers = new Set(
          (config.members ?? [])
            .map((member) => (typeof member?.name === 'string' ? member.name.trim() : ''))
            .filter((name) => name.length > 0 && !isLeadMember({ name }))
        );
      }
    } catch {
      // best-effort
    }

    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      // best-effort
    }

    const liveAgentNames = this.getLiveTeamAgentNames(teamName);
    const nextMembers = { ...persisted.members };
    const now = nowIso();
    for (const expected of persisted.expectedMembers) {
      const current = nextMembers[expected] ?? {
        name: expected,
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: now,
      };
      const matchedRuntimeNames = [...configMembers].filter((name) => {
        if (name === expected) return true;
        const parsed = parseNumericSuffixName(name);
        return parsed !== null && parsed.suffix >= 2 && parsed.base === expected;
      });
      const runtimeAlive =
        liveAgentNames.has(expected) ||
        matchedRuntimeNames.some((runtimeName) => liveAgentNames.has(runtimeName));
      const heartbeatMessage = leadInboxMessages.find((message) => {
        if (typeof message.from !== 'string' || message.from.trim() !== expected) return false;
        if (
          typeof message.text !== 'string' ||
          !isMeaningfulBootstrapCheckInMessage(message.text)
        ) {
          return false;
        }
        const firstAcceptedAt = current.firstSpawnAcceptedAt
          ? Date.parse(current.firstSpawnAcceptedAt)
          : NaN;
        const messageTs = Date.parse(message.timestamp);
        if (
          Number.isFinite(firstAcceptedAt) &&
          Number.isFinite(messageTs) &&
          messageTs < firstAcceptedAt
        ) {
          return false;
        }
        return true;
      });
      const heartbeatReason = heartbeatMessage
        ? extractBootstrapFailureReason(heartbeatMessage.text)
        : null;
      const acceptedAtMs =
        current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      current.runtimeAlive = runtimeAlive;
      current.lastRuntimeAliveAt = runtimeAlive ? now : current.lastRuntimeAliveAt;
      current.sources = {
        ...(current.sources ?? {}),
        processAlive: runtimeAlive || undefined,
        configRegistered: matchedRuntimeNames.length > 0 || undefined,
        configDrift:
          heartbeatMessage != null && matchedRuntimeNames.length === 0
            ? true
            : current.sources?.configDrift,
        inboxHeartbeat: heartbeatMessage != null ? true : current.sources?.inboxHeartbeat,
      };
      if (heartbeatReason) {
        current.hardFailure = true;
        current.hardFailureReason = heartbeatReason;
        current.sources.hardFailureSignal = true;
      } else if (heartbeatMessage) {
        current.bootstrapConfirmed = true;
        current.lastHeartbeatAt = heartbeatMessage.timestamp;
        current.hardFailure = false;
        current.hardFailureReason = undefined;
      }
      if (!current.bootstrapConfirmed && !current.hardFailure) {
        const transcriptFailureReason = await this.findBootstrapTranscriptFailureReason(
          teamName,
          expected,
          Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
        );
        if (transcriptFailureReason) {
          current.hardFailure = true;
          current.hardFailureReason = transcriptFailureReason;
          current.sources.hardFailureSignal = true;
        }
      }
      const graceExpired =
        current.agentToolAccepted === true &&
        Number.isFinite(acceptedAtMs) &&
        Date.now() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;
      if (
        !current.bootstrapConfirmed &&
        !current.runtimeAlive &&
        !current.hardFailure &&
        graceExpired
      ) {
        current.hardFailure = true;
        current.hardFailureReason =
          current.hardFailureReason ?? 'Teammate did not join within the launch grace window.';
      }
      current.launchState = deriveMemberLaunchState(current);
      current.lastEvaluatedAt = now;
      nextMembers[expected] = {
        ...current,
        diagnostics: undefined,
      };
    }

    const reconciled = createPersistedLaunchSnapshot({
      teamName,
      expectedMembers: persisted.expectedMembers,
      leadSessionId: persisted.leadSessionId,
      launchPhase: persisted.launchPhase === 'active' ? 'active' : 'reconciled',
      members: nextMembers,
      updatedAt: now,
    });

    if (reconciled.teamLaunchState === 'clean_success') {
      await this.clearPersistedLaunchState(teamName);
      return { snapshot: null, statuses: {} };
    }

    await this.launchStateStore.write(teamName, reconciled);
    return {
      snapshot: reconciled,
      statuses: snapshotToMemberSpawnStatuses(reconciled),
    };
  }

  private async findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    let summaries: Awaited<ReturnType<TeamMemberLogsFinder['findMemberLogs']>>;
    try {
      summaries = await this.memberLogsFinder.findMemberLogs(teamName, memberName, sinceMs);
    } catch {
      return null;
    }

    for (const summary of summaries) {
      if (!summary.filePath) continue;
      const reason = await this.readRecentBootstrapFailureReason(
        summary.filePath,
        sinceMs,
        memberName
      );
      if (reason) {
        return reason;
      }
    }

    return this.findBootstrapFailureReasonInProjectRoot(teamName, memberName, sinceMs);
  }

  private async readRecentBootstrapFailureReason(
    filePath: string,
    sinceMs: number | null,
    memberName?: string
  ): Promise<string | null> {
    let handle: fs.promises.FileHandle | null = null;
    const normalizedMemberName = memberName?.trim().toLowerCase() || null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
      const start = Math.max(0, stat.size - TeamProvisioningService.BOOTSTRAP_FAILURE_TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      if (buffer.length === 0) {
        return null;
      }
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start > 0) {
        lines.shift();
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) continue;
        let parsed: { timestamp?: unknown } | null = null;
        try {
          parsed = JSON.parse(line) as { timestamp?: unknown };
        } catch {
          continue;
        }
        const timestampMs =
          typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
        if (sinceMs != null && Number.isFinite(timestampMs) && timestampMs < sinceMs) {
          continue;
        }
        if (normalizedMemberName) {
          const parsedAgentName =
            typeof (parsed as { agentName?: unknown }).agentName === 'string'
              ? (parsed as { agentName?: string }).agentName?.trim().toLowerCase() || null
              : null;
          if (parsedAgentName && parsedAgentName !== normalizedMemberName) {
            continue;
          }
        }
        const text = extractTranscriptMessageText(parsed);
        if (!text) continue;
        const reason = extractBootstrapFailureReason(text);
        if (reason) {
          return reason;
        }
      }
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    return null;
  }

  private async findBootstrapFailureReasonInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    let config: Awaited<ReturnType<TeamConfigReader['getConfig']>>;
    try {
      config = await this.configReader.getConfig(teamName);
    } catch {
      return null;
    }
    const projectPath = config?.projectPath?.trim();
    if (!projectPath) {
      return null;
    }

    const projectDir = path.join(getProjectsBasePath(), extractBaseDir(encodePath(projectPath)));
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of jsonlFiles) {
      if (config?.leadSessionId && entry.name === `${config.leadSessionId}.jsonl`) {
        continue;
      }
      const reason = await this.readRecentBootstrapFailureReason(
        path.join(projectDir, entry.name),
        sinceMs,
        memberName
      );
      if (reason) {
        return reason;
      }
    }

    return null;
  }

  private captureSendMessages(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    for (const part of content) {
      if (part.type !== 'tool_use' || typeof part.name !== 'string') continue;
      const isNativeSendMessage = part.name === 'SendMessage';
      const isTeamMessageSendTool = part.name === 'mcp__agent-teams__message_send';
      const isDirectCrossTeamSendTool =
        part.name === 'mcp__agent-teams__cross_team_send' || part.name === 'cross_team_send';
      if (!isNativeSendMessage && !isTeamMessageSendTool && !isDirectCrossTeamSendTool) continue;
      const input = part.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;

      if (isDirectCrossTeamSendTool) {
        const toTeam = typeof inp.toTeam === 'string' ? inp.toTeam.trim() : '';
        const text = typeof inp.text === 'string' ? stripAgentBlocks(inp.text).trim() : '';
        if (toTeam && text) {
          run.pendingDirectCrossTeamSendRefresh = true;
        }
        continue;
      }

      const recipient = isNativeSendMessage
        ? typeof inp.recipient === 'string'
          ? inp.recipient
          : ''
        : typeof inp.to === 'string'
          ? inp.to
          : '';
      if (!recipient.trim()) continue;

      const msgContent = isNativeSendMessage
        ? typeof inp.content === 'string'
          ? inp.content
          : ''
        : typeof inp.text === 'string'
          ? inp.text
          : '';
      if (msgContent.trim().length === 0) continue;

      const summary = typeof inp.summary === 'string' ? inp.summary : '';
      const leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';

      const cleanContent = stripAgentBlocks(msgContent);
      if (cleanContent.trim().length === 0) continue;
      const strippedCrossTeamContent = stripCrossTeamPrefix(cleanContent).trim();
      if (strippedCrossTeamContent.length === 0) continue;
      const localRecipientNames = new Set(
        (run.request.members ?? [])
          .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
          .filter((name) => name.length > 0)
      );
      localRecipientNames.add('user');
      localRecipientNames.add('team-lead');

      const mistakenToolHint = this.isCrossTeamToolRecipientName(recipient)
        ? this.resolveSingleActiveCrossTeamReplyHint(run)
        : null;
      const crossTeamRecipient =
        this.parseCrossTeamRecipient(run.teamName, recipient, localRecipientNames) ??
        (mistakenToolHint ? { teamName: mistakenToolHint.toTeam, memberName: 'team-lead' } : null);
      if (crossTeamRecipient && this.crossTeamSender) {
        const inferredReplyMeta =
          mistakenToolHint?.toTeam === crossTeamRecipient.teamName
            ? {
                conversationId: mistakenToolHint.conversationId,
                replyToConversationId: mistakenToolHint.conversationId,
              }
            : this.resolveCrossTeamReplyMetadata(run.teamName, crossTeamRecipient.teamName);
        const crossTeamMeta = parseCrossTeamPrefix(cleanContent);
        const replyMeta = inferredReplyMeta;
        const timestamp = nowIso();
        const messageId = `lead-sendmsg-${run.runId}-${Date.now()}`;

        void this.crossTeamSender({
          fromTeam: run.teamName,
          fromMember: leadName,
          toTeam: crossTeamRecipient.teamName,
          text: strippedCrossTeamContent,
          summary,
          messageId,
          timestamp,
          conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
          replyToConversationId:
            replyMeta?.replyToConversationId ??
            crossTeamMeta?.conversationId ??
            replyMeta?.conversationId,
        })
          .then((result) => {
            if (result.deduplicated) {
              return;
            }
            const msg: InboxMessage = {
              from: leadName,
              to: recipient.startsWith('cross-team:')
                ? recipient
                : this.isCrossTeamToolRecipientName(recipient)
                  ? `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`
                  : `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`,
              text: strippedCrossTeamContent,
              timestamp,
              read: true,
              summary:
                (summary || strippedCrossTeamContent).length > 60
                  ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
                  : summary || strippedCrossTeamContent,
              messageId: result.messageId,
              source: 'cross_team_sent',
              conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
              replyToConversationId:
                replyMeta?.replyToConversationId ??
                crossTeamMeta?.conversationId ??
                replyMeta?.conversationId,
            };
            this.pushLiveLeadProcessMessage(run.teamName, msg);
            this.teamChangeEmitter?.({
              type: 'lead-message',
              teamName: run.teamName,
              runId: run.runId,
              detail: 'cross-team-send',
            });
          })
          .catch((error: unknown) => {
            logger.warn(
              `[${run.teamName}] qualified SendMessage→${recipient} cross-team fallback failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        continue;
      }

      if (this.isCrossTeamToolRecipientName(recipient)) {
        continue;
      }

      if (!isNativeSendMessage) {
        continue;
      }

      // Suppress SendMessage(to="user") during member_inbox_relay.
      // Context: when relaying inbox messages, the lead sometimes ignores the relay
      // instruction and responds to the user directly instead of forwarding to the
      // target teammate. This filter prevents that wrong response from appearing
      // in the UI and being persisted to sentMessages.json.
      // Note: teammate DM relay is currently disabled (see teams.ts handleSendMessage
      // and index.ts FileWatcher). This guard is kept as safety net in case relay
      // is re-enabled in the future.
      if (recipient === 'user' && run.silentUserDmForward?.mode === 'member_inbox_relay') {
        logger.debug(
          `[${run.teamName}] Suppressed SendMessage→user during member_inbox_relay to "${run.silentUserDmForward.target}"`
        );
        continue;
      }

      const relayOfMessageId =
        recipient !== 'user'
          ? this.consumePendingInboxRelayCandidate(
              run,
              recipient,
              strippedCrossTeamContent,
              summary
            )
          : undefined;

      const msg: InboxMessage = {
        from: leadName,
        to: recipient,
        text: strippedCrossTeamContent,
        timestamp: nowIso(),
        read: recipient !== 'user',
        summary:
          (summary || strippedCrossTeamContent).length > 60
            ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
            : summary || strippedCrossTeamContent,
        messageId: `lead-sendmsg-${run.runId}-${Date.now()}`,
        ...(relayOfMessageId ? { relayOfMessageId } : {}),
        source: 'lead_process',
      };

      this.pushLiveLeadProcessMessage(run.teamName, msg);

      if (recipient === 'user') {
        // User-directed messages go to sentMessages.json (canonical outbound store)
        this.persistSentMessage(run.teamName, msg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: 'sentMessages.json',
        });
      } else {
        // Non-user messages go to canonical recipient inbox for relay delivery
        this.persistInboxMessage(run.teamName, recipient, msg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: `inboxes/${recipient}.json`,
        });
      }

      logger.debug(
        `[${run.teamName}] Captured SendMessage→${recipient} from stdout: ${cleanContent.slice(0, 100)}`
      );
    }
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    // Enrich with leadSessionId if missing — needed for session boundary separators
    if (!message.leadSessionId) {
      const runId = this.getTrackedRunId(teamName);
      if (runId) {
        const run = this.runs.get(runId);
        if (run?.detectedSessionId) {
          message.leadSessionId = run.detectedSessionId;
        }
      }
    }
    const MAX = 100;
    const list = this.liveLeadProcessMessages.get(teamName) ?? [];
    const id = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    if (id) {
      const existingIdx = list.findIndex((m) => (m.messageId ?? '').trim() === id);
      if (existingIdx >= 0) {
        list[existingIdx] = message;
      } else {
        list.push(message);
      }
    } else {
      list.push(message);
    }
    if (list.length > MAX) {
      list.splice(0, list.length - MAX);
    }
    this.liveLeadProcessMessages.set(teamName, list);
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    const runId = this.getAliveRunId(teamName);
    if (!runId) return null;
    const run = this.runs.get(runId);
    const hints = run?.activeCrossTeamReplyHints ?? [];
    if (hints.length === 0) return null;

    const matches = hints.filter((hint) => hint.toTeam === toTeam);
    if (matches.length !== 1) return null;

    return {
      conversationId: matches[0].conversationId,
      replyToConversationId: matches[0].conversationId,
    };
  }

  /**
   * Create an InboxMessage from assistant text and push it into the live cache.
   * Used for both pre-ready (provisioning) and post-ready assistant text.
   * Emits a coalesced `lead-message` event for renderer refresh.
   */
  private getStableLeadThoughtMessageId(msg: Record<string, unknown>): string | null {
    const entryUuid = typeof msg.uuid === 'string' ? msg.uuid.trim() : '';
    if (entryUuid) {
      return `lead-thought-${entryUuid}`;
    }

    const message = (msg.message ?? msg) as Record<string, unknown>;
    const assistantMessageId = typeof message.id === 'string' ? message.id.trim() : '';
    if (assistantMessageId) {
      return `lead-thought-msg-${assistantMessageId}`;
    }

    return null;
  }

  private appendProvisioningAssistantText(
    run: ProvisioningRun,
    msg: Record<string, unknown>,
    text: string
  ): void {
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }

    const stableMessageId = this.getStableLeadThoughtMessageId(msg);
    if (stableMessageId) {
      const existingIndex = run.provisioningOutputIndexByMessageId.get(stableMessageId);
      if (existingIndex != null) {
        run.provisioningOutputParts[existingIndex] = text;
        return;
      }
    }

    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === normalized) {
      return;
    }

    const newIndex = run.provisioningOutputParts.push(text) - 1;
    if (stableMessageId) {
      run.provisioningOutputIndexByMessageId.set(stableMessageId, newIndex);
    }
  }

  private shiftProvisioningOutputIndexesAfterRemoval(
    run: ProvisioningRun,
    removedIndex: number
  ): void {
    for (const [messageId, index] of run.provisioningOutputIndexByMessageId.entries()) {
      if (index > removedIndex) {
        run.provisioningOutputIndexByMessageId.set(messageId, index - 1);
      }
    }
  }

  private pushLiveLeadTextMessage(
    run: ProvisioningRun,
    cleanText: string,
    stableMessageId?: string
  ): void {
    run.leadMsgSeq += 1;
    const leadName = this.getRunLeadName(run);
    const messageId = stableMessageId || `lead-turn-${run.runId}-${run.leadMsgSeq}`;
    // Attach accumulated tool call details from preceding tool_use messages, then reset.
    const toolCalls = run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
    const toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
    run.pendingToolCalls = [];
    const leadMsg: InboxMessage = {
      from: leadName,
      text: cleanText,
      timestamp: nowIso(),
      read: true,
      summary: cleanText.length > 60 ? cleanText.slice(0, 57) + '...' : cleanText,
      messageId,
      source: 'lead_process',
      toolSummary,
      toolCalls,
    };
    this.pushLiveLeadProcessMessage(run.teamName, leadMsg);

    // Coalesced refresh: at most one event per LEAD_TEXT_EMIT_THROTTLE_MS per team.
    const now = Date.now();
    if (now - run.lastLeadTextEmitMs >= TeamProvisioningService.LEAD_TEXT_EMIT_THROTTLE_MS) {
      run.lastLeadTextEmitMs = now;
      this.teamChangeEmitter?.({
        type: 'lead-message',
        teamName: run.teamName,
        runId: run.runId,
        detail: 'lead-text',
      });
    }
  }

  /**
   * Stop the running process for a team. No-op if team is not running.
   * Always uses SIGKILL via killTeamProcess() to prevent CLI cleanup.
   */
  stopTeam(teamName: string): void {
    this.stopPersistentTeamMembers(teamName);

    const runId = this.getTrackedRunId(teamName);
    if (!runId) {
      return;
    }
    const run = this.runs.get(runId);
    if (!run) {
      this.provisioningRunByTeam.delete(teamName);
      this.aliveRunByTeam.delete(teamName);
      return;
    }
    if (run.processKilled || run.cancelRequested) {
      return;
    }
    run.processKilled = true;
    run.cancelRequested = true;
    killTeamProcess(run.child);
    const progress = updateProgress(run, 'disconnected', 'Team stopped by user');
    run.onProgress(progress);
    this.cleanupRun(run);
    logger.info(`[${teamName}] Process stopped (SIGKILL)`);
  }

  private stopPersistentTeamMembers(teamName: string): void {
    const members = this.readPersistedRuntimeMembers(teamName);
    if (members.length > 0) {
      this.killPersistedPaneMembers(teamName, members);
    }
    this.killOrphanedTeamAgentProcesses(teamName);
  }

  private readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[] {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { members?: unknown };
      if (!Array.isArray(parsed.members)) {
        return [];
      }
      return parsed.members.filter((member): member is PersistedRuntimeMemberLike => {
        return !!member && typeof member === 'object';
      });
    } catch {
      return [];
    }
  }

  private listPersistedTeamNames(): string[] {
    try {
      return fs
        .readdirSync(getTeamsBasePath(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name.trim())
        .filter((name) => name.length > 0);
    } catch {
      return [];
    }
  }

  private killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): void {
    for (const member of members) {
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      const paneId = typeof member.tmuxPaneId === 'string' ? member.tmuxPaneId.trim() : '';
      const backendType =
        typeof member.backendType === 'string' ? member.backendType.trim().toLowerCase() : '';
      if (!name || name === 'team-lead' || !paneId || backendType !== 'tmux') {
        continue;
      }
      try {
        killTmuxPaneForCurrentPlatformSync(paneId);
        logger.info(`[${teamName}] Killed teammate pane ${name} (${paneId}) during stop`);
      } catch (error) {
        logger.debug(
          `[${teamName}] Failed to kill teammate pane ${name} (${paneId}) during stop: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private killOrphanedTeamAgentProcesses(teamName: string): void {
    if (process.platform === 'win32') {
      return;
    }

    let output = '';
    try {
      output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return;
    }

    const currentRunPid = this.getTrackedRunId(teamName)
      ? this.runs.get(this.getTrackedRunId(teamName)!)?.child?.pid
      : undefined;
    const marker = `--team-name ${teamName}`;
    const pids = new Set<number>();

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(marker) || !trimmed.includes('--agent-id')) {
        continue;
      }
      const match = /^(\d+)\s+(.*)$/.exec(trimmed);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (currentRunPid && pid === currentRunPid) continue;
      pids.add(pid);
    }

    for (const pid of pids) {
      try {
        killProcessByPid(pid);
        logger.info(`[${teamName}] Killed orphaned teammate process pid=${pid} during stop`);
      } catch (error) {
        logger.debug(
          `[${teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  /**
   * Stop all running team processes. Called during app shutdown.
   * Uses killTeamProcess() (SIGKILL) to guarantee instant death
   * without CLI cleanup that would delete team files.
   */
  stopAllTeams(): void {
    const alive = this.getAliveTeams();
    if (alive.length > 0) {
      logger.info(`Killing all team processes on shutdown (SIGKILL): ${alive.join(', ')}`);
      for (const teamName of alive) {
        this.stopTeam(teamName);
      }
    }

    const persistedTeamNames = this.listPersistedTeamNames();
    const orphanOnly = persistedTeamNames.filter((teamName) => !alive.includes(teamName));
    if (orphanOnly.length > 0) {
      logger.info(`Cleaning up persisted teammate runtimes on shutdown: ${orphanOnly.join(', ')}`);
      for (const teamName of orphanOnly) {
        this.stopPersistentTeamMembers(teamName);
      }
    }
  }

  /**
   * Process a parsed stream-json message from stdout.
   * Extracts assistant text for progress reporting and detects turn completion.
   */
  private handleDeterministicBootstrapEvent(
    run: ProvisioningRun,
    msg: Record<string, unknown>
  ): boolean {
    if (msg.type !== 'system' || msg.subtype !== 'team_bootstrap') {
      return false;
    }

    const acceptance = shouldAcceptDeterministicBootstrapEvent({
      runId: run.runId,
      teamName: run.teamName,
      lastSeq: run.lastDeterministicBootstrapSeq,
      msg,
    });
    if (!acceptance.accept) {
      return true;
    }
    run.lastDeterministicBootstrapSeq = acceptance.nextSeq;

    const event = typeof msg.event === 'string' ? msg.event : undefined;
    if (!event) {
      return true;
    }

    if (event === 'started') {
      const progress = updateProgress(run, 'configuring', 'Starting deterministic team bootstrap');
      run.onProgress(progress);
      return true;
    }

    if (event === 'phase_changed') {
      const phase = typeof msg.phase === 'string' ? msg.phase : '';
      if (phase === 'loading_existing_state') {
        const progress = updateProgress(run, 'configuring', 'Loading existing team state');
        run.onProgress(progress);
      } else if (phase === 'acquiring_bootstrap_lock') {
        const progress = updateProgress(
          run,
          'configuring',
          'Acquiring deterministic bootstrap lock'
        );
        run.onProgress(progress);
      } else if (phase === 'creating_team') {
        const progress = updateProgress(run, 'assembling', 'Creating team config');
        run.onProgress(progress);
      } else if (phase === 'spawning_members') {
        const progress = updateProgress(run, 'assembling', 'Spawning teammate runtimes');
        run.onProgress(progress);
      } else if (phase === 'auditing_truth') {
        const progress = updateProgress(
          run,
          'finalizing',
          'Auditing registered teammates and bootstrap truth',
          { configReady: true }
        );
        run.onProgress(progress);
      }
      return true;
    }

    if (event === 'team_created') {
      const reused = msg.reused_existing_team === true;
      const progress = updateProgress(
        run,
        'assembling',
        reused
          ? 'Attached to existing team, starting teammates'
          : 'Team config created, starting teammates',
        { configReady: true }
      );
      run.onProgress(progress);
      return true;
    }

    if (event === 'member_spawn_started') {
      const memberName = typeof msg.member_name === 'string' ? msg.member_name.trim() : '';
      if (memberName) {
        this.setMemberSpawnStatus(run, memberName, 'spawning');
      }
      return true;
    }

    if (event === 'member_spawn_result') {
      const memberName = typeof msg.member_name === 'string' ? msg.member_name.trim() : '';
      const outcome = typeof msg.outcome === 'string' ? msg.outcome : '';
      const reason = typeof msg.reason === 'string' ? msg.reason.trim() : undefined;
      if (!memberName) {
        return true;
      }

      if (outcome === 'failed') {
        this.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          reason || 'Deterministic bootstrap failed to spawn teammate.'
        );
        return true;
      }

      if (outcome === 'already_running') {
        this.setMemberSpawnStatus(run, memberName, 'online', undefined, 'process');
        return true;
      }

      this.setMemberSpawnStatus(run, memberName, 'waiting');
      return true;
    }

    if (event === 'completed') {
      const failedMembers = Array.isArray(msg.failed_members) ? msg.failed_members : [];
      for (const failed of failedMembers) {
        const memberName = typeof failed?.name === 'string' ? failed.name.trim() : '';
        const reason = typeof failed?.reason === 'string' ? failed.reason.trim() : undefined;
        if (memberName) {
          this.setMemberSpawnStatus(
            run,
            memberName,
            'error',
            reason || 'Deterministic bootstrap failed to spawn teammate.'
          );
        }
      }
      if (!run.provisioningComplete && !run.cancelRequested) {
        void this.handleProvisioningTurnComplete(run).catch((error: unknown) => {
          logger.error(
            `[${run.teamName}] deterministic bootstrap completion handler failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
      return true;
    }

    if (event === 'failed') {
      if (run.progress.state === 'failed' || run.cancelRequested) {
        return true;
      }
      const reason =
        typeof msg.reason === 'string' && msg.reason.trim().length > 0
          ? msg.reason.trim()
          : 'Deterministic bootstrap failed.';
      const classification = classifyDeterministicBootstrapFailure(reason);
      const progress = updateProgress(run, 'failed', classification.title, {
        error: classification.normalizedReason,
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      run.processKilled = true;
      killTeamProcess(run.child);
      this.cleanupRun(run);
      return true;
    }

    return true;
  }

  private handleStreamJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    // stream-json output has various message types:
    // {"type":"assistant","content":[{"type":"text","text":"..."},...]}
    // {"type":"result","subtype":"success",...}
    if (msg.type === 'user') {
      // Check for permission_request in raw user message text BEFORE teammate-message parsing.
      // The permission_request may arrive as plain JSON without <teammate-message> wrapper,
      // and handleNativeTeammateUserMessage only processes <teammate-message> blocks.
      const rawUserText = this.extractStreamUserText(msg);
      const content = this.extractStreamContentBlocks(msg);
      if (rawUserText) {
        const perm = parsePermissionRequest(rawUserText);
        if (perm) {
          logger.warn(
            `[${run.teamName}] [PERM-TRACE] Intercepted permission_request from stdout user message: agent=${perm.agentId} tool=${perm.toolName} requestId=${perm.requestId}`
          );
          this.handleTeammatePermissionRequest(run, perm, new Date().toISOString());
        } else if (rawUserText.includes('permission_request')) {
          // Log near-miss: text contains "permission_request" but wasn't parsed
          logger.warn(
            `[${run.teamName}] [PERM-TRACE] stdout user message contains "permission_request" but parsePermissionRequest returned null. Text preview: ${rawUserText.slice(0, 300)}`
          );
        }
      }
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        this.finishRuntimeToolActivity(
          run,
          block.tool_use_id,
          block.content,
          block.is_error === true
        );
      }
      this.handleNativeTeammateUserMessage(run, msg);
      return;
    }
    if (msg.type === 'assistant') {
      const content = this.extractStreamContentBlocks(msg);

      const hasCapturedVisibleMessageToUser = this.hasCapturedVisibleMessageToUser(content);

      const textParts = content
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string);
      if (textParts.length > 0) {
        const text = textParts.join('\n');
        // Auth failures sometimes show up as assistant text (e.g. "401", "Please run /login")
        // rather than stderr or a result.subtype=error. Detect early to avoid false "ready".
        this.handleAuthFailureInOutput(run, text, 'assistant');
        if (this.hasApiError(text) && !this.isAuthFailureWarning(text, 'assistant')) {
          this.failProvisioningWithApiError(run, text);
          return;
        }
        logger.debug(`[${run.teamName}] assistant: ${text.slice(0, 200)}`);
        // During provisioning (before provisioningComplete), accumulate for live UI preview.
        // Emission is handled by the throttled emitLogsProgress() in the stdout data handler.
        if (!run.provisioningComplete) {
          this.appendProvisioningAssistantText(run, msg, text);
        }

        // Once relay capture is settled, later assistant chunks belong to the normal live
        // message flow. Keeping them in the capture branch would drop them on the floor
        // until relayLeadInboxMessages() finally clears run.leadRelayCapture.
        if (run.leadRelayCapture && !run.leadRelayCapture.settled) {
          const capture = run.leadRelayCapture;
          capture.textParts.push(text);
          if (capture.idleHandle) {
            clearTimeout(capture.idleHandle);
          }
          capture.idleHandle = setTimeout(() => {
            const combined = capture.textParts.join('\n').trim();
            capture.resolveOnce(combined);
          }, capture.idleMs);
        } else if (run.provisioningComplete) {
          // Push each assistant text block as a separate live message (per-message pattern).
          // When the same assistant message includes a user-visible message send, skip text —
          // captureSendMessages() handles the visible outbound message separately.
          if (
            !run.silentUserDmForward &&
            !run.suppressPostCompactReminderOutput &&
            !run.suppressGeminiPostLaunchHydrationOutput &&
            !hasCapturedVisibleMessageToUser
          ) {
            const cleanText = stripAgentBlocks(text).trim();
            if (cleanText.length > 0) {
              this.pushLiveLeadTextMessage(
                run,
                cleanText,
                this.getStableLeadThoughtMessageId(msg) ?? undefined
              );
            }
          }
        } else {
          // Pre-ready: keep showing provisioning narration in the banner, but also mirror it
          // into the live cache so Messages/Activity can show the earliest assistant output.
          if (!run.silentUserDmForward && !hasCapturedVisibleMessageToUser) {
            const cleanText = stripAgentBlocks(text).trim();
            if (cleanText.length > 0) {
              this.pushLiveLeadTextMessage(
                run,
                cleanText,
                this.getStableLeadThoughtMessageId(msg) ?? undefined
              );
            }
          }
        }
      }

      // Accumulate tool_use details from tool-only messages (text + tool_use are separate in stream-json).
      // These details will be attached to the next text message as toolCalls/toolSummary.
      // Works in both pre-ready and post-ready phases so early live messages get tool metadata.
      for (const block of content) {
        if (
          block?.type === 'tool_use' &&
          typeof block.name === 'string' &&
          block.name !== 'SendMessage'
        ) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          run.pendingToolCalls.push({
            name: block.name,
            preview: extractToolPreview(block.name, input),
            toolUseId: typeof block.id === 'string' ? block.id : undefined,
          });
          this.startRuntimeToolActivity(run, this.getRunLeadName(run), block);
        }
      }

      // Track member spawn events from Task tool_use blocks with team_name.
      // When the lead calls Task(team_name=X, name=Y), it means member Y is being spawned.
      this.captureTeamSpawnEvents(run, content);

      // Capture SendMessage tool_use blocks from assistant output.
      // Works in both pre-ready and post-ready phases so outbound runtime messages
      // are visible in our team message artifacts even if Claude's own routing drifts.
      if (!run.silentUserDmForward || run.silentUserDmForward.mode === 'member_inbox_relay') {
        this.captureSendMessages(run, content);
      }

      // Extract context window usage from message.usage for real-time tracking.
      // SDKAssistantMessage wraps BetaMessage which contains usage stats.
      const messageObj = (msg.message ?? msg) as Record<string, unknown>;
      if (messageObj && typeof messageObj === 'object') {
        const msgId = typeof messageObj.id === 'string' ? messageObj.id : null;
        const usage = messageObj.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') {
          // Dedup: skip if same message.id (SDK bug: multi-block = same usage repeated)
          if (!msgId || run.leadContextUsage?.lastUsageMessageId !== msgId) {
            const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
            const cacheCreation =
              typeof usage.cache_creation_input_tokens === 'number'
                ? usage.cache_creation_input_tokens
                : 0;
            const cacheRead =
              typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
            // Total context window usage = all three token categories
            // input_tokens = tokens AFTER last cache breakpoint (small)
            // cache_creation = tokens written to cache (first request)
            // cache_read = tokens read from cache (subsequent requests) — these ARE in context window
            const currentTokens = inputTokens + cacheCreation + cacheRead;

            if (!run.leadContextUsage) {
              // Determine initial context window from model selection
              // computeEffectiveTeamModel() defaults to 'opus[1m]' when no model selected
              const modelStr = (run.request.model ?? '').toLowerCase();
              const isHaiku = modelStr.includes('haiku');
              const isLimitedContext = run.request.limitContext === true;
              // limitContext=true → 200K, haiku → 200K, [1m] → 1M, default → 1M (opus[1m])
              const initialContextWindow = isLimitedContext || isHaiku ? 200_000 : 1_000_000;

              run.leadContextUsage = {
                currentTokens,
                contextWindow: initialContextWindow,
                lastUsageMessageId: msgId,
                lastEmittedAt: 0,
              };
            } else {
              run.leadContextUsage.currentTokens = currentTokens;
              run.leadContextUsage.lastUsageMessageId = msgId;
            }
            this.emitLeadContextUsage(run);
          }
        }
      }
    }

    // Capture session_id from any message type (first occurrence wins)
    if (!run.detectedSessionId) {
      const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      if (sid && sid.trim().length > 0) {
        run.detectedSessionId = sid.trim();
        logger.info(
          `[${run.teamName}] Detected session ID from stream-json: ${run.detectedSessionId}`
        );
      }
    }

    if (this.handleDeterministicBootstrapEvent(run, msg)) {
      return;
    }

    // Handle control_request — tool approval protocol (only when --dangerously-skip-permissions is NOT set)
    if (msg.type === 'control_request') {
      this.handleControlRequest(run, msg);
      return;
    }

    if (msg.type === 'result') {
      const subtype =
        typeof msg.subtype === 'string'
          ? msg.subtype
          : (() => {
              const result = msg.result;
              if (!result || typeof result !== 'object') return undefined;
              const inner = (result as Record<string, unknown>).subtype;
              return typeof inner === 'string' ? inner : undefined;
            })();
      if (subtype === 'success') {
        logger.info(`[${run.teamName}] stream-json result: success — turn complete, process alive`);

        // Extract contextWindow from modelUsage if available (SDKResultSuccess.modelUsage)
        const modelUsageObj = (msg.modelUsage ??
          (msg.result as Record<string, unknown> | undefined)?.modelUsage) as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (modelUsageObj && typeof modelUsageObj === 'object') {
          for (const modelData of Object.values(modelUsageObj)) {
            if (
              modelData &&
              typeof modelData === 'object' &&
              typeof modelData.contextWindow === 'number' &&
              modelData.contextWindow > 0
            ) {
              if (!run.leadContextUsage) {
                run.leadContextUsage = {
                  currentTokens: 0,
                  contextWindow: modelData.contextWindow,
                  lastUsageMessageId: null,
                  lastEmittedAt: 0,
                };
              } else {
                run.leadContextUsage.contextWindow = modelData.contextWindow;
                run.leadContextUsage.lastEmittedAt = 0; // force re-emit
              }
              this.emitLeadContextUsage(run);
              break;
            }
          }
        }

        // Extract usage from result message itself (final turn usage)
        const resultUsage = (msg.usage ??
          (msg.result as Record<string, unknown> | undefined)?.usage) as
          | Record<string, unknown>
          | undefined;
        if (resultUsage && typeof resultUsage === 'object') {
          const inp = typeof resultUsage.input_tokens === 'number' ? resultUsage.input_tokens : 0;
          const cc =
            typeof resultUsage.cache_creation_input_tokens === 'number'
              ? resultUsage.cache_creation_input_tokens
              : 0;
          const cr =
            typeof resultUsage.cache_read_input_tokens === 'number'
              ? resultUsage.cache_read_input_tokens
              : 0;
          const total = inp + cc + cr;
          if (total > 0) {
            if (!run.leadContextUsage) {
              run.leadContextUsage = {
                currentTokens: total,
                contextWindow: 0,
                lastUsageMessageId: null,
                lastEmittedAt: 0,
              };
            } else {
              run.leadContextUsage.currentTokens = total;
              run.leadContextUsage.lastEmittedAt = 0;
            }
            this.emitLeadContextUsage(run);
          }
        }

        if (run.provisioningComplete) {
          // If this was a post-compact reminder turn completing, clear in-flight and suppress flags.
          // Preserve pendingPostCompactReminder if re-armed by a compact_boundary during this turn.
          if (run.postCompactReminderInFlight) {
            const hadPendingRearm = run.pendingPostCompactReminder;
            run.postCompactReminderInFlight = false;
            run.suppressPostCompactReminderOutput = false;
            logger.info(
              `[${run.teamName}] post-compact reminder turn completed${
                hadPendingRearm ? ' (follow-up reminder pending from re-compact)' : ''
              }`
            );
          }
          if (run.geminiPostLaunchHydrationInFlight) {
            run.geminiPostLaunchHydrationInFlight = false;
            run.suppressGeminiPostLaunchHydrationOutput = false;
            logger.info(`[${run.teamName}] Gemini post-launch hydration turn completed`);
          }

          this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
          this.setLeadActivity(run, 'idle');
        }
        if (run.pendingDirectCrossTeamSendRefresh) {
          run.pendingDirectCrossTeamSendRefresh = false;
          this.teamChangeEmitter?.({
            type: 'inbox',
            teamName: run.teamName,
            detail: 'sentMessages.json',
          });
        }
        if (run.leadRelayCapture) {
          const capture = run.leadRelayCapture;
          const combined = capture.textParts.join('\n').trim();
          capture.resolveOnce(combined);
        }
        // Clear silent relay flag after any successful turn.
        run.activeCrossTeamReplyHints = [];
        run.pendingInboxRelayCandidates = [];
        run.silentUserDmForward = null;
        if (run.silentUserDmForwardClearHandle) {
          clearTimeout(run.silentUserDmForwardClearHandle);
          run.silentUserDmForwardClearHandle = null;
        }

        // Deferred post-compact context reinjection: inject durable rules on first idle after compact.
        // Placed AFTER leadRelayCapture/silentUserDmForward cleanup so a previously-deferred
        // reminder can proceed now that the blocking conditions are cleared.
        if (
          run.provisioningComplete &&
          run.pendingPostCompactReminder &&
          !run.postCompactReminderInFlight
        ) {
          void this.injectPostCompactReminder(run);
        }
        if (
          run.provisioningComplete &&
          run.pendingGeminiPostLaunchHydration &&
          !run.geminiPostLaunchHydrationInFlight
        ) {
          void this.injectGeminiPostLaunchHydration(run);
        }

        if (!run.provisioningComplete && !run.cancelRequested) {
          void this.handleProvisioningTurnComplete(run).catch((err: unknown) => {
            logger.error(
              `[${run.teamName}] handleProvisioningTurnComplete threw unexpectedly: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
        }
      } else if (subtype === 'error') {
        const errorMsg =
          typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? 'unknown');
        logger.warn(`[${run.teamName}] stream-json result: error — ${errorMsg}`);
        if (run.leadRelayCapture) {
          run.leadRelayCapture.rejectOnce(errorMsg);
        }
        // Clear silent relay flag after any errored turn.
        run.pendingDirectCrossTeamSendRefresh = false;
        run.activeCrossTeamReplyHints = [];
        run.pendingInboxRelayCandidates = [];
        run.silentUserDmForward = null;
        if (run.silentUserDmForwardClearHandle) {
          clearTimeout(run.silentUserDmForwardClearHandle);
          run.silentUserDmForwardClearHandle = null;
        }
        if (!run.provisioningComplete && !run.cancelRequested) {
          const progress = updateProgress(
            run,
            'failed',
            'CLI reported an error during provisioning',
            {
              error: errorMsg,
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          // Kill the process on provisioning error
          run.processKilled = true;
          killTeamProcess(run.child);
          this.cleanupRun(run);
        } else if (run.provisioningComplete) {
          // Post-provisioning error: process alive, waiting for input.
          // Always clear all post-compact reminder state on error — prevents a stale pending
          // reminder from firing on the next unrelated successful turn.
          if (run.pendingPostCompactReminder || run.postCompactReminderInFlight) {
            const wasInFlight = run.postCompactReminderInFlight;
            clearPostCompactReminderState(run);
            logger.warn(
              `[${run.teamName}] post-compact reminder ${wasInFlight ? 'turn errored' : 'pending dropped'} — clearing (strict policy)`
            );
          }
          if (run.pendingGeminiPostLaunchHydration || run.geminiPostLaunchHydrationInFlight) {
            const wasInFlight = run.geminiPostLaunchHydrationInFlight;
            clearGeminiPostLaunchHydrationState(run);
            logger.warn(
              `[${run.teamName}] Gemini post-launch hydration ${
                wasInFlight ? 'turn errored' : 'pending dropped'
              } — clearing (strict policy)`
            );
          }
          this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
          this.setLeadActivity(run, 'idle');
        }
      }
    }

    // Handle compact_boundary — context was compacted, next assistant message will carry fresh usage
    if (msg.type === 'system') {
      const sub = typeof msg.subtype === 'string' ? msg.subtype : undefined;
      if (sub === 'compact_boundary') {
        if (run.leadContextUsage) {
          run.leadContextUsage.lastUsageMessageId = null;
        }

        // Extract compact metadata for the system message
        const meta = msg.compact_metadata as Record<string, unknown> | undefined;
        const trigger = typeof meta?.trigger === 'string' ? meta.trigger : 'auto';
        const preTokens = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null;
        const tokenInfo = preTokens ? ` (was ~${(preTokens / 1000).toFixed(0)}k tokens)` : '';

        const compactMsg: InboxMessage = {
          from: 'system',
          text: `Context compacted${tokenInfo}, trigger: ${trigger}`,
          timestamp: nowIso(),
          read: true,
          summary: `Context compacted (${trigger})`,
          messageId: `compact-${run.runId}-${Date.now()}`,
          source: 'lead_process',
        };
        this.pushLiveLeadProcessMessage(run.teamName, compactMsg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: 'compact_boundary',
        });
        logger.info(
          `[${run.teamName}] compact_boundary — context will refresh on next turn${tokenInfo}`
        );

        // Schedule post-compact context reinjection on next idle.
        // If a reminder is already in-flight, re-arm pending so a follow-up fires after it completes.
        // This handles the case where the reminder prompt itself triggers another compaction.
        if (run.provisioningComplete && !run.pendingPostCompactReminder) {
          run.pendingPostCompactReminder = true;
          logger.info(
            `[${run.teamName}] post-compact reminder scheduled for next idle${
              run.postCompactReminderInFlight ? ' (re-armed during in-flight reminder)' : ''
            }`
          );
        }
      }

      // Show API retry attempts in Live output so the user knows what's happening
      if (sub === 'api_retry') {
        const attempt = typeof msg.attempt === 'number' ? msg.attempt : '?';
        const maxRetries = typeof msg.max_retries === 'number' ? msg.max_retries : '?';
        const errorStatus = typeof msg.error_status === 'number' ? msg.error_status : undefined;
        const errorLabel = typeof msg.error === 'string' ? msg.error.replace(/_/g, ' ') : undefined;
        const retryDelay = typeof msg.retry_delay_ms === 'number' ? msg.retry_delay_ms : undefined;
        const errorMessage =
          typeof msg.error_message === 'string' && msg.error_message.trim().length > 0
            ? this.normalizeApiRetryErrorMessage(msg.error_message.trim())
            : undefined;
        const looksLikeQuotaRetry =
          errorLabel === 'rate limit' || this.isQuotaRetryMessage(errorMessage);

        // Use a human label for known quota/rate-limit retries instead of a misleading 500 bucket.
        const statusLabel = looksLikeQuotaRetry
          ? 'rate limited'
          : errorLabel
            ? `${errorLabel}${errorStatus ? ` (${errorStatus})` : ''}`
            : `error ${errorStatus ?? 'unknown'}`;
        const delayLabel = retryDelay ? ` — next retry in ${Math.round(retryDelay / 1000)}s` : '';
        const retryText = `API retry ${attempt}/${maxRetries}: ${statusLabel}${
          errorMessage ? ` — ${errorMessage}` : ''
        }${delayLabel}`;

        if (!run.provisioningComplete) {
          const warningText = errorMessage
            ? `**API retry ${attempt}/${maxRetries}: ${statusLabel}**\n\n\`\`\`\n${this.toMarkdownCodeSafe(
                errorMessage
              )}\n\`\`\`\n\n${retryDelay ? `Next retry in ${Math.round(retryDelay / 1000)}s.` : 'Retrying...'}`
            : `**API retry ${attempt}/${maxRetries}: ${statusLabel}**\n\n${
                retryDelay ? `Next retry in ${Math.round(retryDelay / 1000)}s.` : 'Retrying...'
              }`;
          if (run.apiRetryWarningIndex != null) {
            run.provisioningOutputParts[run.apiRetryWarningIndex] = warningText;
          } else {
            run.apiRetryWarningIndex = run.provisioningOutputParts.length;
            run.provisioningOutputParts.push(warningText);
          }
          run.lastRetryAt = Date.now();
          run.progress = {
            ...run.progress,
            updatedAt: nowIso(),
            message: retryText,
            messageSeverity: 'error' as const,
            assistantOutput: run.provisioningOutputParts.join('\n\n'),
          };
          run.onProgress(run.progress);
        }
      }
    }

    // Catch-all: detect API errors in unrecognised message types.
    // Guards against future protocol additions that carry error payloads
    // (e.g. type: "error") which would otherwise be silently dropped.
    if (typeof msg.type === 'string' && !HANDLED_STREAM_JSON_TYPES.has(msg.type)) {
      const raw = JSON.stringify(msg);
      logger.warn(
        `[${run.teamName}] Unhandled stream-json type "${msg.type}": ${raw.slice(0, 300)}`
      );
      if (
        !run.provisioningComplete &&
        this.hasApiError(raw) &&
        !this.isAuthFailureWarning(raw, 'stdout')
      ) {
        this.emitApiErrorWarning(run, raw);
      }
    }
  }

  /**
   * Injects a post-compact context reminder into the lead process via stdin.
   * Reinjects durable lead rules (constraints, communication protocol, board MCP ops)
   * plus a fresh task board snapshot so the lead recovers full operational context
   * after context compaction.
   *
   * Policy: strict drop-after-attempt — one compact cycle gives at most one reminder turn.
   * If the injection fails (stdin not writable, process killed), we do not retry.
   */
  private async injectPostCompactReminder(run: ProvisioningRun): Promise<void> {
    // Consume the pending flag immediately — strict one-shot policy.
    run.pendingPostCompactReminder = false;

    // Guard: process must be alive and writable.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder skipped — process not writable or killed`
      );
      return;
    }

    // Guard: don't inject if another turn is actively processing (race with user send / inbox relay).
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — lead is ${run.leadActivityState}, not idle`
      );
      // Re-arm so it triggers on next idle.
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a relay capture is in-flight.
    if (run.leadRelayCapture) {
      logger.info(`[${run.teamName}] post-compact reminder deferred — relay capture in-flight`);
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a silent DM forward is in progress.
    if (run.silentUserDmForward) {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — silent DM forward in progress`
      );
      run.pendingPostCompactReminder = true;
      return;
    }

    // Read current team config for up-to-date members (may have changed since launch).
    let currentMembers: TeamCreateRequest['members'] = run.request.members;
    let leadName = 'team-lead';
    try {
      const config = await this.configReader.getConfig(run.teamName);
      if (config?.members) {
        const configLead = config.members.find((m) => isLeadMember(m));
        leadName = configLead?.name?.trim() || 'team-lead';
        // Convert config members (excluding lead) to TeamCreateRequest member format.
        const configTeammates = config.members
          .filter((m) => !isLeadMember(m) && m?.name)
          .map((m) => ({
            name: m.name,
            role: m.role ?? undefined,
          }));
        // When config.members only has the lead (pre-created config without
        // TeamCreate), fall back to run.request.members for the teammate list.
        if (configTeammates.length > 0) {
          currentMembers = configTeammates;
        }
      } else {
        leadName =
          run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
          'team-lead';
      }
    } catch {
      // Fallback to launch-time members if config is unavailable.
      leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';
      logger.warn(
        `[${run.teamName}] post-compact reminder: config unavailable, using launch-time members`
      );
    }
    const isSolo = currentMembers.length === 0;

    // Build persistent lead context.
    const persistentContext = buildPersistentLeadContext({
      teamName: run.teamName,
      leadName,
      isSolo,
      members: currentMembers,
      compact: true,
    });

    // Best-effort: fetch fresh task board snapshot.
    let taskBoardBlock = '';
    try {
      const taskReader = new TeamTaskReader();
      const tasks = await taskReader.getTasks(run.teamName);
      taskBoardBlock = buildTaskBoardSnapshot(tasks);
    } catch {
      // If tasks can't be read, inject without the snapshot.
      logger.warn(`[${run.teamName}] post-compact reminder: task board snapshot unavailable`);
    }

    // Re-check guards after async work.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder aborted — process state changed during preparation`
      );
      return;
    }
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — lead activity changed to ${run.leadActivityState as string}`
      );
      // Re-arm so it triggers on next idle.
      run.pendingPostCompactReminder = true;
      return;
    }

    const message = [
      `Context reminder (post-compaction) — your context was compacted. Here are your standing rules and current state:`,
      ``,
      `You are "${leadName}", the team lead of team "${run.teamName}".`,
      `You are running in a non-interactive CLI session. Do not ask questions.`,
      `CRITICAL: Execute ALL steps directly yourself in sequence. Do NOT delegate any step to a sub-agent via the Agent tool. The ONLY valid use of the Agent tool is spawning individual teammates.`,
      ``,
      persistentContext,
      taskBoardBlock.trim() ? `\n${taskBoardBlock}` : '',
      ``,
      `This is a context-only reminder. Do NOT start new work or execute tasks in this turn. Reply with a single word: "OK".`,
    ]
      .filter(Boolean)
      .join('\n');

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });

    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;
    this.setLeadActivity(run, 'active');

    try {
      const stdin = run.child.stdin;
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`[${run.teamName}] post-compact reminder injected`);
    } catch (error) {
      // Strict drop-after-attempt — do not re-arm.
      clearPostCompactReminderState(run);
      this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
      this.setLeadActivity(run, 'idle');
      logger.warn(
        `[${run.teamName}] post-compact reminder injection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    run.pendingGeminiPostLaunchHydration = false;

    if (
      run.geminiPostLaunchHydrationSent ||
      !run.child?.stdin?.writable ||
      run.processKilled ||
      run.cancelRequested
    ) {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration skipped — process not writable, killed, or already sent`
      );
      return;
    }

    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — lead is ${run.leadActivityState}, not idle`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    if (run.leadRelayCapture) {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — relay capture in-flight`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    if (run.silentUserDmForward) {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — silent DM forward in progress`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    let currentMembers: TeamCreateRequest['members'] = run.effectiveMembers;
    let leadName =
      run.effectiveMembers.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
    try {
      const config = await this.configReader.getConfig(run.teamName);
      if (config?.members) {
        const configLead = config.members.find((m) => isLeadMember(m));
        leadName = configLead?.name?.trim() || leadName;
        const configTeammates = config.members
          .filter((m) => !isLeadMember(m) && m?.name)
          .map((m) => ({
            name: m.name,
            role: m.role ?? undefined,
          }));
        if (configTeammates.length > 0) {
          const launchMembersByName = new Map(
            run.effectiveMembers.map((member) => [member.name, member] as const)
          );
          currentMembers = configTeammates.map((member) => ({
            ...launchMembersByName.get(member.name),
            ...member,
          }));
        }
      }
    } catch {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration: config unavailable, using launch-time members`
      );
    }

    let tasks: TeamTask[] = [];
    try {
      tasks = await new TeamTaskReader().getTasks(run.teamName);
    } catch {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration: task board snapshot unavailable`
      );
    }

    if (
      run.geminiPostLaunchHydrationSent ||
      !run.child?.stdin?.writable ||
      run.processKilled ||
      run.cancelRequested
    ) {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration aborted — process state changed during preparation`
      );
      return;
    }
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — lead activity changed to ${run.leadActivityState as string}`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    const message = buildGeminiPostLaunchHydrationPrompt(run, leadName, currentMembers, tasks);
    const promptSize = getPromptSizeSummary(message);
    logger.info(
      `[${run.teamName}] Gemini post-launch hydration prepared (${promptSize.chars} chars / ${promptSize.lines} lines)`
    );

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });

    run.geminiPostLaunchHydrationInFlight = true;
    run.geminiPostLaunchHydrationSent = true;
    run.suppressGeminiPostLaunchHydrationOutput = true;
    this.setLeadActivity(run, 'active');

    try {
      const stdin = run.child.stdin;
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`[${run.teamName}] Gemini post-launch hydration injected`);
    } catch (error) {
      run.geminiPostLaunchHydrationInFlight = false;
      run.geminiPostLaunchHydrationSent = false;
      run.suppressGeminiPostLaunchHydrationOutput = false;
      this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
      this.setLeadActivity(run, 'idle');
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration injection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Handles a control_request message from CLI stream-json output.
   * `can_use_tool` → emits to renderer for manual approval.
   * All other subtypes (hook_callback, etc.) → auto-allowed to prevent deadlock.
   */
  private handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (!requestId) {
      logger.warn(`[${run.teamName}] control_request missing request_id, ignoring`);
      return;
    }

    const request = msg.request as Record<string, unknown> | undefined;
    const subtype = request?.subtype;

    // Non-`can_use_tool` subtypes (hook_callback, etc.) are auto-allowed to prevent
    // CLI deadlock — hooks are user-configured and should not block on manual approval.
    if (subtype !== 'can_use_tool') {
      logger.debug(
        `[${run.teamName}] control_request subtype=${String(subtype)}, auto-allowing to prevent deadlock`
      );
      this.autoAllowControlRequest(run, requestId);
      return;
    }

    const toolName = typeof request?.tool_name === 'string' ? request.tool_name : 'Unknown';
    const toolInput = (request?.input ?? {}) as Record<string, unknown>;

    const approval: ToolApprovalRequest = {
      requestId,
      runId: run.runId,
      teamName: run.teamName,
      source: 'lead',
      toolName,
      toolInput,
      receivedAt: new Date().toISOString(),
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
    };

    // Check auto-allow rules before prompting user
    const autoResult = shouldAutoAllow(
      this.getToolApprovalSettings(run.teamName),
      toolName,
      toolInput
    );
    if (autoResult.autoAllow) {
      logger.info(`[${run.teamName}] Auto-allowing ${toolName} (${autoResult.reason})`);
      this.autoAllowControlRequest(run, requestId);
      this.emitToolApprovalEvent({
        autoResolved: true,
        requestId,
        runId: run.runId,
        teamName: run.teamName,
        reason: 'auto_allow_category',
      } as ToolApprovalAutoResolved);
      return;
    }

    run.pendingApprovals.set(requestId, approval);
    this.emitToolApprovalEvent(approval);
    this.startApprovalTimeout(run, requestId);

    // Show OS notification when window is not focused
    this.maybeShowToolApprovalOsNotification(run, approval);
  }

  /**
   * Handles a teammate permission_request received via inbox message.
   * Converts it to a ToolApprovalRequest and feeds it into the existing approval flow.
   */
  private handleTeammatePermissionRequest(
    run: ProvisioningRun,
    perm: ParsedPermissionRequest,
    messageTimestamp: string
  ): void {
    // Skip if already tracked (idempotency — multiple paths can trigger this:
    // early inbox scan, stdout parsing, native message blocks, relay Category 4)
    if (run.processedPermissionRequestIds.has(perm.requestId)) return;
    if (run.pendingApprovals.has(perm.requestId)) return;
    run.processedPermissionRequestIds.add(perm.requestId);

    logger.warn(
      `[${run.teamName}] [PERM-TRACE] handleTeammatePermissionRequest: agent=${perm.agentId} tool=${perm.toolName} requestId=${perm.requestId}`
    );

    const approval: ToolApprovalRequest = {
      requestId: perm.requestId,
      runId: run.runId,
      teamName: run.teamName,
      source: perm.agentId,
      toolName: perm.toolName,
      toolInput: perm.input,
      receivedAt: messageTimestamp || new Date().toISOString(),
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
      permissionSuggestions:
        perm.permissionSuggestions.length > 0 ? perm.permissionSuggestions : undefined,
    };

    const autoResult = shouldAutoAllow(
      this.getToolApprovalSettings(run.teamName),
      perm.toolName,
      perm.input
    );
    if (autoResult.autoAllow) {
      logger.info(
        `[${run.teamName}] Auto-allowing teammate ${perm.agentId} ${perm.toolName} (${autoResult.reason})`
      );
      void this.respondToTeammatePermission(
        run,
        perm.agentId,
        perm.requestId,
        true,
        undefined,
        perm.permissionSuggestions
      );
      this.emitToolApprovalEvent({
        autoResolved: true,
        requestId: perm.requestId,
        runId: run.runId,
        teamName: run.teamName,
        reason: 'auto_allow_category',
      } as ToolApprovalAutoResolved);
      return;
    }

    run.pendingApprovals.set(perm.requestId, approval);
    this.emitToolApprovalEvent(approval);
    this.startApprovalTimeout(run, perm.requestId);
    this.maybeShowToolApprovalOsNotification(run, approval);
  }

  /**
   * Shows a native OS notification for a pending tool approval when the app
   * is not in focus. On macOS, adds Allow/Deny action buttons that respond
   * directly from the notification without switching to the app.
   */
  private maybeShowToolApprovalOsNotification(
    run: ProvisioningRun,
    approval: ToolApprovalRequest
  ): void {
    const win = this.mainWindowRef;
    if (win && !win.isDestroyed() && win.isFocused()) return;

    const config = ConfigManager.getInstance().getConfig();
    if (!config.notifications.enabled || !config.notifications.notifyOnToolApproval) return;

    // Respect snooze — consistent with other notification types
    const snoozedUntil = config.notifications.snoozedUntil;
    if (snoozedUntil && Date.now() < snoozedUntil) return;

    const { Notification: ElectronNotification } = require('electron') as typeof import('electron');
    if (!ElectronNotification.isSupported()) return;

    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';
    const iconPath = isMac ? undefined : getAppIconPath();
    const teamLabel = run.request.displayName ?? run.teamName;
    const body = this.formatToolApprovalBody(approval.toolName, approval.toolInput);

    // Actions (Allow/Deny buttons) supported on macOS and Windows.
    // Linux libnotify doesn't fire the 'action' event — users get click-to-focus.
    const supportsActions = !isLinux;

    const notification = new ElectronNotification({
      title: `Tool Approval — ${teamLabel}`,
      body,
      sound: config.notifications.soundEnabled ? 'default' : undefined,
      ...(iconPath ? { icon: iconPath } : {}),
      ...(supportsActions
        ? {
            actions: [
              { type: 'button' as const, text: 'Allow' },
              { type: 'button' as const, text: 'Deny' },
            ],
          }
        : {}),
    });

    // Track by requestId so we can close it when approval is resolved via UI
    this.activeApprovalNotifications.set(approval.requestId, notification);
    const cleanup = (): void => {
      this.activeApprovalNotifications.delete(approval.requestId);
    };

    notification.on('click', () => {
      cleanup();
      // Use current mainWindowRef (not captured `win`) in case window was recreated
      const currentWin = this.mainWindowRef;
      if (currentWin && !currentWin.isDestroyed()) {
        currentWin.show();
        currentWin.focus();
      }
    });

    notification.on('close', cleanup);

    // Action buttons: Allow (index 0) / Deny (index 1)
    // 'action' event fires on macOS and Windows (not Linux)
    if (supportsActions) {
      notification.on('action', (_event, index) => {
        cleanup();
        const allow = index === 0;
        logger.info(
          `[${run.teamName}] Tool approval ${allow ? 'allowed' : 'denied'} via OS notification`
        );
        void this.respondToToolApproval(
          run.teamName,
          run.runId,
          approval.requestId,
          allow,
          allow ? undefined : 'Denied via notification'
        ).catch((err) => {
          logger.error(
            `[${run.teamName}] Failed to respond via notification: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      });
    }

    notification.show();
  }

  /** Dismiss the OS notification for a resolved/dismissed approval. */
  dismissApprovalNotification(requestId: string): void {
    const notification = this.activeApprovalNotifications.get(requestId);
    if (notification) {
      notification.close();
      this.activeApprovalNotifications.delete(requestId);
    }
  }

  private formatToolApprovalBody(toolName: string, toolInput: Record<string, unknown>): string {
    switch (toolName) {
      case 'AskUserQuestion':
        return this.formatAskUserQuestionApprovalBody(toolInput);
      case 'Bash':
        return `Bash: ${typeof toolInput.command === 'string' ? toolInput.command.slice(0, 150) : 'command'}`;
      case 'Write':
      case 'Edit':
      case 'Read':
      case 'NotebookEdit':
        return `${toolName}: ${typeof toolInput.file_path === 'string' ? toolInput.file_path : 'file'}`;
      default:
        return `${toolName}: ${JSON.stringify(toolInput).slice(0, 150)}`;
    }
  }

  private formatAskUserQuestionApprovalBody(toolInput: Record<string, unknown>): string {
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const questions = rawQuestions
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const question =
          'question' in item && typeof item.question === 'string' ? item.question.trim() : null;
        return question && question.length > 0 ? question.replace(/\s+/g, ' ') : null;
      })
      .filter((question): question is string => Boolean(question));

    if (questions.length === 0) {
      return 'Question: User input is required';
    }

    const firstQuestion = questions[0];
    const truncatedQuestion =
      firstQuestion.length > 140 ? `${firstQuestion.slice(0, 137)}...` : firstQuestion;

    return questions.length === 1
      ? `Question: ${truncatedQuestion}`
      : `Questions (${questions.length}): ${truncatedQuestion}`;
  }

  /**
   * Immediately sends an "allow" control_response for a non-tool control_request.
   * Prevents CLI deadlock for hook_callback and other non-`can_use_tool` subtypes.
   */
  private autoAllowControlRequest(run: ProvisioningRun, requestId: string): void {
    if (!run.child?.stdin?.writable) {
      logger.warn(`[${run.teamName}] Cannot auto-allow control_request: stdin not writable`);
      return;
    }

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: {} },
      },
    };

    run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
      if (err) {
        logger.error(
          `[${run.teamName}] Failed to auto-allow control_request ${requestId}: ${err.message}`
        );
      }
    });
  }

  private tryClaimResponse(requestId: string): boolean {
    if (this.inFlightResponses.has(requestId)) return false;
    this.inFlightResponses.add(requestId);
    return true;
  }

  private startApprovalTimeout(run: ProvisioningRun, requestId: string): void {
    const { timeoutAction, timeoutSeconds } = this.getToolApprovalSettings(run.teamName);
    if (timeoutAction === 'wait') return;

    const timeoutMs = timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(requestId);
      if (!run.pendingApprovals.has(requestId)) return;
      if (!this.tryClaimResponse(requestId)) return;

      // Read CURRENT settings (not captured closure) in case user changed action
      const currentAction = this.getToolApprovalSettings(run.teamName).timeoutAction;
      if (currentAction === 'wait') {
        // Settings changed to 'wait' but timer fired before reEvaluatePendingApprovals cleared it
        this.inFlightResponses.delete(requestId);
        return;
      }
      const allow = currentAction === 'allow';
      logger.info(`[${run.teamName}] Timeout ${allow ? 'allowing' : 'denying'} ${requestId}`);

      const approval = run.pendingApprovals.get(requestId);
      if (approval && approval.source !== 'lead') {
        // Teammate request — apply permission_suggestions to project settings.
        this.respondToTeammatePermission(
          run,
          approval.source,
          requestId,
          allow,
          allow ? undefined : 'Timed out — auto-denied by settings',
          approval.permissionSuggestions
        ).finally(() => {
          run.pendingApprovals.delete(requestId);
          this.inFlightResponses.delete(requestId);
          this.dismissApprovalNotification(requestId);
          this.emitToolApprovalEvent({
            autoResolved: true,
            requestId,
            runId: run.runId,
            teamName: run.teamName,
            reason: allow ? 'timeout_allow' : 'timeout_deny',
          } as ToolApprovalAutoResolved);
        });
        return;
      }

      if (allow) {
        this.autoAllowControlRequest(run, requestId);
      } else {
        this.autoDenyControlRequest(run, requestId);
      }
      run.pendingApprovals.delete(requestId);
      this.inFlightResponses.delete(requestId);
      this.dismissApprovalNotification(requestId);

      this.emitToolApprovalEvent({
        autoResolved: true,
        requestId,
        runId: run.runId,
        teamName: run.teamName,
        reason: allow ? 'timeout_allow' : 'timeout_deny',
      } as ToolApprovalAutoResolved);
    }, timeoutMs);

    this.pendingTimeouts.set(requestId, timer);
  }

  private clearApprovalTimeout(requestId: string): void {
    const timer = this.pendingTimeouts.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimeouts.delete(requestId);
    }
  }

  private autoDenyControlRequest(run: ProvisioningRun, requestId: string): void {
    if (!run.child?.stdin?.writable) {
      logger.warn(`[${run.teamName}] Cannot auto-deny control_request: stdin not writable`);
      return;
    }

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'deny', message: 'Timed out — auto-denied by settings' },
      },
    };

    run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
      if (err) {
        logger.error(
          `[${run.teamName}] Failed to auto-deny control_request ${requestId}: ${err.message}`
        );
      }
    });
  }

  private reEvaluatePendingApprovals(): void {
    for (const [, run] of this.runs) {
      const settings = this.getToolApprovalSettings(run.teamName);
      const toRemove: string[] = [];
      for (const [requestId, approval] of run.pendingApprovals) {
        const result = shouldAutoAllow(settings, approval.toolName, approval.toolInput);
        if (result.autoAllow) {
          this.clearApprovalTimeout(requestId);
          if (!this.tryClaimResponse(requestId)) continue;
          if (approval.source !== 'lead') {
            void this.respondToTeammatePermission(
              run,
              approval.source,
              requestId,
              true,
              undefined,
              approval.permissionSuggestions
            );
          } else {
            this.autoAllowControlRequest(run, requestId);
          }
          this.dismissApprovalNotification(requestId);
          toRemove.push(requestId);
          this.emitToolApprovalEvent({
            autoResolved: true,
            requestId,
            runId: run.runId,
            teamName: run.teamName,
            reason: 'auto_allow_category',
          } as ToolApprovalAutoResolved);
        } else if (settings.timeoutAction !== 'wait' && !this.pendingTimeouts.has(requestId)) {
          // Settings changed from 'wait' to allow/deny — start timer for already pending items
          this.startApprovalTimeout(run, requestId);
        } else if (settings.timeoutAction === 'wait' && this.pendingTimeouts.has(requestId)) {
          // Settings changed TO 'wait' — clear existing timers
          this.clearApprovalTimeout(requestId);
        }
      }
      for (const requestId of toRemove) {
        run.pendingApprovals.delete(requestId);
        this.inFlightResponses.delete(requestId);
      }
    }
  }

  /**
   * Respond to a pending tool approval — sends control_response to CLI stdin.
   * Validates runId match and requestId existence before writing.
   */
  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    // Look in both provisioning and alive runs — control_requests arrive during provisioning too
    const currentRunId = this.getTrackedRunId(teamName);
    if (!currentRunId) throw new Error(`No active process for team "${teamName}"`);
    const run = this.runs.get(currentRunId);
    if (!run) throw new Error(`Run not found for team "${teamName}"`);

    if (run.runId !== runId) {
      throw new Error(`Stale approval: runId mismatch (expected ${run.runId}, got ${runId})`);
    }

    // Clear timeout and claim response FIRST (before pendingApprovals check)
    // to handle the race where timeout already responded and deleted the approval
    this.clearApprovalTimeout(requestId);
    if (!this.tryClaimResponse(requestId)) {
      // Timeout already responded — silently exit, UI cleanup via autoResolved event
      run.pendingApprovals.delete(requestId);
      return;
    }

    if (!run.pendingApprovals.has(requestId)) {
      // Approval was removed (e.g. by reEvaluatePendingApprovals) — clean up claim and exit
      this.inFlightResponses.delete(requestId);
      return;
    }

    const approval = run.pendingApprovals.get(requestId)!;

    // Teammate permission requests: apply permission_suggestions to project settings
    if (approval.source !== 'lead') {
      try {
        await this.respondToTeammatePermission(
          run,
          approval.source,
          requestId,
          allow,
          message,
          approval.permissionSuggestions
        );
      } finally {
        run.pendingApprovals.delete(requestId);
        this.inFlightResponses.delete(requestId);
        this.dismissApprovalNotification(requestId);
      }
      return;
    }

    if (!run.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    // IMPORTANT: request_id is NESTED inside response, NOT top-level
    // (asymmetry with control_request — confirmed by Python SDK, Elixir SDK and issue #29991)
    const allowResponse: Record<string, unknown> = { behavior: 'allow', updatedInput: {} };
    // For AskUserQuestion: pass user's answers via updatedInput so the CLI
    // can deliver them without re-prompting. Format follows --permission-prompt-tool spec.
    if (allow && message) {
      const pending = run.pendingApprovals.get(requestId);
      if (pending?.toolName === 'AskUserQuestion') {
        try {
          const answers = JSON.parse(message) as Record<string, string>;
          allowResponse.updatedInput = { ...pending.toolInput, answers };
        } catch {
          // If message isn't JSON, use as-is for the first question
          const questions = (pending.toolInput.questions as { question?: string }[]) ?? [];
          const answers: Record<string, string> = {};
          if (questions[0]?.question) answers[questions[0].question] = message;
          allowResponse.updatedInput = { ...pending.toolInput, answers };
        }
      }
    }
    const response = allow
      ? {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: allowResponse,
          },
        }
      : {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'deny', message: message ?? 'User denied' },
          },
        };

    const stdin = run.child.stdin;
    const responseJson = JSON.stringify(response) + '\n';
    logger.info(
      `[${teamName}] Writing control_response for ${requestId}: ${allow ? 'allow' : 'deny'}`
    );
    try {
      await new Promise<void>((resolve, reject) => {
        // Safety timeout — if stdin.write callback is never called (e.g. process died
        // between the writable check and the write), reject instead of hanging forever.
        const writeTimeout = setTimeout(() => {
          reject(new Error(`Timeout writing control_response to stdin (process may have exited)`));
        }, 5000);

        stdin.write(responseJson, (err) => {
          clearTimeout(writeTimeout);
          if (err) {
            logger.error(`[${teamName}] Failed to write control_response: ${err.message}`);
            reject(err);
          } else {
            logger.info(`[${teamName}] control_response written successfully for ${requestId}`);
            resolve();
          }
        });
      });
    } finally {
      run.pendingApprovals.delete(requestId);
      this.inFlightResponses.delete(requestId);
      this.dismissApprovalNotification(requestId);
    }
  }

  /**
   * Respond to a teammate's permission_request by applying permission_suggestions.
   *
   * FACT: Claude Code teammate runtime sends permission_request via SendMessage (inbox protocol).
   * FACT: Writing permission_response to teammate inbox does NOT work - runtime ignores it.
   * FACT: control_response via stdin does NOT work for teammate requests - request_id doesn't match.
   * FACT: permission_suggestions.destination "localSettings" refers to {cwd}/.claude/settings.local.json.
   * FACT: Claude Code CLI reads this file via --setting-sources user,project,local.
   *
   * When allow=true: applies permission_suggestions (adds tool rules to project settings).
   * When allow=false: no action needed - tool stays blocked by default.
   */
  private async respondToTeammatePermission(
    run: ProvisioningRun,
    agentId: string,
    requestId: string,
    allow: boolean,
    _message?: string,
    permissionSuggestions?: import('@shared/utils/inboxNoise').PermissionSuggestion[]
  ): Promise<void> {
    if (!allow) {
      logger.info(`[${run.teamName}] Denied teammate ${agentId} permission ${requestId}`);
      return;
    }

    // Apply permission_suggestions: add tool rules to project settings file
    const suggestions = permissionSuggestions ?? [];
    if (suggestions.length === 0) {
      logger.warn(`[${run.teamName}] No permission_suggestions for ${requestId} — cannot add rule`);
      return;
    }

    // Resolve project cwd from team config
    let projectCwd: string | undefined;
    try {
      const config = await this.configReader.getConfig(run.teamName);
      projectCwd = config?.projectPath ?? config?.members?.[0]?.cwd;
    } catch {
      // best-effort
    }
    if (!projectCwd) {
      logger.warn(`[${run.teamName}] Cannot resolve project cwd for permission rule — skipping`);
      return;
    }

    for (const suggestion of suggestions) {
      // Handle "setMode" suggestions (e.g. Write/Edit tools suggest acceptEdits mode)
      // FACT: Write/Edit permission_requests have permission_suggestions:
      //   { type: "setMode", mode: "acceptEdits", destination: "session" }
      // Since we can't change session mode of a subprocess, we translate to addRules.
      if (suggestion.type === 'setMode') {
        const mode = typeof suggestion.mode === 'string' ? suggestion.mode : '';
        let toolNames: string[] = [];
        if (mode === 'acceptEdits') {
          toolNames = ['Edit', 'Write', 'NotebookEdit'];
        } else if (mode === 'bypassPermissions') {
          // Broad approval — add common tools
          toolNames = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob'];
        }
        if (toolNames.length > 0) {
          const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
          try {
            await this.addPermissionRulesToSettings(settingsPath, toolNames, 'allow');
            logger.info(
              `[${run.teamName}] Applied setMode "${mode}" for ${agentId}: ${toolNames.join(', ')} in ${settingsPath}`
            );
          } catch (error) {
            logger.error(
              `[${run.teamName}] Failed to apply setMode: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        continue;
      }

      if (suggestion.type !== 'addRules' || !Array.isArray(suggestion.rules)) continue;

      let toolNames = suggestion.rules
        .map((r) => r.toolName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      if (toolNames.length === 0) continue;

      // Expand teammate-safe operational tools only.
      // This removes the bootstrap/task workflow race without accidentally granting
      // admin/runtime tools like team_stop or kanban_clear.
      if (
        toolNames.some((name) =>
          AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES.includes(name)
        )
      ) {
        const merged = new Set([
          ...toolNames,
          ...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
        ]);
        toolNames = Array.from(merged);
      }

      const behavior = suggestion.behavior ?? 'allow';
      // FACT: observed destinations are "localSettings" (project-level .claude/settings.local.json)
      const settingsPath =
        suggestion.destination === 'localSettings'
          ? path.join(projectCwd, '.claude', 'settings.local.json')
          : path.join(projectCwd, '.claude', 'settings.local.json'); // default to local

      try {
        await this.addPermissionRulesToSettings(settingsPath, toolNames, behavior);
        logger.info(
          `[${run.teamName}] Added permission rules for ${agentId}: ${toolNames.join(', ')} → ${behavior} in ${settingsPath}`
        );
      } catch (error) {
        logger.error(
          `[${run.teamName}] Failed to add permission rules: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // Also attempt control_response via stdin — the lead runtime MAY forward it
    // to the teammate subprocess. This was broken before (missing updatedInput: {})
    // but is now fixed. Belt-and-suspenders: settings handle future calls,
    // control_response may unblock the CURRENT waiting prompt.
    if (allow && run.child?.stdin?.writable) {
      const controlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { behavior: 'allow', updatedInput: {} },
        },
      };
      run.child.stdin.write(JSON.stringify(controlResponse) + '\n', (err) => {
        if (err) {
          logger.warn(
            `[${run.teamName}] control_response via stdin for teammate ${agentId} failed (non-critical): ${err.message}`
          );
        }
      });
    }
  }

  /**
   * Safely add tool names to the permissions.allow (or deny) array in a Claude settings file.
   * Creates the file and parent directories if they don't exist.
   * Merges with existing entries — never overwrites.
   */
  private async addPermissionRulesToSettings(
    settingsPath: string,
    toolNames: string[],
    behavior: string
  ): Promise<number> {
    const dir = path.dirname(settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Read existing settings (or start with empty object)
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Ensure permissions object exists
    if (!settings.permissions || typeof settings.permissions !== 'object') {
      settings.permissions = {};
    }
    const perms = settings.permissions as Record<string, unknown>;

    // Target array: "allow" or "deny" based on behavior
    const key = behavior === 'deny' ? 'deny' : 'allow';
    if (!Array.isArray(perms[key])) {
      perms[key] = [];
    }
    const list = perms[key] as string[];

    // Add tool names that aren't already in the list
    const existing = new Set(list);
    let added = 0;
    for (const name of toolNames) {
      if (!existing.has(name)) {
        list.push(name);
        added++;
      }
    }

    if (added === 0) return 0; // Nothing new to add

    await atomicWriteAsync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return added;
  }

  private async seedTeammateOperationalPermissionRules(
    teamName: string,
    projectCwd: string
  ): Promise<void> {
    const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
    try {
      // FACT: Teammates need both MCP tools AND standard file tools (Write/Edit).
      // FACT: Standard tools use "setMode: acceptEdits" permission_suggestions, but
      // we can't change subprocess session mode — so we pre-add them as allow rules.
      const allTools = [
        ...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
        'Edit',
        'Write',
        'NotebookEdit',
      ];
      const added = await this.addPermissionRulesToSettings(settingsPath, allTools, 'allow');
      logger.info(
        `[${teamName}] Seeded teammate operational MCP rules in ${settingsPath} (${added} added)`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to seed teammate operational MCP rules: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Called when the first stream-json turn completes successfully.
   * Verifies provisioning files exist and marks as ready.
   * Process stays alive for subsequent tasks.
   */
  private async handleProvisioningTurnComplete(run: ProvisioningRun): Promise<void> {
    // Guard: must be set synchronously BEFORE any await to prevent
    // double-invocation from filesystem monitor + stream-json racing.
    if (
      run.provisioningComplete ||
      run.cancelRequested ||
      run.processKilled ||
      run.progress.state === 'failed'
    )
      return;

    // Prevent false "ready" when auth failure was printed in CLI output but the filesystem monitor
    // already observed files on disk. We only re-check stderr plus a trailing non-JSON stdout
    // fragment here to avoid late false positives from assistant/result stream-json payloads.
    const preCompleteText = this.getPreCompleteCliErrorText(run);
    if (
      preCompleteText &&
      this.hasApiError(preCompleteText) &&
      !this.isAuthFailureWarning(preCompleteText, 'pre-complete') &&
      // Skip if we already showed a warning for this error — the SDK had a chance to retry
      // and the CLI reported success. Killing now would be a false positive.
      !run.apiErrorWarningEmitted
    ) {
      this.failProvisioningWithApiError(run, preCompleteText);
      return;
    }
    if (preCompleteText && this.isAuthFailureWarning(preCompleteText, 'pre-complete')) {
      this.handleAuthFailureInOutput(run, preCompleteText, 'pre-complete');
      return;
    }

    run.provisioningComplete = true;
    this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
    this.setLeadActivity(run, 'idle');

    // Clear provisioning timeout — no longer needed
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    this.stopStallWatchdog(run);

    if (run.isLaunch) {
      await this.updateConfigPostLaunch(
        run.teamName,
        run.request.cwd,
        run.detectedSessionId,
        run.request.color,
        {
          providerId: run.request.providerId,
          model: run.request.model,
          effort: run.request.effort,
          members: run.effectiveMembers,
        }
      );
      await this.cleanupPrelaunchBackup(run.teamName);

      // Best-effort: detect CLI-suffixed member names (alice-2, bob-2) that indicate
      // a stale config.json was present during launch (double-launch race).
      try {
        const postLaunchConfigPath = path.join(getTeamsBasePath(), run.teamName, 'config.json');
        const raw = await tryReadRegularFileUtf8(postLaunchConfigPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_CONFIG_MAX_BYTES,
        });
        if (raw) {
          const config = JSON.parse(raw) as {
            members?: { name?: string; agentType?: string }[];
          };
          const suffixed = (config.members ?? []).filter(
            (m) => typeof m.name === 'string' && /-\d+$/.test(m.name) && !isLeadMember(m)
          );
          if (suffixed.length > 0) {
            logger.warn(
              `[${run.teamName}] Post-launch: detected suffixed members: ` +
                `${suffixed.map((m) => m.name).join(', ')}. ` +
                'This usually means the team was launched with stale config.json.'
            );
          }
        }
      } catch {
        /* best-effort */
      }

      // Audit: flag any expected member not registered in config.json after launch.
      await this.refreshMemberSpawnStatusesFromLeadInbox(run);
      await this.maybeAuditMemberSpawnStatuses(run, { force: true });
      await this.finalizeMissingRegisteredMembersAsFailed(run);
      await this.persistLaunchStateSnapshot(run, 'finished');
      const failedSpawnMembers = this.getFailedSpawnMembers(run);
      const launchSummary = this.getMemberLaunchSummary(run);
      const hasSpawnFailures = failedSpawnMembers.length > 0;
      const stillStartingCount = Math.max(
        0,
        launchSummary.pendingCount - launchSummary.runtimeAlivePendingCount
      );
      const hasPendingBootstrap =
        !hasSpawnFailures && stillStartingCount > 0 && (run.expectedMembers?.length ?? 0) > 0;
      const readyMessage = hasSpawnFailures
        ? `Launch completed with teammate errors — ${failedSpawnMembers
            .map((member) => member.name)
            .join(', ')} failed to start`
        : hasPendingBootstrap
          ? this.buildPendingBootstrapStatusMessage('Launch completed', run, launchSummary)
          : 'Team launched — process alive and ready';
      const progress = updateProgress(run, 'ready', readyMessage, {
        cliLogsTail: extractCliLogsFromRun(run),
        messageSeverity: hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
      });
      run.onProgress(progress);
      this.provisioningRunByTeam.delete(run.teamName);
      this.aliveRunByTeam.set(run.teamName, run.runId);
      logger.info(`[${run.teamName}] Launch complete. Process alive for subsequent tasks.`);

      if (!run.deterministicBootstrap && shouldUseGeminiStagedLaunch(run.request.providerId)) {
        run.pendingGeminiPostLaunchHydration = true;
      }

      // Force a post-ready detail refresh so Messages reload persisted lead_session
      // texts from JSONL even if the last visible assistant output only reached disk.
      this.teamChangeEmitter?.({
        type: 'lead-message',
        teamName: run.teamName,
        runId: run.runId,
        detail: 'lead-session-sync',
      });

      if (!hasSpawnFailures && !hasPendingBootstrap) {
        // Fire "Team Launched" notification only for clean launches.
        void this.fireTeamLaunchedNotification(run);
      }

      if (hasSpawnFailures) {
        const failureNotice = [
          `Системное замечание: часть команды не запустилась.`,
          `Не стартовали тиммейты: ${failedSpawnMembers.map((member) => `@${member.name}`).join(', ')}.`,
          `Не считай их доступными, пока их запуск не будет повторён успешно.`,
        ].join(' ');
        await this.sendMessageToTeam(run.teamName, failureNotice).catch((error: unknown) =>
          logger.warn(
            `[${run.teamName}] failed to send teammate-start failure notice to lead: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }

      // Pick up any direct messages that arrived before/while reconnecting.
      void this.relayLeadInboxMessages(run.teamName).catch((e: unknown) =>
        logger.warn(`[${run.teamName}] post-reconnect relay failed: ${String(e)}`)
      );

      // Solo teams have no teammate processes to resume work; kick off task execution
      // as a separate turn AFTER the launch is marked ready so the UI doesn't mix
      // long-running task output into the "Launching team" live output stream.
      if (
        run.request.members.length === 0 &&
        !shouldUseGeminiStagedLaunch(run.request.providerId)
      ) {
        void (async () => {
          try {
            const taskReader = new TeamTaskReader();
            const tasks = await taskReader.getTasks(run.teamName);
            const active = tasks.filter(
              (t) =>
                (t.status === 'pending' || t.status === 'in_progress') &&
                !t.id.startsWith('_internal')
            );
            if (active.length === 0) return;

            const board = buildTaskBoardSnapshot(tasks);
            const message = [
              `Reconnected and ready. Begin executing tasks now.`,
              `Execute tasks sequentially and keep the board + user updated:`,
              `- Identify the next READY task (pending, not blocked by incomplete dependencies).`,
              `- If the task is unassigned, set yourself as owner.`,
              `- BEFORE doing any work on a task: mark it started (in_progress).`,
              `- Immediately SendMessage "user" that you started task #<id> (what you're doing + next step).`,
              `- While working: after each meaningful milestone/decision/blocker, add a task comment on #<id>. If user-relevant, also SendMessage "user".`,
              `- On completion: add a final task comment with your full results (findings, report, analysis, code changes summary, or any deliverable), then mark the task completed, then SendMessage "user" with a brief summary of the outcome (2-4 sentences) and "Full details in task comment <first-8-chars-of-commentId>". The task comment is the primary delivery channel — the user reads results on the task board.`,
              `- Do NOT start the next task until the current task is completed (default: one task in_progress at a time).`,
              board.trim(),
            ]
              .filter(Boolean)
              .join('\n\n');

            await this.sendMessageToTeam(run.teamName, message);
          } catch (error) {
            logger.warn(
              `[${run.teamName}] Failed to kick off solo task resumption: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        })();
      }
      if (
        run.pendingGeminiPostLaunchHydration &&
        !run.geminiPostLaunchHydrationInFlight &&
        !run.cancelRequested
      ) {
        void this.injectGeminiPostLaunchHydration(run);
      }
      return;
    }

    // Quick verification: config should exist by now
    const configProbe = await this.waitForValidConfig(run, 5000);
    if (!configProbe.ok) {
      logger.warn(
        `[${run.teamName}] Provisioning turn completed but no config.json found — marking ready anyway`
      );
    }

    if (configProbe.ok && configProbe.location === 'default') {
      const configuredTeamsBasePath = getTeamsBasePath();
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error:
          `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
          `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
          'Align the app Claude root setting with the CLI, then retry.',
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      run.processKilled = true;
      killTeamProcess(run.child);
      this.cleanupRun(run);
      return;
    }

    // Persist teammates metadata separately from config.json.
    await this.persistMembersMeta(run.teamName, run.request);
    await this.updateConfigPostLaunch(
      run.teamName,
      run.request.cwd,
      run.detectedSessionId,
      run.request.color,
      {
        providerId: run.request.providerId,
        model: run.request.model,
        effort: run.request.effort,
        members: run.effectiveMembers,
      }
    );

    // Clean up team.meta.json — provisioning succeeded, config.json is now authoritative.
    await this.teamMetaStore.deleteMeta(run.teamName).catch(() => {});

    // Audit: flag any expected member not registered in config.json after provisioning.
    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run, { force: true });
    await this.finalizeMissingRegisteredMembersAsFailed(run);
    await this.persistLaunchStateSnapshot(run, 'finished');
    const failedSpawnMembers = this.getFailedSpawnMembers(run);
    const launchSummary = this.getMemberLaunchSummary(run);
    const hasSpawnFailures = failedSpawnMembers.length > 0;
    const stillStartingCount = Math.max(
      0,
      launchSummary.pendingCount - launchSummary.runtimeAlivePendingCount
    );
    const hasPendingBootstrap =
      !hasSpawnFailures && stillStartingCount > 0 && run.expectedMembers.length > 0;
    const progress = updateProgress(
      run,
      'ready',
      hasSpawnFailures
        ? `Provisioning completed with teammate errors — ${failedSpawnMembers
            .map((member) => member.name)
            .join(', ')} failed to start`
        : hasPendingBootstrap
          ? this.buildPendingBootstrapStatusMessage('Team provisioned', run, launchSummary)
          : 'Team provisioned — process alive and ready',
      {
        cliLogsTail: extractCliLogsFromRun(run),
        messageSeverity: hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
      }
    );
    run.onProgress(progress);
    this.provisioningRunByTeam.delete(run.teamName);
    this.aliveRunByTeam.set(run.teamName, run.runId);
    logger.info(`[${run.teamName}] Provisioning complete. Process alive for subsequent tasks.`);

    if (!run.deterministicBootstrap && shouldUseGeminiStagedLaunch(run.request.providerId)) {
      run.pendingGeminiPostLaunchHydration = true;
    }

    // Force a post-ready detail refresh so Messages reload persisted lead_session
    // texts from JSONL even if the last visible assistant output only reached disk.
    this.teamChangeEmitter?.({
      type: 'lead-message',
      teamName: run.teamName,
      runId: run.runId,
      detail: 'lead-session-sync',
    });

    if (!hasSpawnFailures && !hasPendingBootstrap) {
      // Fire "Team Launched" notification only for clean launches.
      void this.fireTeamLaunchedNotification(run);
    }

    if (hasSpawnFailures) {
      const failureNotice = [
        `Системное замечание: часть команды не запустилась.`,
        `Не стартовали тиммейты: ${failedSpawnMembers.map((member) => `@${member.name}`).join(', ')}.`,
        `Не считай их доступными, пока их запуск не будет повторён успешно.`,
      ].join(' ');
      await this.sendMessageToTeam(run.teamName, failureNotice).catch((error: unknown) =>
        logger.warn(
          `[${run.teamName}] failed to send teammate-start failure notice to lead: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
    }

    // Pick up any direct messages that arrived during provisioning.
    void this.relayLeadInboxMessages(run.teamName).catch((e: unknown) =>
      logger.warn(`[${run.teamName}] post-provisioning relay failed: ${String(e)}`)
    );
    if (
      run.pendingGeminiPostLaunchHydration &&
      !run.geminiPostLaunchHydrationInFlight &&
      !run.cancelRequested
    ) {
      void this.injectGeminiPostLaunchHydration(run);
    }
  }

  // ---------------------------------------------------------------------------
  // Team Launched notification
  // ---------------------------------------------------------------------------

  /**
   * Fires a "team_launched" notification when a team transitions to ready state.
   * Uses the existing addTeamNotification() pipeline.
   */
  private async fireTeamLaunchedNotification(run: ProvisioningRun): Promise<void> {
    try {
      const config = ConfigManager.getInstance().getConfig();
      const suppressToast = !config.notifications.notifyOnTeamLaunched;
      const displayName = run.request.displayName || run.teamName;
      const body = run.isLaunch
        ? `Team "${displayName}" has been launched and is ready for tasks.`
        : `Team "${displayName}" has been provisioned and is ready for tasks.`;

      await NotificationManager.getInstance().addTeamNotification({
        teamEventType: 'team_launched',
        teamName: run.teamName,
        teamDisplayName: displayName,
        from: 'system',
        summary: run.isLaunch ? 'Team launched' : 'Team provisioned',
        body,
        dedupeKey: `team_launched:${run.teamName}:${run.runId}`,
        projectPath: run.request.cwd,
        suppressToast,
      });
    } catch (error) {
      logger.warn(
        `[${run.teamName}] Failed to fire team_launched notification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Same-team native delivery dedup (Layer 2)
  // ---------------------------------------------------------------------------

  private collectConfirmedSameTeamPairs(
    messages: InboxMessage[],
    fingerprints: NativeSameTeamFingerprint[],
    leadName: string
  ): { confirmedMessageIds: Set<string>; matchedFingerprintIds: Set<string> } {
    const confirmedMessageIds = new Set<string>();
    const matchedFingerprintIds = new Set<string>();

    if (fingerprints.length === 0) {
      return { confirmedMessageIds, matchedFingerprintIds };
    }

    // Build group key: from + normalizedText (summary checked during pairing, not grouping)
    const groupKey = (from: string, text: string) => `${from}\0${text}`;

    // Group fingerprints by (from, text), sorted FIFO by seenAt within each group
    const fpByGroup = new Map<string, NativeSameTeamFingerprint[]>();
    for (const fp of fingerprints) {
      const key = groupKey(fp.from, fp.text);
      let group = fpByGroup.get(key);
      if (!group) {
        group = [];
        fpByGroup.set(key, group);
      }
      group.push(fp);
    }
    for (const group of fpByGroup.values()) {
      group.sort((a, b) => a.seenAt - b.seenAt);
    }

    // Collect eligible inbox messages, grouped by (from, text), sorted FIFO by timestamp
    type EligibleMsg = InboxMessage & { messageId: string; parsedTs: number };
    const msgByGroup = new Map<string, EligibleMsg[]>();
    for (const m of messages) {
      if (m.read) continue;
      if (m.source) continue;
      if (!this.hasStableMessageId(m)) continue;
      const fromName = m.from?.trim() ?? '';
      if (!fromName || fromName === leadName || fromName === 'user') continue;
      const parsedTs = Date.parse(m.timestamp);
      if (!Number.isFinite(parsedTs)) continue;

      const key = groupKey(fromName, normalizeSameTeamText(m.text));
      let group = msgByGroup.get(key);
      if (!group) {
        group = [];
        msgByGroup.set(key, group);
      }
      group.push({ ...m, parsedTs } as EligibleMsg);
    }
    for (const group of msgByGroup.values()) {
      group.sort((a, b) => a.parsedTs - b.parsedTs);
    }

    // FIFO pair within each group: first fingerprint → first message, second → second, etc.
    // This prevents delayed native delivery from pairing with the wrong inbox row
    // when identical messages (e.g. "Done") are sent close together.
    for (const [key, fps] of fpByGroup) {
      const msgs = msgByGroup.get(key);
      if (!msgs || msgs.length === 0) continue;

      const limit = Math.min(fps.length, msgs.length);
      for (let i = 0; i < limit; i++) {
        const fp = fps[i];
        const m = msgs[i];
        // Summary validation: if both sides have summary, they must match
        if (fp.summary && m.summary?.trim() && fp.summary !== m.summary.trim()) continue;
        // Time window validation
        if (Math.abs(m.parsedTs - fp.seenAt) > TeamProvisioningService.SAME_TEAM_MATCH_WINDOW_MS) {
          continue;
        }
        confirmedMessageIds.add(m.messageId);
        matchedFingerprintIds.add(fp.id);
      }
    }

    return { confirmedMessageIds, matchedFingerprintIds };
  }

  private rememberSameTeamNativeFingerprints(
    teamName: string,
    blocks: ParsedTeammateContent[]
  ): void {
    const teamKey = teamName.trim();
    const existing = this.recentSameTeamNativeFingerprints.get(teamKey) ?? [];
    const now = Date.now();
    const cutoff = now - TeamProvisioningService.SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS;
    const fresh = existing.filter((fp) => fp.seenAt > cutoff);

    for (const block of blocks) {
      fresh.push({
        id: randomUUID(),
        from: block.teammateId.trim(),
        text: normalizeSameTeamText(block.content),
        summary: (block.summary ?? '').trim(),
        seenAt: now,
      });
    }

    this.recentSameTeamNativeFingerprints.set(teamKey, fresh);
  }

  private consumeMatchedSameTeamFingerprints(teamName: string, matchedIds: Set<string>): void {
    if (matchedIds.size === 0) return;
    const current = this.recentSameTeamNativeFingerprints.get(teamName.trim()) ?? [];
    if (current.length === 0) return;
    const remaining = current.filter((fp) => !matchedIds.has(fp.id));
    if (remaining.length > 0) {
      this.recentSameTeamNativeFingerprints.set(teamName.trim(), remaining);
    } else {
      this.recentSameTeamNativeFingerprints.delete(teamName.trim());
    }
  }

  private getFreshSameTeamNativeFingerprints(teamName: string): NativeSameTeamFingerprint[] {
    const all = this.recentSameTeamNativeFingerprints.get(teamName) ?? [];
    if (all.length === 0) return [];
    const cutoff = Date.now() - TeamProvisioningService.SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS;
    const fresh = all.filter((fp) => fp.seenAt > cutoff);
    if (fresh.length !== all.length) {
      if (fresh.length > 0) {
        this.recentSameTeamNativeFingerprints.set(teamName, fresh);
      } else {
        this.recentSameTeamNativeFingerprints.delete(teamName);
      }
    }
    return fresh;
  }

  private isPotentialSameTeamCliMessage(m: InboxMessage, leadName: string): boolean {
    if (m.source) return false;
    const fromName = m.from?.trim() ?? '';
    if (!fromName || fromName === leadName || fromName === 'user') return false;
    const toName = m.to?.trim();
    if (toName && toName !== leadName) return false;
    return true;
  }

  private shouldDeferSameTeamMessage(
    m: InboxMessage,
    leadName: string,
    runStartedAtMs: number
  ): boolean {
    if (!this.isPotentialSameTeamCliMessage(m, leadName)) return false;
    const messageTs = Date.parse(m.timestamp);
    if (!Number.isFinite(messageTs) || messageTs < 0) return false;
    if (
      Number.isFinite(runStartedAtMs) &&
      messageTs < runStartedAtMs - TeamProvisioningService.SAME_TEAM_RUN_START_SKEW_MS
    ) {
      return false;
    }
    const ageMs = Date.now() - messageTs;
    if (ageMs < 0) return false;
    return ageMs < TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS;
  }

  private async confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: InboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }> {
    const fingerprints = this.getFreshSameTeamNativeFingerprints(teamName);
    const { confirmedMessageIds, matchedFingerprintIds } = this.collectConfirmedSameTeamPairs(
      messages,
      fingerprints,
      leadName
    );

    if (confirmedMessageIds.size === 0) {
      return { nativeMatchedMessageIds: confirmedMessageIds, persisted: true };
    }

    const toMarkRead = Array.from(confirmedMessageIds, (messageId) => ({ messageId }));
    let persisted = false;
    try {
      await this.markInboxMessagesRead(teamName, leadName, toMarkRead);
      persisted = true;
    } catch {
      // keep fingerprints alive for next attempt
    }

    if (persisted) {
      // Durable: inbox says read=true. Safe to add in-memory dedup and consume fingerprints.
      const relayedIds = this.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();
      for (const messageId of confirmedMessageIds) {
        relayedIds.add(messageId);
      }
      this.relayedLeadInboxMessageIds.set(teamName, this.trimRelayedSet(relayedIds));
      this.consumeMatchedSameTeamFingerprints(teamName, matchedFingerprintIds);
    }
    // If NOT persisted: don't add to relayedIds, don't consume fingerprints.
    // Next relay cycle will see the message in unread, re-match, and retry persist.

    return { nativeMatchedMessageIds: confirmedMessageIds, persisted };
  }

  private async reconcileSameTeamNativeDeliveries(
    teamName: string,
    leadName: string
  ): Promise<void> {
    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      return;
    }

    const { nativeMatchedMessageIds, persisted } = await this.confirmSameTeamNativeMatches(
      teamName,
      leadName,
      leadInboxMessages
    );
    // If native was matched but persist failed, schedule a quick retry
    // so we don't wait for the 16s deferred timer to retry the disk write.
    if (nativeMatchedMessageIds.size > 0 && !persisted) {
      this.scheduleSameTeamPersistRetry(teamName);
    }
  }

  private scheduleSameTeamDeferredRetry(teamName: string): void {
    const key = `same-team-deferred:${teamName}`;
    if (this.pendingTimeouts.has(key)) return;

    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.relayLeadInboxMessages(teamName).catch((e: unknown) =>
        logger.warn(`[${teamName}] same-team deferred retry failed: ${String(e)}`)
      );
    }, TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS + 1_000);

    this.pendingTimeouts.set(key, timer);
  }

  /**
   * Best-effort durable follow-up after native delivery was matched but inbox read-state
   * could not be persisted. If the run dies before this retry succeeds, a later reconnect
   * may still relay the row once because in-memory dedupe is not durable.
   */
  private scheduleSameTeamPersistRetry(teamName: string): void {
    const key = `same-team-persist:${teamName}`;
    if (this.pendingTimeouts.has(key)) return;

    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.relayLeadInboxMessages(teamName).catch((e: unknown) =>
        logger.warn(`[${teamName}] same-team persist retry failed: ${String(e)}`)
      );
    }, TeamProvisioningService.SAME_TEAM_PERSIST_RETRY_MS);

    this.pendingTimeouts.set(key, timer);
  }

  /**
   * Remove a run from tracking maps.
   */
  private cleanupRun(run: ProvisioningRun): void {
    if (run.isLaunch && !run.provisioningComplete) {
      void this.persistLaunchStateSnapshot(run, 'finished');
    }
    this.resetRuntimeToolActivity(run);
    this.setLeadActivity(run, 'offline');
    run.pendingDirectCrossTeamSendRefresh = false;
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopStallWatchdog(run);
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
      run.silentUserDmForwardClearHandle = null;
    }
    clearPostCompactReminderState(run);
    clearGeminiPostLaunchHydrationState(run);
    this.stopFilesystemMonitor(run);
    // Remove stream listeners to prevent data handlers firing on a cleaned-up run
    if (run.child) {
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
    }
    if (this.provisioningRunByTeam.get(run.teamName) === run.runId) {
      this.provisioningRunByTeam.delete(run.teamName);
    }
    if (this.aliveRunByTeam.get(run.teamName) === run.runId) {
      this.aliveRunByTeam.delete(run.teamName);
    }
    this.leadInboxRelayInFlight.delete(run.teamName);
    this.relayedLeadInboxMessageIds.delete(run.teamName);
    this.pendingCrossTeamFirstReplies.delete(run.teamName);
    this.recentCrossTeamLeadDeliveryMessageIds.delete(run.teamName);
    this.recentSameTeamNativeFingerprints.delete(run.teamName);
    // Clear same-team retry timers
    for (const suffix of ['deferred', 'persist']) {
      const key = `same-team-${suffix}:${run.teamName}`;
      const timer = this.pendingTimeouts.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimeouts.delete(key);
      }
    }
    for (const memberName of run.memberSpawnStatuses.keys()) {
      const key = this.getMemberLaunchGraceKey(run, memberName);
      const timer = this.pendingTimeouts.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimeouts.delete(key);
      }
    }
    run.activeCrossTeamReplyHints = [];
    run.pendingInboxRelayCandidates = [];
    for (const key of Array.from(this.memberInboxRelayInFlight.keys())) {
      if (key.startsWith(`${run.teamName}:`)) {
        this.memberInboxRelayInFlight.delete(key);
      }
    }
    for (const key of Array.from(this.relayedMemberInboxMessageIds.keys())) {
      if (key.startsWith(`${run.teamName}:`)) {
        this.relayedMemberInboxMessageIds.delete(key);
      }
    }
    this.liveLeadProcessMessages.delete(run.teamName);
    // Dismiss any pending tool approvals for this run
    if (run.pendingApprovals.size > 0) {
      for (const requestId of run.pendingApprovals.keys()) {
        this.clearApprovalTimeout(requestId);
        this.inFlightResponses.delete(requestId);
        this.dismissApprovalNotification(requestId);
      }
      this.emitToolApprovalEvent({ dismissed: true, teamName: run.teamName, runId: run.runId });
      run.pendingApprovals.clear();
    }
    // Clean up the generated MCP config file (best-effort, fire-and-forget)
    if (run.mcpConfigPath) {
      void this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath);
      run.mcpConfigPath = null;
    }
    if (run.bootstrapSpecPath) {
      void removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath);
      run.bootstrapSpecPath = null;
    }
    if (run.bootstrapUserPromptPath) {
      void removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath);
      run.bootstrapUserPromptPath = null;
    }
    // Remove from runs Map to free memory (stdoutBuffer, stderrBuffer, claudeLogLines)
    this.runs.delete(run.runId);
  }

  /**
   * Polls the filesystem to track provisioning progress in real time.
   * Emits progress updates as team files appear (config, inboxes, tasks).
   */
  private startFilesystemMonitor(run: ProvisioningRun, request: TeamCreateRequest): void {
    const configuredTeamDir = path.join(getTeamsBasePath(), run.teamName);
    const defaultTeamDir = path.join(getAutoDetectedClaudeBasePath(), 'teams', run.teamName);
    const tasksDir = path.join(getTasksBasePath(), run.teamName);

    const resolveTeamDir = async (): Promise<string | null> => {
      const configPath = path.join(configuredTeamDir, 'config.json');
      try {
        await fs.promises.access(configPath, fs.constants.F_OK);
        return configuredTeamDir;
      } catch {
        // fallback to default location
      }
      if (path.resolve(configuredTeamDir) !== path.resolve(defaultTeamDir)) {
        const defaultConfigPath = path.join(defaultTeamDir, 'config.json');
        try {
          await fs.promises.access(defaultConfigPath, fs.constants.F_OK);
          return defaultTeamDir;
        } catch {
          // not found in either location
        }
      }
      return null;
    };

    const countFiles = async (dir: string, ext: string): Promise<number> => {
      try {
        const entries = await fs.promises.readdir(dir);
        return entries.filter((e) => e.endsWith(ext) && !e.startsWith('.')).length;
      } catch {
        return 0;
      }
    };

    const poll = async (): Promise<void> => {
      if (run.cancelRequested || run.processKilled || run.progress.state === 'ready') {
        return;
      }

      try {
        if (run.fsPhase === 'waiting_config') {
          const teamDir = await resolveTeamDir();
          if (teamDir) {
            run.fsPhase = 'waiting_members';
            const progress = updateProgress(
              run,
              'assembling',
              'Team config created, waiting for members',
              { configReady: true }
            );
            run.onProgress(progress);
          }
        }

        if (run.fsPhase === 'waiting_members') {
          if (run.deterministicBootstrap) {
            const registeredNames = await this.getRegisteredTeamMemberNames(run.teamName);
            const registeredMembers = registeredNames
              ? request.members.filter((member) => registeredNames.has(member.name)).length
              : 0;

            if (registeredMembers >= request.members.length) {
              run.fsPhase = 'all_files_found';
              if (!run.provisioningComplete) {
                void this.handleProvisioningTurnComplete(run);
              }
              return;
            }
          }

          if (request.members.length === 0) {
            if (run.deterministicBootstrap) {
              run.fsPhase = 'all_files_found';
              if (!run.provisioningComplete) {
                void this.handleProvisioningTurnComplete(run);
              }
            } else {
              run.fsPhase = 'waiting_tasks';
              const progress = updateProgress(run, 'finalizing', 'Solo team, preparing workspace');
              run.onProgress(progress);
            }
          } else {
            const teamDir = (await resolveTeamDir()) ?? configuredTeamDir;
            const inboxDir = path.join(teamDir, 'inboxes');
            const inboxCount = await countFiles(inboxDir, '.json');
            if (inboxCount >= request.members.length) {
              run.fsPhase = 'waiting_tasks';
              const progress = updateProgress(
                run,
                'finalizing',
                `Prepared communication channels for all ${inboxCount} members, preparing workspace`
              );
              run.onProgress(progress);
            } else if (inboxCount > 0) {
              const progress = updateProgress(
                run,
                'assembling',
                `Prepared communication channels for ${inboxCount}/${request.members.length} members`
              );
              run.onProgress(progress);
            }
          }
        }

        if (run.fsPhase === 'waiting_tasks') {
          if (run.waitingTasksSince === null) {
            run.waitingTasksSince = Date.now();
          }
          const taskCount = await countFiles(tasksDir, '.json');
          const taskFound = taskCount > 0;
          const taskFallbackExpired =
            !taskFound && Date.now() - run.waitingTasksSince >= TASK_WAIT_FALLBACK_MS;

          if (taskFound || taskFallbackExpired) {
            run.fsPhase = 'all_files_found';
            // Mark provisioning complete early — files are on disk,
            // no need to wait for stream-json result.success.
            // The process stays alive for subsequent tasks.
            if (!run.provisioningComplete) {
              void this.handleProvisioningTurnComplete(run);
            }
          }
        }
      } catch (error) {
        logger.debug(
          `FS monitor poll error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    run.fsMonitorHandle = setInterval(() => {
      void poll();
    }, FS_MONITOR_POLL_MS);
    // Best-effort monitor; should not keep the process alive.
    run.fsMonitorHandle.unref();

    // Run first poll immediately
    void poll();
  }

  private stopFilesystemMonitor(run: ProvisioningRun): void {
    if (run.fsMonitorHandle) {
      clearInterval(run.fsMonitorHandle);
      run.fsMonitorHandle = null;
    }
  }

  private async handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void> {
    if (run.finalizingByTimeout) {
      return;
    }
    if (run.progress.state === 'failed' || run.cancelRequested) {
      return;
    }
    // Skip if respawn after auth failure is in progress — the old process is being replaced
    if (run.authRetryInProgress) {
      logger.info(
        `[${run.teamName}] Process exited (code ${code ?? '?'}) during auth-failure respawn — ignoring`
      );
      return;
    }

    // IMPORTANT: stopStallWatchdog MUST be AFTER authRetryInProgress guard above!
    // During respawn, the old process exit fires but run.stallCheckHandle already
    // points to the NEW process's watchdog. Stopping it here would kill the wrong timer.
    // The authRetryInProgress guard returns early, keeping the new watchdog alive.
    this.stopStallWatchdog(run);

    // === Process exited AFTER provisioning completed ===
    // This means the team went offline (crash, kill, or natural exit).
    if (run.provisioningComplete) {
      const message =
        code === 0
          ? 'Team process exited normally'
          : `Team process exited unexpectedly (code ${code ?? 'unknown'})`;
      logger.info(`[${run.teamName}] ${message}`);
      const progress = updateProgress(run, 'disconnected', message, {
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    // === Process exited DURING provisioning ===
    // Try to verify if files were created before the process died.
    updateProgress(run, 'verifying', 'Process exited — verifying provisioning results');
    run.onProgress(run.progress);

    if (run.cancelRequested) {
      return;
    }

    const configProbe = await this.waitForValidConfig(run);
    if (run.cancelRequested) {
      return;
    }

    if (configProbe.ok && configProbe.location === 'default') {
      const configuredTeamsBasePath = getTeamsBasePath();
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error:
          `TeamCreate produced config.json under a different Claude root (${configProbe.configPath}). ` +
          `This app is configured to read teams from ${configuredTeamsBasePath}. ` +
          'Align the app Claude root setting with the CLI, then retry.',
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    const visibleInList =
      configProbe.ok && configProbe.location === 'configured'
        ? await this.waitForTeamInList(run.teamName, run)
        : false;
    if (run.cancelRequested) {
      return;
    }

    if (configProbe.ok && visibleInList) {
      // Files exist but process died — provisioned but not alive.
      const warnings: string[] = [
        `CLI process exited (code ${code ?? 'unknown'}) — team provisioned but not alive`,
      ];
      const missingInboxes = await this.waitForMissingInboxes(run);
      if (run.cancelRequested) {
        return;
      }
      if (missingInboxes.length > 0) {
        warnings.push('Some inboxes not created yet');
      }
      if (!run.isLaunch) {
        await this.persistMembersMeta(run.teamName, run.request);
      }
      // Mark as disconnected since the process is dead
      const progress = updateProgress(
        run,
        'disconnected',
        'Team provisioned but process is no longer alive',
        {
          warnings,
          cliLogsTail: extractCliLogsFromRun(run),
        }
      );
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    if (code === 0) {
      const configuredConfigPath = path.join(getTeamsBasePath(), run.teamName, 'config.json');
      const defaultTeamsBasePath = path.join(getAutoDetectedClaudeBasePath(), 'teams');
      const defaultConfigPath = path.join(defaultTeamsBasePath, run.teamName, 'config.json');
      const combinedLogs = buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer);
      const cleanupHint = logsSuggestShutdownOrCleanup(combinedLogs)
        ? ' CLI output suggests the team was shut down / cleaned up, so no persisted config was left on disk.'
        : '';

      const errorMessage = !configProbe.ok
        ? `No valid config.json found at ${configuredConfigPath}${
            path.resolve(defaultTeamsBasePath) === path.resolve(getTeamsBasePath())
              ? ''
              : ` (also checked ${defaultConfigPath})`
          } within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s.${cleanupHint}`
        : 'Team did not appear in team:list after provisioning';
      const progress = updateProgress(run, 'failed', 'Provisioning failed validation', {
        error: errorMessage,
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    const errorText = buildCliExitError(code, run.stdoutBuffer, run.stderrBuffer);
    const progress = updateProgress(run, 'failed', 'Claude CLI exited with an error', {
      error: errorText,
      cliLogsTail: extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    this.cleanupRun(run);
    logger.warn(`Provisioning failed for ${run.teamName}: ${progress.error ?? errorText}`);
  }

  private async waitForValidConfig(
    run: ProvisioningRun,
    timeoutMs: number = VERIFY_TIMEOUT_MS
  ): Promise<ValidConfigProbeResult> {
    const probes = run.teamsBasePathsToProbe.map((probe) => ({
      ...probe,
      configPath: path.join(probe.basePath, run.teamName, 'config.json'),
    }));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (run.cancelRequested) {
        return { ok: false };
      }
      for (const probe of probes) {
        try {
          const raw = await tryReadRegularFileUtf8(probe.configPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_CONFIG_MAX_BYTES,
          });
          if (!raw) {
            continue;
          }
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object') {
            const candidate = parsed as { name?: unknown };
            if (typeof candidate.name === 'string' && candidate.name.trim().length > 0) {
              return { ok: true, location: probe.location, configPath: probe.configPath };
            }
          }
        } catch {
          // Best-effort polling until deadline.
        }
      }
      await sleep(VERIFY_POLL_MS);
    }

    return { ok: false };
  }

  private async waitForTeamInList(teamName: string, run?: ProvisioningRun): Promise<boolean> {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (run?.cancelRequested) {
        return false;
      }
      try {
        const teams = await this.configReader.listTeams();
        if (teams.some((team) => team.teamName === teamName)) {
          return true;
        }
      } catch {
        // Keep polling until deadline.
      }
      await sleep(VERIFY_POLL_MS);
    }
    return false;
  }

  private async waitForMissingInboxes(run: ProvisioningRun): Promise<string[]> {
    if (run.expectedMembers.length === 0) {
      return [];
    }
    const inboxDir = path.join(getTeamsBasePath(), run.teamName, 'inboxes');
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let missing = new Set(run.expectedMembers);

    while (Date.now() < deadline && missing.size > 0) {
      if (run.cancelRequested || run.progress.state === 'cancelled') {
        return Array.from(missing);
      }
      const nextMissing = new Set<string>();
      for (const member of missing) {
        const inboxPath = path.join(inboxDir, `${member}.json`);
        if (!(await this.pathExists(inboxPath))) {
          nextMissing.add(member);
        }
      }
      missing = nextMissing;
      if (missing.size === 0) {
        break;
      }
      await sleep(VERIFY_POLL_MS);
    }

    return Array.from(missing);
  }

  private async tryCompleteAfterTimeout(run: ProvisioningRun): Promise<boolean> {
    if (run.cancelRequested) {
      return false;
    }

    const configProbe = await this.waitForValidConfig(run);
    if (!configProbe.ok || configProbe.location !== 'configured') {
      return false;
    }

    const visibleInList = await this.waitForTeamInList(run.teamName);
    if (!visibleInList) {
      return false;
    }

    const warnings: string[] = [
      'CLI timed out after config was created — team provisioned but process killed',
    ];
    const missingInboxes = await this.waitForMissingInboxes(run);
    if (run.cancelRequested) {
      return false;
    }
    if (missingInboxes.length > 0) {
      warnings.push('Some inboxes not created yet');
    }

    if (!run.isLaunch) {
      await this.persistMembersMeta(run.teamName, run.request);
    }
    // Persist team color even on timeout path
    await this.updateConfigPostLaunch(
      run.teamName,
      run.request.cwd,
      run.detectedSessionId,
      run.request.color,
      {
        providerId: run.request.providerId,
        model: run.request.model,
        effort: run.request.effort,
        members: run.effectiveMembers,
      }
    );
    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run, { force: true });
    await this.finalizeMissingRegisteredMembersAsFailed(run);
    await this.persistLaunchStateSnapshot(run, 'finished');
    // Process was killed by timeout — mark as disconnected, not ready
    const progress = updateProgress(run, 'disconnected', 'Team provisioned but process timed out', {
      warnings,
    });
    run.onProgress(progress);
    this.cleanupRun(run);
    return true;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async buildProvisioningEnv(
    providerId: TeamProviderId | undefined = 'anthropic'
  ): Promise<ProvisioningEnvResolution> {
    const shellEnv = await resolveInteractiveShellEnv();
    // getHomeDir() uses Electron's app.getPath('home') which handles Unicode
    // correctly on Windows. Prefer it over process.env which may be garbled.
    const electronHome = getHomeDir();
    const isWindows = process.platform === 'win32';
    const home = shellEnv.HOME?.trim() || electronHome;
    let osUsername = '';
    try {
      osUsername = os.userInfo().username;
    } catch {
      // os.userInfo() can throw SystemError in restricted environments (no passwd entry, Docker, etc.)
    }
    const user =
      shellEnv.USER?.trim() ||
      process.env.USER?.trim() ||
      process.env.USERNAME?.trim() ||
      osUsername ||
      'unknown';

    // Shell: on Windows there is no SHELL env var; use COMSPEC (cmd.exe / powershell).
    // On Unix, prefer the user's login shell from env or fall back to /bin/zsh.
    const shell = isWindows
      ? (process.env.COMSPEC ?? 'powershell.exe')
      : shellEnv.SHELL?.trim() || process.env.SHELL?.trim() || '/bin/zsh';

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...shellEnv,
      HOME: home,
      USERPROFILE: home,
      USER: user,
      LOGNAME: shellEnv.LOGNAME?.trim() || process.env.LOGNAME?.trim() || user,
      TERM: shellEnv.TERM?.trim() || process.env.TERM?.trim() || 'xterm-256color',
      // Only set CLAUDE_CONFIG_DIR when the user configured a custom path.
      // Setting it to the default ~/.claude changes the macOS Keychain namespace
      // for OAuth credential lookup, causing auth failures. (See issue #27)
      ...(getClaudeBasePath() !== getAutoDetectedClaudeBasePath()
        ? { CLAUDE_CONFIG_DIR: getClaudeBasePath() }
        : {}),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };
    const resolvedProviderId = resolveTeamProviderId(providerId);
    const providerEnvResult = await buildProviderAwareCliEnv({
      providerId,
      shellEnv,
      env,
    });
    const providerConnectionIssue = providerEnvResult.connectionIssues[resolvedProviderId];
    const providerEnv = providerEnvResult.env;

    const controlApiBaseUrl = await this.resolveControlApiBaseUrl();
    if (controlApiBaseUrl) {
      providerEnv.CLAUDE_TEAM_CONTROL_URL = controlApiBaseUrl;
    }

    // SHELL is a Unix concept — only set it on non-Windows platforms.
    if (!isWindows) {
      providerEnv.SHELL = shell;
    }

    // XDG directories are a freedesktop.org (Linux/macOS) convention.
    // On Windows, these are unused by most tools and can cause confusion.
    if (!isWindows) {
      const xdgConfigHome =
        shellEnv.XDG_CONFIG_HOME?.trim() ||
        process.env.XDG_CONFIG_HOME?.trim() ||
        `${home}/.config`;
      const xdgStateHome =
        shellEnv.XDG_STATE_HOME?.trim() ||
        process.env.XDG_STATE_HOME?.trim() ||
        `${home}/.local/state`;
      providerEnv.XDG_CONFIG_HOME = xdgConfigHome;
      providerEnv.XDG_STATE_HOME = xdgStateHome;
    }

    if (providerConnectionIssue) {
      return {
        env: providerEnv,
        authSource: 'configured_api_key_missing',
        geminiRuntimeAuth: null,
        warning: providerConnectionIssue,
      };
    }

    if (resolvedProviderId === 'codex') {
      return { env: providerEnv, authSource: 'codex_runtime', geminiRuntimeAuth: null };
    }

    if (resolvedProviderId === 'gemini') {
      return {
        env: providerEnv,
        authSource: 'gemini_runtime',
        geminiRuntimeAuth: await resolveGeminiRuntimeAuth(providerEnv),
      };
    }

    // 1. Explicit ANTHROPIC_API_KEY — works with `-p` mode directly
    if (
      typeof providerEnv.ANTHROPIC_API_KEY === 'string' &&
      providerEnv.ANTHROPIC_API_KEY.trim().length > 0
    ) {
      return { env: providerEnv, authSource: 'anthropic_api_key', geminiRuntimeAuth: null };
    }

    // 2. Proxy token (ANTHROPIC_AUTH_TOKEN) — `-p` mode does NOT read this var,
    //    so we must copy it into ANTHROPIC_API_KEY for it to work.
    if (
      typeof providerEnv.ANTHROPIC_AUTH_TOKEN === 'string' &&
      providerEnv.ANTHROPIC_AUTH_TOKEN.trim().length > 0
    ) {
      providerEnv.ANTHROPIC_API_KEY = providerEnv.ANTHROPIC_AUTH_TOKEN;
      return { env: providerEnv, authSource: 'anthropic_auth_token', geminiRuntimeAuth: null };
    }

    // 3. No explicit API key — let the CLI handle its own OAuth auth.
    //    Claude CLI reads credentials from its own storage and refreshes
    //    tokens in-memory. Injecting CLAUDE_CODE_OAUTH_TOKEN from the
    //    credentials file causes 401 errors because the stored token is
    //    often stale (CLI refreshes in-memory but rarely writes back).
    return { env: providerEnv, authSource: 'none', geminiRuntimeAuth: null };
  }

  private async resolveControlApiBaseUrl(): Promise<string | null> {
    if (!this.controlApiBaseUrlResolver) {
      return null;
    }

    try {
      return await this.controlApiBaseUrlResolver();
    } catch (error) {
      logger.warn(
        `Failed to resolve team control API base URL: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  /**
   * Immediately update projectPath in config.json at launch start, before CLI spawn.
   * Ensures TeamDetailView shows the correct project path even if provisioning
   * is interrupted. On failure, restorePrelaunchConfig() reverts to the backup.
   */
  private async updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        throw new Error('config.json unreadable');
      }
      const config = JSON.parse(raw) as Record<string, unknown>;

      config.projectPath = cwd;

      const pathHistory = Array.isArray(config.projectPathHistory)
        ? (config.projectPathHistory as string[]).filter((p) => typeof p === 'string' && p !== cwd)
        : [];
      pathHistory.push(cwd);
      config.projectPathHistory = pathHistory.slice(-500);

      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
      logger.info(`[${teamName}] Updated config.projectPath immediately: ${cwd}`);
    } catch (error) {
      // Non-fatal: updateConfigPostLaunch will update it later if provisioning succeeds.
      logger.warn(
        `[${teamName}] Failed to update projectPath early: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private applyEffectiveLaunchStateToConfig(
    config: Record<string, unknown>,
    launchState?: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
      members?: TeamCreateRequest['members'];
    }
  ): void {
    if (!launchState || !Array.isArray(config.members)) {
      return;
    }

    const effectiveLeadProviderId =
      normalizeTeamMemberProviderId(launchState.providerId) ?? 'anthropic';
    const effectiveLeadModel = launchState.model?.trim() || undefined;
    const effectiveLeadEffort =
      launchState.effort === 'low' ||
      launchState.effort === 'medium' ||
      launchState.effort === 'high'
        ? launchState.effort
        : undefined;

    const membersByName = new Map(
      (launchState.members ?? []).map((member) => [member.name.toLowerCase(), member] as const)
    );

    config.members = (config.members as Record<string, unknown>[]).map((member) => {
      if (!member || typeof member !== 'object') {
        return member;
      }

      const rawName = typeof member.name === 'string' ? member.name.trim() : '';
      const nextMember = { ...member };

      const assignRuntimeState = (state: {
        providerId?: TeamProviderId;
        model?: string;
        effort?: TeamCreateRequest['effort'];
      }): void => {
        const providerId = normalizeTeamMemberProviderId(state.providerId);
        if (providerId) {
          nextMember.provider = providerId;
          nextMember.providerId = providerId;
        } else {
          delete nextMember.provider;
          delete nextMember.providerId;
        }

        const model = state.model?.trim() || undefined;
        if (model) {
          nextMember.model = model;
        } else {
          delete nextMember.model;
        }

        const effort =
          state.effort === 'low' || state.effort === 'medium' || state.effort === 'high'
            ? state.effort
            : undefined;
        if (effort) {
          nextMember.effort = effort;
        } else {
          delete nextMember.effort;
        }
      };

      if (isLeadMember(nextMember) || rawName.toLowerCase() === 'team-lead') {
        assignRuntimeState({
          providerId: effectiveLeadProviderId,
          model: effectiveLeadModel,
          effort: effectiveLeadEffort,
        });
        return nextMember;
      }

      const effectiveMember = membersByName.get(rawName.toLowerCase());
      if (!effectiveMember) {
        return nextMember;
      }

      assignRuntimeState({
        providerId: effectiveMember.providerId,
        model: effectiveMember.model,
        effort: effectiveMember.effort,
      });
      return nextMember;
    });
  }

  /**
   * Single atomic read-mutate-write for post-launch config updates.
   * Combines session history append and projectPath update to avoid
   * race conditions with the CLI writing to the same file.
   */
  private async updateConfigPostLaunch(
    teamName: string,
    projectPath: string,
    detectedSessionId: string | null,
    color?: string,
    launchState?: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
      members?: TeamCreateRequest['members'];
    }
  ): Promise<void> {
    const MAX_SESSION_HISTORY = 5000;
    const MAX_PROJECT_PATH_HISTORY = 500;
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        throw new Error('config.json unreadable');
      }
      const config = JSON.parse(raw) as Record<string, unknown>;

      const sessionHistory = Array.isArray(config.sessionHistory)
        ? (config.sessionHistory as string[])
        : [];

      // Preserve old leadSessionId in history before overwriting
      const oldLeadSessionId = config.leadSessionId;
      if (typeof oldLeadSessionId === 'string' && oldLeadSessionId.trim().length > 0) {
        if (!sessionHistory.includes(oldLeadSessionId)) {
          sessionHistory.push(oldLeadSessionId);
        }
      }

      // Update leadSessionId to the new session detected from stream-json
      let newSessionId = detectedSessionId;

      // Fallback: if stream-json didn't provide session_id, scan project dir for newest JSONL
      if (!newSessionId && projectPath.trim()) {
        const scannedId = await this.scanForNewestSession(projectPath, sessionHistory);
        if (scannedId) {
          newSessionId = scannedId;
          logger.info(`[${teamName}] Detected new session via project dir scan: ${scannedId}`);
        }
      }

      if (newSessionId) {
        config.leadSessionId = newSessionId;
        if (!sessionHistory.includes(newSessionId)) {
          sessionHistory.push(newSessionId);
        }
        logger.info(`[${teamName}] Updated leadSessionId: ${newSessionId}`);
      }

      if (sessionHistory.length > MAX_SESSION_HISTORY) {
        config.sessionHistory = sessionHistory.slice(-MAX_SESSION_HISTORY);
      } else {
        config.sessionHistory = sessionHistory;
      }

      // Save current language setting
      const langCode = ConfigManager.getInstance().getConfig().general.agentLanguage || 'system';
      config.language = langCode;

      // Persist team color chosen by the user during creation
      if (color && color.trim().length > 0) {
        config.color = color.trim();
      }

      // Ensure projectPath
      if (projectPath.trim()) {
        config.projectPath = projectPath;
        const pathHistory = Array.isArray(config.projectPathHistory)
          ? (config.projectPathHistory as string[]).filter(
              (p) => typeof p === 'string' && p !== projectPath
            )
          : [];
        pathHistory.push(projectPath);
        config.projectPathHistory =
          pathHistory.length > MAX_PROJECT_PATH_HISTORY
            ? pathHistory.slice(-MAX_PROJECT_PATH_HISTORY)
            : pathHistory;
      }

      this.applyEffectiveLaunchStateToConfig(config, launchState);

      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to update config post-launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');

    const removedFromConfig: string[] = [];
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const membersRaw = Array.isArray(parsed.members)
          ? (parsed.members as Record<string, unknown>[])
          : [];
        if (membersRaw.length > 0) {
          const teammateNames = membersRaw
            .map((m) => (typeof m.name === 'string' ? m.name.trim() : ''))
            .filter(
              (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
            );

          const keepName = createCliAutoSuffixNameGuard(teammateNames);
          const nextMembers: Record<string, unknown>[] = [];
          for (const m of membersRaw) {
            const name = typeof m.name === 'string' ? m.name.trim() : '';
            const agentType = typeof m.agentType === 'string' ? m.agentType : '';
            if (!name) continue;
            if (isLeadMember(m) || name === 'user') {
              nextMembers.push(m);
              continue;
            }
            if (!keepName(name)) {
              removedFromConfig.push(name);
              continue;
            }
            nextMembers.push(m);
          }

          if (removedFromConfig.length > 0) {
            parsed.members = nextMembers;
            await atomicWriteAsync(configPath, JSON.stringify(parsed, null, 2));
            logger.warn(
              `[${teamName}] Removed CLI auto-suffixed members from config.json: ${removedFromConfig.join(', ')}`
            );
          }
        }
      }
    } catch {
      // best-effort
    }

    let activeNamesForInboxCleanup = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const activeNames = metaMembers
          .filter((m) => !m.removedAt)
          .map((m) => m.name.trim())
          .filter(
            (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
          );

        const keepName = createCliAutoSuffixNameGuard(activeNames);
        const removedFromMeta: string[] = [];
        const nextMeta = metaMembers.filter((m) => {
          const name = m.name?.trim() ?? '';
          if (!name) return false;
          const lower = name.toLowerCase();
          if (lower === 'user' || isLeadMember(m)) return true;
          if (!m.removedAt && !keepName(name)) {
            removedFromMeta.push(name);
            return false;
          }
          return true;
        });

        if (removedFromMeta.length > 0) {
          await this.membersMetaStore.writeMembers(teamName, nextMeta);
          logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from members.meta.json: ${removedFromMeta.join(', ')}`
          );
        }

        activeNamesForInboxCleanup = new Set(
          nextMeta
            .filter((m) => !m.removedAt)
            .map((m) => m.name.trim())
            .filter(
              (n) => n.length > 0 && n.toLowerCase() !== 'team-lead' && n.toLowerCase() !== 'user'
            )
        );
      }
    } catch {
      // best-effort
    }

    // Also attempt inbox cleanup (merge alice-2.json into alice.json).
    if (activeNamesForInboxCleanup.size > 0) {
      try {
        await this.mergeAndRemoveDuplicateInboxes(teamName, activeNamesForInboxCleanup);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Fallback: scan the project directory for the newest JSONL file
   * that isn't already in sessionHistory. Returns the session ID or null.
   */
  private async scanForNewestSession(
    projectPath: string,
    knownSessions: string[]
  ): Promise<string | null> {
    try {
      const projectId = encodePath(projectPath);
      const baseDir = extractBaseDir(projectId);
      const projectDir = path.join(getProjectsBasePath(), baseDir);
      const entries = await fs.promises.readdir(projectDir);

      const knownSet = new Set(knownSessions);
      let newest: { id: string; mtime: number } | null = null;

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const sessionId = entry.replace('.jsonl', '');
        if (knownSet.has(sessionId)) continue;

        const filePath = path.join(projectDir, entry);
        const stat = await fs.promises.stat(filePath);
        if (!newest || stat.mtimeMs > newest.mtime) {
          newest = { id: sessionId, mtime: stat.mtimeMs };
        }
      }

      return newest?.id ?? null;
    } catch {
      return null;
    }
  }

  private async assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const raw = await tryReadRegularFileUtf8(configPath, {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
    if (!raw) {
      throw new Error('config.json unreadable');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('config.json could not be parsed');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('config.json has invalid shape');
    }

    const config = parsed as Record<string, unknown>;
    const members = Array.isArray(config.members)
      ? (config.members as Record<string, unknown>[])
      : [];
    if (members.length === 0) return;

    for (const member of members) {
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      if (!name) continue;
      const lower = name.toLowerCase();

      if (isLeadMember(member) || lower === 'user') continue;

      const leadAgentId = config.leadAgentId;
      if (
        typeof leadAgentId === 'string' &&
        typeof member.agentId === 'string' &&
        member.agentId === leadAgentId
      ) {
        continue;
      }

      throw new Error(
        `Refusing to launch: config.json still contains teammates (e.g. "${name}"), which can trigger CLI auto-suffixes like "${name}-2".`
      );
    }
  }

  private async normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(configRaw) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const config = parsed as Record<string, unknown>;
    const members = Array.isArray(config.members)
      ? (config.members as Record<string, unknown>[])
      : [];
    if (members.length === 0) {
      return;
    }

    // Keep only the lead entry.
    const leadMembers = members.filter((member) => {
      const agentType = member.agentType;
      if (typeof agentType === 'string' && isLeadAgentType(agentType)) {
        return true;
      }
      // Also check by name (CLI may set agentType to "general-purpose" for leads)
      const name = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
      if (name === 'team-lead') return true;
      const leadAgentId = config.leadAgentId;
      return (
        typeof leadAgentId === 'string' &&
        typeof member.agentId === 'string' &&
        member.agentId === leadAgentId
      );
    });

    // If already lead-only, no-op.
    if (leadMembers.length === members.length) {
      return;
    }

    // Try to determine base teammate names for inbox cleanup (prefer meta).
    const baseNames = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      for (const member of metaMembers) {
        const name = member.name.trim();
        const lower = name.toLowerCase();
        if (name.length > 0 && !member.removedAt && lower !== 'team-lead' && lower !== 'user') {
          baseNames.add(name);
        }
      }
    } catch {
      // ignore
    }
    if (baseNames.size === 0) {
      const allConfigNames = new Set<string>();
      for (const member of members) {
        const name = typeof member.name === 'string' ? member.name.trim() : '';
        const agentType = typeof member.agentType === 'string' ? member.agentType : '';
        if (
          name &&
          agentType &&
          !isLeadAgentType(agentType) &&
          name !== 'team-lead' &&
          name !== 'user'
        ) {
          allConfigNames.add(name);
        }
      }
      const allConfigNamesLower = new Set(Array.from(allConfigNames).map((n) => n.toLowerCase()));
      for (const name of allConfigNames) {
        const match = /^(.+)-(\d+)$/.exec(name);
        if (!match?.[1] || !match[2]) {
          baseNames.add(name);
          continue;
        }
        const suffix = Number(match[2]);
        // Only exclude CLI-suffixed names (alice-2) when the base name (alice) also exists
        // (and only for -2+ to avoid excluding legitimate "dev-1"-style names).
        if (!Number.isFinite(suffix) || suffix < 2) {
          baseNames.add(name);
          continue;
        }
        if (!allConfigNamesLower.has(match[1].toLowerCase())) {
          baseNames.add(name);
        }
      }
    }

    // Backup current config on disk for crash recovery / debugging.
    try {
      await atomicWriteAsync(backupPath, configRaw);
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to write config prelaunch backup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Write normalized config atomically.
    config.members = leadMembers;
    try {
      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
      logger.info(
        `[${teamName}] Normalized config.json for launch: kept ${leadMembers.length} lead member(s)`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to normalize config.json for launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    // Best-effort: merge and remove suffixed inboxes like alice-2.json to avoid UI duplicates.
    await this.mergeAndRemoveDuplicateInboxes(teamName, baseNames);
  }

  /**
   * Restore config.json from prelaunch backup if launch fails after normalization.
   */
  private async restorePrelaunchConfig(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    try {
      const backupRaw = await tryReadRegularFileUtf8(backupPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!backupRaw) {
        return;
      }
      await atomicWriteAsync(configPath, backupRaw);
      logger.info(`[${teamName}] Restored config.json from prelaunch backup after launch failure`);
    } catch {
      logger.debug(`[${teamName}] No prelaunch backup to restore (or read failed)`);
    }
  }

  /**
   * Remove the prelaunch backup file after a successful launch.
   */
  async cleanupPrelaunchBackup(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = `${configPath}.prelaunch.bak`;
    try {
      await fs.promises.unlink(backupPath);
    } catch {
      // Backup may not exist — that's fine
    }
  }

  private async mergeAndRemoveDuplicateInboxes(
    teamName: string,
    baseNames: Set<string>
  ): Promise<void> {
    if (baseNames.size === 0) return;

    const inboxDir = path.join(getTeamsBasePath(), teamName, 'inboxes');
    let entries: string[];
    try {
      entries = await fs.promises.readdir(inboxDir);
    } catch {
      return;
    }

    const existing = new Set(entries.filter((e) => e.endsWith('.json') && !e.startsWith('.')));

    for (const baseName of baseNames) {
      const canonicalFile = `${baseName}.json`;
      if (!existing.has(canonicalFile)) {
        continue;
      }

      const duplicates = Array.from(existing)
        .filter((file) => file.startsWith(`${baseName}-`) && file.endsWith('.json'))
        .filter((file) => /-\d+\.json$/.test(file));

      if (duplicates.length === 0) {
        continue;
      }

      const canonicalPath = path.join(inboxDir, canonicalFile);
      let canonicalRaw: string;
      try {
        const raw = await tryReadRegularFileUtf8(canonicalPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_INBOX_MAX_BYTES,
        });
        if (!raw) {
          continue;
        }
        canonicalRaw = raw;
      } catch {
        // If cannot read, skip cleanup for this base.
        continue;
      }

      let canonicalParsed: unknown;
      try {
        canonicalParsed = JSON.parse(canonicalRaw) as unknown;
      } catch {
        canonicalParsed = [];
      }
      const canonicalList = Array.isArray(canonicalParsed) ? (canonicalParsed as unknown[]) : [];

      const merged = [...canonicalList];
      for (const dupFile of duplicates) {
        const dupPath = path.join(inboxDir, dupFile);
        let dupRaw: string;
        try {
          const raw = await tryReadRegularFileUtf8(dupPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_INBOX_MAX_BYTES,
          });
          if (!raw) {
            continue;
          }
          dupRaw = raw;
        } catch {
          continue;
        }

        let dupParsed: unknown;
        try {
          dupParsed = JSON.parse(dupRaw) as unknown;
        } catch {
          dupParsed = [];
        }
        if (Array.isArray(dupParsed)) {
          const dupList = dupParsed as unknown[];
          merged.push(...dupList);
        }
      }

      // Dedup by messageId when available, then sort by timestamp desc.
      const dedupById = new Map<string, unknown>();
      const noId: unknown[] = [];
      for (const item of merged) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const msg = item as { messageId?: unknown };
        if (typeof msg.messageId === 'string' && msg.messageId.trim().length > 0) {
          dedupById.set(msg.messageId, item);
        } else {
          noId.push(item);
        }
      }
      const mergedDeduped = [...Array.from(dedupById.values()), ...noId];
      mergedDeduped.sort((a, b) => {
        const at =
          a && typeof a === 'object'
            ? Date.parse((a as { timestamp?: string }).timestamp ?? '')
            : NaN;
        const bt =
          b && typeof b === 'object'
            ? Date.parse((b as { timestamp?: string }).timestamp ?? '')
            : NaN;
        const atNaN = Number.isNaN(at);
        const btNaN = Number.isNaN(bt);
        if (atNaN && btNaN) return 0;
        if (atNaN) return 1;
        if (btNaN) return -1;
        return bt - at;
      });

      try {
        await atomicWriteAsync(canonicalPath, JSON.stringify(mergedDeduped, null, 2));
      } catch {
        continue;
      }

      for (const dupFile of duplicates) {
        try {
          await fs.promises.unlink(path.join(inboxDir, dupFile));
          existing.delete(dupFile);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private async persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    const teammateMembers = request.members.filter((member) => {
      const trimmed = member.name.trim();
      const lower = trimmed.toLowerCase();
      return trimmed.length > 0 && lower !== 'team-lead' && lower !== 'user';
    });
    if (teammateMembers.length === 0) {
      return;
    }

    const joinedAt = Date.now();

    try {
      await this.membersMetaStore.writeMembers(
        teamName,
        teammateMembers.map((member) => ({
          name: member.name.trim(),
          role: member.role?.trim() || undefined,
          workflow: member.workflow?.trim() || undefined,
          providerId: normalizeOptionalTeamProviderId(member.providerId),
          model: member.model?.trim() || undefined,
          effort:
            member.effort === 'low' || member.effort === 'medium' || member.effort === 'high'
              ? member.effort
              : undefined,
          agentType: 'general-purpose',
          color: getMemberColorByName(member.name.trim()),
          joinedAt,
        }))
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to persist members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async resolveLaunchExpectedMembers(
    teamName: string,
    configRaw: string
  ): Promise<{
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  }> {
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      const byName = new Map<string, TeamCreateRequest['members'][number]>();
      for (const member of metaMembers) {
        const rawName = member.name?.trim() ?? '';
        const lower = rawName.toLowerCase();
        if (isLeadMember(member) || lower === 'user') {
          continue;
        }
        const name = rawName;
        if (!name) continue;
        if (member.removedAt) continue;
        const role = typeof member.role === 'string' ? member.role.trim() || undefined : undefined;
        const workflow =
          typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined;
        const providerId = normalizeOptionalTeamProviderId(member.providerId);
        const model =
          typeof member.model === 'string' ? member.model.trim() || undefined : undefined;
        const effort =
          member.effort === 'low' || member.effort === 'medium' || member.effort === 'high'
            ? member.effort
            : undefined;
        const prev = byName.get(name);
        if (!prev) {
          byName.set(name, { name, role, workflow, providerId, model, effort });
        } else {
          byName.set(name, {
            ...prev,
            role: prev.role || role,
            workflow: prev.workflow || workflow,
            providerId: prev.providerId || providerId,
            model: prev.model || model,
            effort: prev.effort || effort,
          });
        }
      }
      // Defense: ignore CLI auto-suffixed duplicates (alice-2) when base name exists.
      const allNames = Array.from(byName.keys());
      const keepName = createCliAutoSuffixNameGuard(allNames);
      for (const name of allNames) {
        if (!keepName(name)) {
          byName.delete(name);
        }
      }
      const members = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (members.length > 0) {
        return { members, source: 'members-meta' };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      const allInboxNames = Array.from(
        new Set(
          (await this.inboxReader.listInboxNames(teamName))
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
        )
      );
      const inboxNameSetLower = new Set(allInboxNames.map((n) => n.toLowerCase()));
      const inboxNames = allInboxNames
        .filter((name) => name !== 'team-lead' && name !== 'user')
        .filter((name) => !this.isCrossTeamPseudoRecipientName(name))
        .filter((name) => !this.isCrossTeamToolRecipientName(name))
        .filter((name) => !this.looksLikeQualifiedExternalRecipientName(name))
        .filter((name) => {
          const match = /^(.+)-(\d+)$/.exec(name);
          if (!match?.[1] || !match[2]) return true;
          const suffix = Number(match[2]);
          // Only filter CLI-suffixed names (alice-2) when the base name (alice) also exists.
          // Important: do NOT filter names like dev-1 (common intentional naming). Only consider -2+ as auto-suffix.
          if (!Number.isFinite(suffix) || suffix < 2) return true;
          return !inboxNameSetLower.has(match[1].toLowerCase());
        });
      if (inboxNames.length > 0) {
        const configMembers = this.extractTeammateSpecsFromConfig(teamName, configRaw);
        const configMembersByName = new Map(
          configMembers.map((member) => [member.name.toLowerCase(), member] as const)
        );
        const members = inboxNames.map((name) => {
          const configMember = configMembersByName.get(name.toLowerCase());
          return {
            name,
            role: configMember?.role,
            workflow: configMember?.workflow,
            providerId: configMember?.providerId,
            model: configMember?.model,
            effort: configMember?.effort,
          };
        });
        const memberOverridesUsed = members.some(
          (member) => member.providerId || member.model || member.effort
        );
        return {
          members,
          source: 'inboxes',
          ...(memberOverridesUsed
            ? {
                warning:
                  'Launch roster was recovered from inboxes and merged with config.json provider/model/effort overrides. ' +
                  'Multimodel reconnect is best-effort in this fallback path.',
              }
            : {}),
        };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read inbox member names: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const configMembers = this.extractTeammateSpecsFromConfig(teamName, configRaw);
    if (configMembers.length > 0) {
      return {
        members: configMembers,
        source: 'config-fallback',
        warning:
          'members.meta.json and inboxes are empty; launch fell back to config.json members. ' +
          'Run a fresh team bootstrap to persist stable member metadata.',
      };
    }

    let configParseFailed = false;
    try {
      JSON.parse(configRaw);
    } catch {
      configParseFailed = true;
    }

    return {
      members: [],
      source: 'config-fallback',
      ...(configParseFailed
        ? {
            warning:
              'Config could not be parsed during launch roster discovery. ' +
              'Launch will continue without explicit teammate names.',
          }
        : {}),
    };
  }

  private extractTeammateSpecsFromConfig(
    teamName: string,
    configRaw: string
  ): TeamCreateRequest['members'] {
    try {
      const parsed = JSON.parse(configRaw) as {
        members?: {
          name?: string;
          role?: string;
          workflow?: string;
          agentType?: string;
          providerId?: string;
          provider?: string;
          model?: string;
          effort?: string;
        }[];
      };
      if (!Array.isArray(parsed.members)) {
        return [];
      }
      const byName = new Map<string, TeamCreateRequest['members'][number]>();
      for (const member of parsed.members) {
        const rawName = typeof member?.name === 'string' ? member.name.trim() : '';
        const lower = rawName.toLowerCase();
        if (!member || isLeadMember(member) || lower === 'user') continue;
        const name = rawName;
        if (!name) continue;
        byName.set(name, {
          name,
          role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
          workflow:
            typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
          providerId: normalizeTeamMemberProviderId(member.providerId ?? member.provider),
          model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
          effort:
            member.effort === 'low' || member.effort === 'medium' || member.effort === 'high'
              ? member.effort
              : undefined,
        });
      }
      // Defense: ignore CLI auto-suffixed duplicates (alice-2) when base name exists.
      const allNames = Array.from(byName.keys());
      const keepName = createCliAutoSuffixNameGuard(allNames);
      for (const name of allNames) {
        if (!keepName(name)) {
          byName.delete(name);
        }
      }
      return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      logger.warn(`[${teamName}] Failed to parse config.json for launch fallback members`);
      return [];
    }
  }

  /**
   * Two-stage preflight check:
   * 1. `claude --version` — verifies binary is executable and returns version info.
   *    (currently disabled for speed; keep commented for debugging)
   * 2. `claude -p "ping"` — verifies that `-p` mode is actually authenticated.
   *    This catches the common case where interactive `claude` works (OAuth/keychain)
   *    but `-p` mode fails with "Not logged in" due to missing env vars.
   */
  private async probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined = 'anthropic'
  ): Promise<{ warning?: string }> {
    const resolvedProviderId = resolveTeamProviderId(providerId);
    try {
      const versionProbe = await this.spawnProbe(
        claudePath,
        ['--version'],
        cwd,
        env,
        PREFLIGHT_BINARY_TIMEOUT_MS
      );
      if (versionProbe.exitCode !== 0) {
        const errorText =
          buildCombinedLogs(versionProbe.stdout, versionProbe.stderr) ||
          `Claude CLI exited with code ${versionProbe.exitCode ?? 'unknown'} during warm-up`;
        return {
          warning: `Claude CLI binary failed to start correctly. Details: ${errorText}`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingCwdSpawnError(message)) {
        return {
          warning: `Working directory does not exist: ${cwd}`,
        };
      }
      return {
        warning: `Claude CLI binary failed to start. Details: ${message}`,
      };
    }

    if (resolvedProviderId === 'gemini') {
      const authState = await resolveGeminiRuntimeAuth(env);
      if (authState.authenticated) {
        return {};
      }
      return {
        warning:
          authState.statusMessage ??
          'Gemini provider is not configured for runtime use. Set GEMINI_API_KEY or Google ADC credentials (plus GOOGLE_CLOUD_PROJECT when needed) and retry.',
      };
    }

    // Stage 1: verify binary works (awaited first for clearer errors)
    // Important: keep this sequential with Stage 2 to avoid auth/credential-store races
    // when multiple `claude` processes start simultaneously (most visible on Windows).
    // const versionProbe = await this.spawnProbe(
    //   claudePath,
    //   ['--version'],
    //   cwd,
    //   env,
    //   CLI_PREPARE_TIMEOUT_MS
    // );
    // if (versionProbe.exitCode !== 0) {
    //   const errorText =
    //     buildCombinedLogs(versionProbe.stdout, versionProbe.stderr) ||
    //     `Claude CLI exited with code ${versionProbe.exitCode ?? 'unknown'} during warm-up`;
    //   throw new Error(`Failed to warm up Claude CLI: ${errorText}`);
    // }

    // Stage 2: verify `-p` mode auth actually works (with retry for stale locks after Ctrl+C)
    for (let attempt = 1; attempt <= PREFLIGHT_AUTH_MAX_RETRIES; attempt++) {
      let pingProbe: { exitCode: number | null; stdout: string; stderr: string } | null = null;
      try {
        pingProbe = await this.spawnProbe(
          claudePath,
          getPreflightPingArgs(providerId),
          cwd,
          env,
          getPreflightTimeoutMs(providerId),
          {
            resolveOnOutputMatch: ({ stdout, stderr }) => {
              const combined = `${stdout}\n${stderr}`.trim();
              return /\bPONG\b/i.test(combined);
            },
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isProbeTimeoutMessage(message) && attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
          logger.warn(
            `Preflight ping failed (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
              `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms: ${message}`
          );
          await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_AUTH_RETRY_DELAY_MS));
          continue;
        }
        return {
          warning:
            'Preflight check for `claude -p` did not complete. ' +
            `Proceeding anyway. Details: ${message}`,
        };
      }

      const combinedOutput = buildCombinedLogs(pingProbe.stdout, pingProbe.stderr);
      const isAuthFailure = this.isAuthFailureWarning(combinedOutput, 'probe');

      if (isAuthFailure && attempt < PREFLIGHT_AUTH_MAX_RETRIES) {
        logger.warn(
          `Preflight auth failure detected (attempt ${attempt}/${PREFLIGHT_AUTH_MAX_RETRIES}), ` +
            `retrying in ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms — likely stale locks from interrupted process`
        );
        await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_AUTH_RETRY_DELAY_MS));
        continue;
      }

      if (isAuthFailure || pingProbe.exitCode !== 0) {
        const hint = isAuthFailure
          ? resolvedProviderId === 'codex'
            ? 'Codex provider is not authenticated for `-p` mode. ' +
              'Run `claude-multimodel auth login --provider codex` and retry.' +
              (attempt > 1 ? ` (failed after ${attempt} attempts)` : '')
            : 'Claude CLI `-p` mode is not authenticated. ' +
              'Run `claude auth login` (or start `claude` and run `/login`) to authenticate. ' +
              'For automation/headless use, set ANTHROPIC_API_KEY.' +
              (attempt > 1 ? ` (failed after ${attempt} attempts)` : '')
          : `Claude CLI preflight check failed (exit code ${pingProbe.exitCode ?? 'unknown'}).`;
        return { warning: hint };
      }

      const pongCandidate = pingProbe.stdout.trim() || pingProbe.stderr.trim();
      const isPong = new RegExp(`\\b${getProviderModelProbeExpectedOutput()}\\b`, 'i').test(
        pongCandidate
      );
      if (!isPong) {
        return {
          warning:
            'Preflight ping completed but did not return the expected PONG. ' +
            `Output: ${combinedOutput || '(empty)'}`,
        };
      }

      if (attempt > 1) {
        logger.info(
          `Preflight auth succeeded on attempt ${attempt} (previous attempt had auth failure)`
        );
      }
      return {};
    }

    return {};
  }

  /**
   * Run `claude --help` and return the output. Cached for 5 minutes.
   * Used by the validateCliArgs IPC handler to check user-entered flags.
   */
  async getCliHelpOutput(cwd?: string): Promise<string> {
    if (
      this.helpOutputCache &&
      Date.now() - this.helpOutputCacheTime < TeamProvisioningService.HELP_CACHE_TTL_MS
    ) {
      return this.helpOutputCache;
    }
    const targetCwd = cwd ?? process.cwd();
    const probeResult = await this.getCachedOrProbeResult(targetCwd, 'anthropic');
    if (!probeResult?.claudePath) {
      throw new Error('Claude CLI not found');
    }
    const { env } = await this.buildProvisioningEnv();
    const result = await this.spawnProbe(
      probeResult.claudePath,
      ['--help'],
      targetCwd,
      env,
      10_000
    );
    const output = (result.stdout + '\n' + result.stderr).trim();
    if (!output) {
      throw new Error(
        `claude --help returned empty output (exit code: ${String(result.exitCode)})`
      );
    }
    this.helpOutputCache = output;
    this.helpOutputCacheTime = Date.now();
    return output;
  }

  private buildAgentTeamsMcpValidationError(output: string): string {
    const detail = this.normalizeApiRetryErrorMessage(output) || output.trim();
    if (!detail) {
      return (
        'agent-teams MCP loaded config but did not expose member_briefing. ' +
        'The leader would start without required team MCP tools.'
      );
    }
    return (
      'agent-teams MCP loaded config but did not expose member_briefing. ' + `Details: ${detail}`
    );
  }

  private async validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string
  ): Promise<void> {
    const result = await this.spawnProbe(
      claudePath,
      [
        '--setting-sources',
        'user,project,local',
        '--mcp-config',
        mcpConfigPath,
        '--',
        'mcp',
        'get',
        'agent-teams',
      ],
      cwd,
      env,
      VERIFY_TIMEOUT_MS
    );

    const combinedOutput = buildCombinedLogs(result.stdout, result.stderr).trim();
    if (result.exitCode !== 0) {
      throw new Error(this.buildAgentTeamsMcpValidationError(combinedOutput));
    }

    const normalizedOutput = combinedOutput.toLowerCase();
    if (
      !normalizedOutput.includes('status: ✓ connected') &&
      !normalizedOutput.includes('status: connected')
    ) {
      throw new Error(this.buildAgentTeamsMcpValidationError(combinedOutput));
    }
  }

  private async spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: {
      /**
       * Optional early success predicate. If this returns true based on
       * buffered stdout/stderr, the probe resolves immediately (and the process
       * is best-effort terminated) instead of waiting for `close`.
       */
      resolveOnOutputMatch?: (ctx: { stdout: string; stderr: string }) => boolean;
    }
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawnCli(claudePath, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdoutText = '';
      let stderrText = '';
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        settled = true;
        killProcessTree(child);
        reject(new Error(`Timeout running: claude ${args.join(' ')}`));
      }, timeoutMs);

      const maybeResolveEarly = (): void => {
        if (settled) return;
        if (!options?.resolveOnOutputMatch) return;
        const ctx = { stdout: stdoutText.trim(), stderr: stderrText.trim() };
        if (!options.resolveOnOutputMatch(ctx)) return;

        settled = true;
        clearTimeout(timeoutHandle);
        // If the process printed the match but hangs during teardown, don't
        // block the UI; terminate best-effort and resolve.
        killProcessTree(child);
        resolve({ exitCode: 0, stdout: ctx.stdout, stderr: ctx.stderr });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutText += chunk.toString('utf8');
        maybeResolveEarly();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8');
        maybeResolveEarly();
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve({
          exitCode,
          stdout: stdoutText.trim(),
          stderr: stderrText.trim(),
        });
      });
    });
  }
}
