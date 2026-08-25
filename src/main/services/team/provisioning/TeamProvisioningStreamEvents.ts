import { cleanupAnthropicTeamApiKeyHelperMaterial } from '@main/services/runtime/anthropicTeamApiKeyHelper';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { type ParsedPermissionRequest, parsePermissionRequest } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import { isTeamInternalControlMessageText } from '@shared/utils/teamInternalControlMessages';
import { extractToolPreview } from '@shared/utils/toolSummary';

import { isAgentTeamsToolUse } from '../agentTeamsToolNames';
import { isWorkspaceTrustLaunchFailureText } from '../TeamLaunchFailureArtifactPack';

import {
  clearGeminiPostLaunchHydrationState,
  clearPostCompactReminderState,
} from './TeamProvisioningCleanup';
import { buildRestartStillRunningReason } from './TeamProvisioningMemberSpawnStatusPolicy';

import type {
  InboxMessage,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamChangeEvent,
  TeamProvisioningProgress,
  TeamProvisioningState,
  ToolCallMeta,
} from '@shared/types';
import type { ChildProcess } from 'child_process';

const logger = createLogger('Service:TeamProvisioning');

const HANDLED_STREAM_JSON_TYPES = new Set([
  'user',
  'assistant',
  'control_request',
  'rate_limit_event',
  'result',
  'system',
]);

export interface TeamProvisioningStreamRun {
  runId: string;
  teamName: string;
  detectedSessionId: string | null;
  deterministicBootstrapStartedAt?: string;
  lastDeterministicBootstrapEvent?: string;
  lastDeterministicBootstrapPhase?: string;
  deterministicBootstrapMemberSpawnSeen: boolean;
  deterministicBootstrapMemberResultSeen: boolean;
  lastDeterministicBootstrapSeq: number;
  requiresFirstRealTurnSuccess: boolean;
  provisioningComplete: boolean;
  cancelRequested: boolean;
  processKilled: boolean;
  progress: TeamProvisioningProgress;
  onProgress: (progress: TeamProvisioningProgress) => void;
  child: ChildProcess | null | undefined;
  pendingMemberRestarts: Map<string, unknown>;
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  isLaunch: boolean;
  anthropicApiKeyHelper: { directory: string } | null;
  leadRelayCapture: {
    textParts: string[];
    textJoinMode?: 'block' | 'stream';
    recoveryMessageId?: string;
    requireTerminalResult?: boolean;
    terminalResultSucceeded?: boolean;
    hasVisibleSendMessage?: boolean;
    hasUserVisibleSendMessage?: boolean;
    settled: boolean;
    idleHandle: NodeJS.Timeout | null;
    idleMs: number;
    resolveOnce: (text: string) => void;
    rejectOnce: (error: string) => void;
  } | null;
  pendingToolCalls: ToolCallMeta[];
  liveLeadTextBuffer: unknown;
  silentUserDmForward: { mode: 'user_dm' | 'member_inbox_relay' } | null;
  suppressPostCompactReminderOutput: boolean;
  pendingDirectCrossTeamSendRefresh: boolean;
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  suppressGeminiPostLaunchHydrationOutput: boolean;
  activeCrossTeamReplyHints: unknown[];
  pendingInboxRelayCandidates: unknown[];
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
  leadContextUsage: {
    promptInputTokens: number | null;
    outputTokens: number | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    promptInputSource: string;
    lastUsageMessageId: string | null;
    lastEmittedAt: number;
  } | null;
  apiRetryWarningIndex: number | null;
  provisioningOutputParts: string[];
  lastRetryAt: number;
  apiErrorWarningEmitted: boolean;
}

export interface TeamProvisioningStreamEventPorts<TRun extends TeamProvisioningStreamRun> {
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<
      TeamProvisioningProgress,
      'error' | 'warnings' | 'cliLogsTail' | 'configReady' | 'messageSeverity' | 'launchDiagnostics'
    >
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
  buildProvisioningLiveOutput(run: TRun): string | undefined;
  boundRunProvisioningOutputParts(run: TRun): void;
  boundProgressAssistantParts(parts: string[]): string[];
  appendProvisioningTrace(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    detail?: string
  ): void;
  resetLiveLeadTextBuffer(run: TRun): void;
  handleTeammatePermissionRequest(
    run: TRun,
    permissionRequest: ParsedPermissionRequest,
    timestamp: string
  ): void;
  finishRuntimeToolActivity(
    run: TRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void;
  handleNativeTeammateUserMessage(run: TRun, msg: Record<string, unknown>): void;
  handleAuthFailureInOutput(
    run: TRun,
    text: string,
    source: 'assistant' | 'stdout' | 'stderr' | 'pre-complete'
  ): void;
  hasApiError(text: string): boolean;
  isAuthFailureWarning(
    text: string,
    source: 'assistant' | 'stdout' | 'stderr' | 'pre-complete'
  ): boolean;
  failProvisioningWithApiError(run: TRun, text: string): void;
  appendProvisioningAssistantText(run: TRun, msg: Record<string, unknown>, text: string): void;
  pushLiveLeadTextMessage(
    run: TRun,
    text: string,
    messageId?: string,
    timestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void;
  startRuntimeToolActivity(run: TRun, memberName: string, block: Record<string, unknown>): void;
  getRunLeadName(run: TRun): string;
  captureTeamSpawnEvents(run: TRun, content: Record<string, unknown>[]): void;
  captureSendMessages(run: TRun, content: Record<string, unknown>[]): void;
  updateLeadContextUsageFromUsage(
    run: TRun,
    usage: Record<string, unknown>,
    modelName: string | undefined
  ): void;
  emitLeadContextUsage(run: TRun): void;
  resetRuntimeToolActivity(run: TRun, memberName?: string): void;
  setLeadActivity(run: TRun, state: 'active' | 'idle' | 'offline'): void;
  emitTeamChange(event: TeamChangeEvent): void;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  injectPostCompactReminder(run: TRun): Promise<void>;
  injectGeminiPostLaunchHydration(run: TRun): Promise<void>;
  completeProvisioningFromSuccessfulResult(run: TRun): void;
  handleControlRequest(run: TRun, msg: Record<string, unknown>): void;
  handleProvisioningTurnComplete(run: TRun): Promise<void>;
  cleanupRun(run: TRun): void;
  killTeamProcess(child: ChildProcess | null | undefined): void;
  normalizeApiRetryErrorMessage(text: string): string;
  isQuotaRetryMessage(text: string | undefined): boolean;
  toMarkdownCodeSafe(text: string): string;
  emitApiErrorWarning(run: TRun, text: string): void;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string
  ): void;
  appendMemberBootstrapDiagnostic(run: TRun, memberName: string, detail: string): void;
  reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  markUnconfirmedBootstrapMembersFailed(
    run: TRun,
    reason: string,
    options: { cleanupRequested: boolean; preserveExistingFailure?: boolean }
  ): void;
  stopPersistentTeamMembers(teamName: string): void;
  persistLaunchStateSnapshot(run: TRun, phase: 'finished'): Promise<unknown>;
  observeRuntimeFailure(
    run: TRun,
    failure: {
      phase: 'sdk_retrying' | 'terminal';
      detail: string;
      observedAt: string;
      statusCode?: number;
      retryAfterMs?: number;
      causedByRecoveryMessageId?: string;
    }
  ): void;
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

export function classifyDeterministicBootstrapFailure(reason: string): {
  title: string;
  normalizedReason: string;
} {
  const normalizedReason = reason.trim();
  const lower = normalizedReason.toLowerCase();
  if (isWorkspaceTrustLaunchFailureText(normalizedReason)) {
    return {
      title: 'Workspace trust required',
      normalizedReason,
    };
  }
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

export function extractStreamUserText(msg: Record<string, unknown>): string | null {
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
        !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text as string)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

export function extractStreamContentBlocks(
  msg: Record<string, unknown>
): Record<string, unknown>[] {
  const topLevelContent = msg.content;
  if (Array.isArray(topLevelContent)) {
    return topLevelContent as Record<string, unknown>[];
  }

  const message = msg.message;
  if (!message || typeof message !== 'object') return [];
  const innerContent = (message as Record<string, unknown>).content;
  return Array.isArray(innerContent) ? (innerContent as Record<string, unknown>[]) : [];
}

export function hasCapturedVisibleSendMessage(
  content: Record<string, unknown>[],
  teamName: string
): boolean {
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type !== 'tool_use' || typeof part.name !== 'string') return false;

    const input = part.input;
    if (!input || typeof input !== 'object') return false;
    const inp = input as Record<string, unknown>;

    if (part.name === 'SendMessage') {
      const target = (typeof inp.recipient === 'string' ? inp.recipient : '').trim();
      const text = (typeof inp.content === 'string' ? inp.content : '').trim();
      return target.length > 0 && text.length > 0;
    }

    const isTeamMessageSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'message_send',
      toolInput: inp,
      currentTeamName: teamName,
    });
    const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'cross_team_send',
      toolInput: inp,
      currentTeamName: teamName,
    });
    if (!isTeamMessageSendTool && !isDirectCrossTeamSendTool) return false;

    const target = isTeamMessageSendTool
      ? typeof inp.to === 'string'
        ? inp.to
        : ''
      : typeof inp.toTeam === 'string'
        ? inp.toTeam
        : '';
    const text = typeof inp.text === 'string' ? inp.text : '';

    return target.trim().length > 0 && text.trim().length > 0;
  });
}

export function hasCapturedUserVisibleSendMessage(
  content: Record<string, unknown>[],
  teamName: string
): boolean {
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type !== 'tool_use' || typeof part.name !== 'string') return false;

    const input = part.input;
    if (!input || typeof input !== 'object') return false;
    const inp = input as Record<string, unknown>;

    if (part.name === 'SendMessage') {
      const target = (typeof inp.recipient === 'string' ? inp.recipient : '').trim().toLowerCase();
      const text = (typeof inp.content === 'string' ? inp.content : '').trim();
      return target === 'user' && text.length > 0;
    }

    const isTeamMessageSendTool = isAgentTeamsToolUse({
      rawName: part.name,
      canonicalName: 'message_send',
      toolInput: inp,
      currentTeamName: teamName,
    });
    if (!isTeamMessageSendTool) return false;

    const target = typeof inp.to === 'string' ? inp.to.trim().toLowerCase() : '';
    const text = typeof inp.text === 'string' ? inp.text.trim() : '';
    return target === 'user' && text.length > 0;
  });
}

export function getStableLeadThoughtMessageId(msg: Record<string, unknown>): string | null {
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

function isSyntheticLeadTextChunk(msg: Record<string, unknown>): boolean {
  const message = (msg.message ?? msg) as Record<string, unknown>;
  return message.model === '<synthetic>' && message.type === 'message';
}

function joinLeadRelayCaptureText(
  capture: NonNullable<TeamProvisioningStreamRun['leadRelayCapture']>
): string {
  return capture.textParts.join(capture.textJoinMode === 'stream' ? '' : '\n').trim();
}

function recordDeterministicBootstrapTracking(
  run: TeamProvisioningStreamRun,
  event: string,
  msg: Record<string, unknown>
): void {
  run.deterministicBootstrapStartedAt ??= new Date().toISOString();
  run.lastDeterministicBootstrapEvent = event;

  if (event === 'phase_changed') {
    const phase = typeof msg.phase === 'string' ? msg.phase.trim() : '';
    if (phase) {
      run.lastDeterministicBootstrapPhase = phase;
    }
  }

  if (event === 'member_spawn_started') {
    run.deterministicBootstrapMemberSpawnSeen = true;
  } else if (event === 'member_spawn_result') {
    run.deterministicBootstrapMemberSpawnSeen = true;
    run.deterministicBootstrapMemberResultSeen = true;
  }
}

export function handleDeterministicBootstrapEvent<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
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
  recordDeterministicBootstrapTracking(run, event, msg);

  if (event === 'started') {
    const progress = ports.updateProgress(
      run,
      'configuring',
      'Starting deterministic team bootstrap'
    );
    run.onProgress(progress);
    return true;
  }

  if (event === 'phase_changed') {
    const phase = typeof msg.phase === 'string' ? msg.phase : '';
    if (phase === 'loading_existing_state') {
      const progress = ports.updateProgress(run, 'configuring', 'Loading existing team state');
      run.onProgress(progress);
    } else if (phase === 'acquiring_bootstrap_lock') {
      const progress = ports.updateProgress(
        run,
        'configuring',
        'Acquiring deterministic bootstrap lock'
      );
      run.onProgress(progress);
    } else if (phase === 'creating_team') {
      const progress = ports.updateProgress(run, 'assembling', 'Creating team config');
      run.onProgress(progress);
    } else if (phase === 'spawning_members') {
      const progress = ports.updateProgress(run, 'assembling', 'Spawning teammate runtimes');
      run.onProgress(progress);
    } else if (phase === 'auditing_truth') {
      const progress = ports.updateProgress(
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
    const progress = ports.updateProgress(
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
      ports.setMemberSpawnStatus(run, memberName, 'spawning');
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
      ports.setMemberSpawnStatus(
        run,
        memberName,
        'error',
        reason || 'Deterministic bootstrap failed to spawn teammate.'
      );
      return true;
    }

    if (outcome === 'already_running') {
      if (run.pendingMemberRestarts.has(memberName)) {
        run.pendingMemberRestarts.delete(memberName);
        ports.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          buildRestartStillRunningReason(memberName)
        );
        return true;
      }
      ports.invalidateRuntimeSnapshotCaches(run.teamName);
      ports.setMemberSpawnStatus(run, memberName, 'waiting');
      ports.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'already_running requires strong runtime verification'
      );
      void ports.reevaluateMemberLaunchStatus(run, memberName);
      return true;
    }

    ports.setMemberSpawnStatus(run, memberName, 'waiting');
    return true;
  }

  if (event === 'completed') {
    const failedMembers = Array.isArray(msg.failed_members) ? msg.failed_members : [];
    for (const failed of failedMembers) {
      const memberName = typeof failed?.name === 'string' ? failed.name.trim() : '';
      const reason = typeof failed?.reason === 'string' ? failed.reason.trim() : undefined;
      if (memberName) {
        ports.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          reason || 'Deterministic bootstrap failed to spawn teammate.'
        );
      }
    }
    if (!run.requiresFirstRealTurnSuccess && !run.provisioningComplete && !run.cancelRequested) {
      void ports.handleProvisioningTurnComplete(run).catch((error: unknown) => {
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
    const progress = ports.updateProgress(run, 'failed', classification.title, {
      error: classification.normalizedReason,
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    const hasConfirmedBootstrapMember = Array.from(run.memberSpawnStatuses.values()).some(
      (member) => member.bootstrapConfirmed === true
    );
    const shouldCleanupUnconfirmedLaunchRuntimes = run.isLaunch && !hasConfirmedBootstrapMember;
    ports.markUnconfirmedBootstrapMembersFailed(run, classification.normalizedReason, {
      cleanupRequested: shouldCleanupUnconfirmedLaunchRuntimes,
    });
    if (shouldCleanupUnconfirmedLaunchRuntimes) {
      ports.stopPersistentTeamMembers(run.teamName);
      if (run.anthropicApiKeyHelper) {
        void cleanupAnthropicTeamApiKeyHelperMaterial({
          directory: run.anthropicApiKeyHelper.directory,
          skipIfLiveProcessReferences: true,
        }).catch((error: unknown) => {
          logger.warn(
            `[${run.teamName}] Failed to cleanup failed-run Anthropic API-key helper material: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
    }
    run.processKilled = true;
    ports.killTeamProcess(run.child);
    void ports.persistLaunchStateSnapshot(run, 'finished').catch((error: unknown) => {
      logger.warn(
        `[${run.teamName}] Failed to persist failed bootstrap launch snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    ports.cleanupRun(run);
    return true;
  }

  return true;
}

export function handleTeamProvisioningStreamJsonMessage<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  if (!run.detectedSessionId) {
    const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (sid && sid.trim().length > 0) {
      run.detectedSessionId = sid.trim();
      logger.info(
        `[${run.teamName}] Detected session ID from stream-json: ${run.detectedSessionId}`
      );
    }
  }

  if (msg.type === 'user') {
    ports.resetLiveLeadTextBuffer(run);
    const rawUserText = extractStreamUserText(msg);
    const content = extractStreamContentBlocks(msg);
    if (rawUserText) {
      const perm = parsePermissionRequest(rawUserText);
      if (perm) {
        logger.warn(
          `[${run.teamName}] [PERM-TRACE] Intercepted permission_request from stdout user message: agent=${perm.agentId} tool=${perm.toolName} requestId=${perm.requestId}`
        );
        ports.handleTeammatePermissionRequest(run, perm, new Date().toISOString());
      } else if (rawUserText.includes('permission_request')) {
        logger.warn(
          `[${run.teamName}] [PERM-TRACE] stdout user message contains "permission_request" but parsePermissionRequest returned null. Text preview: ${rawUserText.slice(0, 300)}`
        );
      }
    }
    for (const block of content) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      ports.finishRuntimeToolActivity(
        run,
        block.tool_use_id,
        block.content,
        block.is_error === true
      );
    }
    ports.handleNativeTeammateUserMessage(run, msg);
    return;
  }
  if (msg.type === 'assistant') {
    const content = extractStreamContentBlocks(msg);

    const hasVisibleSendMessage = hasCapturedVisibleSendMessage(content, run.teamName);
    if (run.leadRelayCapture) {
      if (hasVisibleSendMessage) {
        run.leadRelayCapture.hasVisibleSendMessage = true;
      }
      if (hasCapturedUserVisibleSendMessage(content, run.teamName)) {
        run.leadRelayCapture.hasUserVisibleSendMessage = true;
      }
    }

    const textParts = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string);
    if (textParts.length > 0) {
      const text = textParts.join('\n');
      const messageTimestamp =
        typeof msg.timestamp === 'string' &&
        msg.timestamp.trim().length > 0 &&
        Number.isFinite(Date.parse(msg.timestamp))
          ? msg.timestamp
          : undefined;
      ports.handleAuthFailureInOutput(run, text, 'assistant');
      if (ports.hasApiError(text) && !ports.isAuthFailureWarning(text, 'assistant')) {
        ports.failProvisioningWithApiError(run, text);
        return;
      }
      logger.debug(`[${run.teamName}] assistant: ${text.slice(0, 200)}`);
      if (!run.provisioningComplete) {
        ports.appendProvisioningAssistantText(run, msg, text);
      }

      if (run.leadRelayCapture && !run.leadRelayCapture.settled) {
        const capture = run.leadRelayCapture;
        if (isSyntheticLeadTextChunk(msg)) {
          capture.textJoinMode = 'stream';
        } else if (!capture.textJoinMode) {
          capture.textJoinMode = 'block';
        }
        capture.textParts.push(text);
        capture.textParts = ports.boundProgressAssistantParts(capture.textParts);
        if (capture.idleHandle) {
          clearTimeout(capture.idleHandle);
        }
        if (!capture.requireTerminalResult) {
          capture.idleHandle = setTimeout(() => {
            const combined = joinLeadRelayCaptureText(capture);
            capture.resolveOnce(combined);
          }, capture.idleMs);
        }
      } else if (run.provisioningComplete) {
        if (
          !run.silentUserDmForward &&
          !run.suppressPostCompactReminderOutput &&
          !run.suppressGeminiPostLaunchHydrationOutput &&
          !hasVisibleSendMessage
        ) {
          const isSyntheticChunk = isSyntheticLeadTextChunk(msg);
          const displayText = isSyntheticChunk ? text : stripAgentBlocks(text).trim();
          if (
            (displayText.length > 0 || (isSyntheticChunk && run.liveLeadTextBuffer)) &&
            !isTeamInternalControlMessageText(displayText)
          ) {
            ports.pushLiveLeadTextMessage(
              run,
              displayText,
              getStableLeadThoughtMessageId(msg) ?? undefined,
              messageTimestamp,
              { coalesceStreamChunk: isSyntheticChunk }
            );
          }
        }
      } else if (!run.silentUserDmForward && !hasVisibleSendMessage) {
        const isSyntheticChunk = isSyntheticLeadTextChunk(msg);
        const displayText = isSyntheticChunk ? text : stripAgentBlocks(text).trim();
        if (
          (displayText.length > 0 || (isSyntheticChunk && run.liveLeadTextBuffer)) &&
          !isTeamInternalControlMessageText(displayText)
        ) {
          ports.pushLiveLeadTextMessage(
            run,
            displayText,
            getStableLeadThoughtMessageId(msg) ?? undefined,
            messageTimestamp,
            { coalesceStreamChunk: isSyntheticChunk }
          );
        }
      }
    }

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
        ports.resetLiveLeadTextBuffer(run);
        ports.startRuntimeToolActivity(run, ports.getRunLeadName(run), block);
      }
    }

    ports.captureTeamSpawnEvents(run, content);

    if (!run.silentUserDmForward || run.silentUserDmForward.mode === 'member_inbox_relay') {
      ports.captureSendMessages(run, content);
    }

    const messageObj = (msg.message ?? msg) as Record<string, unknown>;
    if (messageObj && typeof messageObj === 'object') {
      const msgId = typeof messageObj.id === 'string' ? messageObj.id : null;
      const usage = messageObj.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        if (!msgId || run.leadContextUsage?.lastUsageMessageId !== msgId) {
          ports.updateLeadContextUsageFromUsage(
            run,
            usage,
            typeof messageObj.model === 'string' ? messageObj.model : undefined
          );
          if (run.leadContextUsage) {
            run.leadContextUsage.lastUsageMessageId = msgId;
          }
          ports.emitLeadContextUsage(run);
        }
      }
    }
  }

  if (handleDeterministicBootstrapEvent(run, msg, ports)) {
    return;
  }

  if (msg.type === 'control_request') {
    ports.handleControlRequest(run, msg);
    return;
  }

  if (msg.type === 'result') {
    handleResultMessage(run, msg, ports);
  }

  if (msg.type === 'system') {
    handleSystemMessage(run, msg, ports);
  }

  if (typeof msg.type === 'string' && !HANDLED_STREAM_JSON_TYPES.has(msg.type)) {
    const raw = JSON.stringify(msg);
    logger.warn(`[${run.teamName}] Unhandled stream-json type "${msg.type}": ${raw.slice(0, 300)}`);
    if (
      !run.provisioningComplete &&
      ports.hasApiError(raw) &&
      !ports.isAuthFailureWarning(raw, 'stdout')
    ) {
      ports.emitApiErrorWarning(run, raw);
    }
  }
}

function handleResultMessage<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
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
    handleSuccessResultMessage(run, msg, ports);
  } else {
    // Any non-success result ('error', 'error_during_execution', 'error_max_turns', or an
    // unrecognized/absent subtype) is a turn-ending failure. Route it all through the error
    // handler so the lead relay capture is rejected and lead activity/provisioning state is
    // cleared; otherwise the turn would hang (relay waits out its capture timeout and may
    // re-deliver, and on initial launch provisioning never completes).
    handleErrorResultMessage(run, msg, ports);
  }
}

function handleSuccessResultMessage<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  if (!run.provisioningComplete) {
    // The run object owns this field; keep the assignment local to avoid widening the helper API.
    (run as TRun & { firstRealTurnSucceeded?: boolean }).firstRealTurnSucceeded = true;
  }

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
            promptInputTokens: null,
            outputTokens: null,
            contextUsedTokens: null,
            contextWindowTokens: modelData.contextWindow,
            promptInputSource: 'unavailable',
            lastUsageMessageId: null,
            lastEmittedAt: 0,
          };
        } else {
          run.leadContextUsage.contextWindowTokens = modelData.contextWindow;
          run.leadContextUsage.lastEmittedAt = 0;
        }
        ports.emitLeadContextUsage(run);
        break;
      }
    }
  }

  const resultUsage = (msg.usage ?? (msg.result as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (resultUsage && typeof resultUsage === 'object') {
    ports.updateLeadContextUsageFromUsage(
      run,
      resultUsage,
      typeof (msg.result as Record<string, unknown> | undefined)?.model === 'string'
        ? ((msg.result as Record<string, unknown>).model as string)
        : undefined
    );
    if (run.leadContextUsage) {
      run.leadContextUsage.lastEmittedAt = 0;
    }
    ports.emitLeadContextUsage(run);
  }

  if (run.provisioningComplete) {
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

    ports.resetRuntimeToolActivity(run, ports.getRunLeadName(run));
    ports.setLeadActivity(run, 'idle');
  }
  if (run.pendingDirectCrossTeamSendRefresh) {
    run.pendingDirectCrossTeamSendRefresh = false;
    ports.emitTeamChange({
      type: 'inbox',
      teamName: run.teamName,
      detail: 'sentMessages.json',
    });
  }
  if (run.leadRelayCapture) {
    const capture = run.leadRelayCapture;
    capture.terminalResultSucceeded = true;
    const combined = joinLeadRelayCaptureText(capture);
    capture.resolveOnce(combined);
  }
  ports.resetLiveLeadTextBuffer(run);
  run.activeCrossTeamReplyHints = [];
  run.pendingInboxRelayCandidates = [];
  run.silentUserDmForward = null;
  if (run.silentUserDmForwardClearHandle) {
    clearTimeout(run.silentUserDmForwardClearHandle);
    run.silentUserDmForwardClearHandle = null;
  }

  if (
    run.provisioningComplete &&
    run.pendingPostCompactReminder &&
    !run.postCompactReminderInFlight
  ) {
    void ports.injectPostCompactReminder(run);
  }
  if (
    run.provisioningComplete &&
    run.pendingGeminiPostLaunchHydration &&
    !run.geminiPostLaunchHydrationInFlight
  ) {
    void ports.injectGeminiPostLaunchHydration(run);
  }

  ports.completeProvisioningFromSuccessfulResult(run);
}

function handleErrorResultMessage<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  const errorMsg =
    typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? 'unknown');
  logger.warn(`[${run.teamName}] stream-json result: error — ${errorMsg}`);
  const causedByRecoveryMessageId = run.leadRelayCapture?.recoveryMessageId;
  if (run.leadRelayCapture) {
    run.leadRelayCapture.rejectOnce(errorMsg);
  }
  ports.resetLiveLeadTextBuffer(run);
  run.pendingDirectCrossTeamSendRefresh = false;
  run.activeCrossTeamReplyHints = [];
  run.pendingInboxRelayCandidates = [];
  run.silentUserDmForward = null;
  if (run.silentUserDmForwardClearHandle) {
    clearTimeout(run.silentUserDmForwardClearHandle);
    run.silentUserDmForwardClearHandle = null;
  }
  if (!run.provisioningComplete && !run.cancelRequested) {
    const progress = ports.updateProgress(
      run,
      'failed',
      'CLI reported an error during provisioning',
      {
        error: errorMsg,
        cliLogsTail: ports.extractCliLogsFromRun(run),
      }
    );
    run.onProgress(progress);
    run.processKilled = true;
    ports.killTeamProcess(run.child);
    ports.cleanupRun(run);
  } else if (run.provisioningComplete) {
    ports.observeRuntimeFailure(run, {
      phase: 'terminal',
      detail: errorMsg,
      observedAt:
        typeof msg.timestamp === 'string' && Number.isFinite(Date.parse(msg.timestamp))
          ? msg.timestamp
          : new Date().toISOString(),
      ...(causedByRecoveryMessageId ? { causedByRecoveryMessageId } : {}),
    });
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
    ports.resetRuntimeToolActivity(run, ports.getRunLeadName(run));
    ports.setLeadActivity(run, 'idle');
  }
}

function handleSystemMessage<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  const sub = typeof msg.subtype === 'string' ? msg.subtype : undefined;
  if (sub === 'compact_boundary') {
    handleCompactBoundary(run, msg, ports);
  }

  if (sub === 'api_retry') {
    handleApiRetry(run, msg, ports);
  }
}

function handleCompactBoundary<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  if (run.leadContextUsage) {
    run.leadContextUsage.lastUsageMessageId = null;
  }

  const meta = msg.compact_metadata as Record<string, unknown> | undefined;
  const trigger = typeof meta?.trigger === 'string' ? meta.trigger : 'auto';
  const preTokens = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null;
  const tokenInfo = preTokens ? ` (was ~${(preTokens / 1000).toFixed(0)}k tokens)` : '';

  const compactMsg: InboxMessage = {
    from: 'system',
    text: `Context compacted${tokenInfo}, trigger: ${trigger}`,
    timestamp: new Date().toISOString(),
    read: true,
    summary: `Context compacted (${trigger})`,
    messageId: `compact-${run.runId}-${Date.now()}`,
    source: 'lead_process',
  };
  ports.pushLiveLeadProcessMessage(run.teamName, compactMsg);
  ports.emitTeamChange({
    type: 'inbox',
    teamName: run.teamName,
    detail: 'compact_boundary',
  });
  logger.info(`[${run.teamName}] compact_boundary — context will refresh on next turn${tokenInfo}`);

  if (run.provisioningComplete && !run.pendingPostCompactReminder) {
    run.pendingPostCompactReminder = true;
    logger.info(
      `[${run.teamName}] post-compact reminder scheduled for next idle${
        run.postCompactReminderInFlight ? ' (re-armed during in-flight reminder)' : ''
      }`
    );
  }
}

function handleApiRetry<TRun extends TeamProvisioningStreamRun>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningStreamEventPorts<TRun>
): void {
  const attempt = typeof msg.attempt === 'number' ? msg.attempt : '?';
  const maxRetries = typeof msg.max_retries === 'number' ? msg.max_retries : '?';
  const errorStatus = typeof msg.error_status === 'number' ? msg.error_status : undefined;
  const errorLabel = typeof msg.error === 'string' ? msg.error.replace(/_/g, ' ') : undefined;
  const retryDelay = typeof msg.retry_delay_ms === 'number' ? msg.retry_delay_ms : undefined;
  const rawErrorMessage =
    typeof msg.error_message === 'string' && msg.error_message.trim().length > 0
      ? msg.error_message.trim()
      : undefined;
  const errorMessage = rawErrorMessage
    ? ports.normalizeApiRetryErrorMessage(rawErrorMessage)
    : undefined;
  const looksLikeQuotaRetry =
    errorLabel === 'rate limit' || ports.isQuotaRetryMessage(errorMessage);

  if (run.provisioningComplete) {
    ports.observeRuntimeFailure(run, {
      phase: 'sdk_retrying',
      detail: rawErrorMessage ?? errorMessage ?? errorLabel ?? 'API retry in progress',
      observedAt:
        typeof msg.timestamp === 'string' && Number.isFinite(Date.parse(msg.timestamp))
          ? msg.timestamp
          : new Date().toISOString(),
      statusCode: errorStatus,
      retryAfterMs: retryDelay,
    });
  }

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
      ? `**API retry ${attempt}/${maxRetries}: ${statusLabel}**\n\n\`\`\`\n${ports.toMarkdownCodeSafe(
          errorMessage
        )}\n\`\`\`\n\n${
          retryDelay ? `Next retry in ${Math.round(retryDelay / 1000)}s.` : 'Retrying...'
        }`
      : `**API retry ${attempt}/${maxRetries}: ${statusLabel}**\n\n${
          retryDelay ? `Next retry in ${Math.round(retryDelay / 1000)}s.` : 'Retrying...'
        }`;
    if (run.apiRetryWarningIndex != null) {
      run.provisioningOutputParts[run.apiRetryWarningIndex] = warningText;
    } else {
      run.apiRetryWarningIndex = run.provisioningOutputParts.length;
      run.provisioningOutputParts.push(warningText);
    }
    ports.boundRunProvisioningOutputParts(run);
    run.lastRetryAt = Date.now();
    ports.appendProvisioningTrace(
      run,
      run.progress.state,
      retryText,
      errorMessage ? `error=${errorMessage}` : undefined
    );
    run.progress = {
      ...run.progress,
      updatedAt: new Date().toISOString(),
      message: retryText,
      messageSeverity: 'error' as const,
      assistantOutput: ports.buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput,
    };
    run.onProgress(run.progress);
  }
}
