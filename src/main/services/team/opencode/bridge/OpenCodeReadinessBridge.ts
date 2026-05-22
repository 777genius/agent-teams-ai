import { randomUUID } from 'crypto';

import {
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  stableHash,
} from './OpenCodeBridgeCommandContract';
import { buildOpenCodeBridgeSupportDiagnostic } from './OpenCodeBridgeSupportDiagnostics';

import type { OpenCodeTeamRuntimeBridgePort } from '../../runtime/OpenCodeTeamRuntimeAdapter';
import type {
  OpenCodeTeamLaunchReadiness,
  OpenCodeTeamLaunchReadinessState,
} from '../readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeAnswerPermissionCommandBody,
  OpenCodeBackfillTaskLedgerCommandBody,
  OpenCodeBackfillTaskLedgerCommandData,
  OpenCodeBridgeCommandName,
  OpenCodeBridgeDiagnosticEvent,
  OpenCodeBridgeFailureKind,
  OpenCodeBridgeResult,
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeCleanupHostsCommandBody,
  OpenCodeCleanupHostsCommandData,
  OpenCodeCommandStatusCommandBody,
  OpenCodeCommandStatusCommandData,
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeListRuntimePermissionsCommandBody,
  OpenCodeListRuntimePermissionsCommandData,
  OpenCodeObserveMessageDeliveryCommandBody,
  OpenCodeObserveMessageDeliveryCommandData,
  OpenCodeReconcileTeamCommandBody,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
  OpenCodeStopTeamCommandBody,
  OpenCodeStopTeamCommandData,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeStateChangingBridgeCommandService } from './OpenCodeStateChangingBridgeCommandService';

export interface OpenCodeLedgerBackfillPort {
  backfillOpenCodeTaskLedger(
    input: OpenCodeBackfillTaskLedgerCommandBody
  ): Promise<OpenCodeBackfillTaskLedgerCommandData>;
}

export interface OpenCodeReadinessBridgeCommandExecutor {
  execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: {
      cwd: string;
      timeoutMs: number;
      requestId?: string;
      stdoutLimitBytes?: number;
      stderrLimitBytes?: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>>;
}

export interface OpenCodeReadinessBridgeOptions {
  timeoutMs?: number;
  launchTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  sendTimeoutMs?: number;
  observeTimeoutMs?: number;
  stopTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  appVersion?: string;
  stateChangingCommands?: Pick<OpenCodeStateChangingBridgeCommandService, 'execute'>;
}

export interface OpenCodeReadinessBridgeCommandBody {
  projectPath: string;
  selectedModel: string | null;
  requireExecutionProbe: boolean;
}

const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
// Longer than the renderer-facing UI timeout: late OpenCode turns should still
// finish bridge-side observation and emit member-work-sync signals.
const DEFAULT_SEND_TIMEOUT_MS = 45_000;
const DEFAULT_OBSERVE_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_BACKFILL_TIMEOUT_MS = 45_000;
const DEFAULT_COMMAND_STATUS_TIMEOUT_MS = 5_000;
const OPEN_CODE_COMPLETED_COMMAND_RECOVERY_MESSAGE =
  'OpenCode bridge command already completed; recover through commandStatus';

function buildSendPayloadHash(input: OpenCodeSendMessageCommandBody): string {
  const { payloadHash: _payloadHash, settlementMode: _settlementMode, ...hashable } = input;
  return stableHash(hashable);
}

export class OpenCodeReadinessBridge implements OpenCodeTeamRuntimeBridgePort {
  private readonly lastRuntimeSnapshotsByProjectPath = new Map<
    string,
    OpenCodeBridgeRuntimeSnapshot
  >();

  constructor(
    private readonly bridge: OpenCodeReadinessBridgeCommandExecutor,
    private readonly options: OpenCodeReadinessBridgeOptions = {}
  ) {}

  async checkOpenCodeTeamLaunchReadiness(
    input: OpenCodeReadinessBridgeCommandBody
  ): Promise<OpenCodeTeamLaunchReadiness> {
    const result = await this.bridge.execute<
      OpenCodeReadinessBridgeCommandBody,
      OpenCodeTeamLaunchReadiness
    >('opencode.readiness', input, {
      cwd: input.projectPath,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    });

    if (result.ok) {
      this.lastRuntimeSnapshotsByProjectPath.set(input.projectPath, result.runtime);
      return result.data;
    }

    this.lastRuntimeSnapshotsByProjectPath.delete(input.projectPath);
    const supportDiagnostic = buildOpenCodeBridgeSupportDiagnostic({
      result,
      projectPath: input.projectPath,
      selectedModel: input.selectedModel,
      appVersion: this.options.appVersion ?? null,
    });
    return blockedReadiness({
      state: mapBridgeFailureToReadinessState(result.error.kind),
      modelId: input.selectedModel,
      diagnostics: [
        `OpenCode readiness bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
      missing: [result.error.message],
      supportDiagnostics: supportDiagnostic ? [supportDiagnostic] : undefined,
    });
  }

  getLastOpenCodeRuntimeSnapshot(projectPath: string): OpenCodeBridgeRuntimeSnapshot | null {
    return this.lastRuntimeSnapshotsByProjectPath.get(projectPath) ?? null;
  }

  async launchOpenCodeTeam(
    input: OpenCodeLaunchTeamCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData> {
    const result = await this.executeStateChangingCommand<
      OpenCodeLaunchTeamCommandBody,
      OpenCodeLaunchTeamCommandData
    >('opencode.launchTeam', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId,
      cwd: input.projectPath,
      timeoutMs: this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    return result.ok ? result.data : blockedLaunchData(input.runId, result);
  }

  async reconcileOpenCodeTeam(
    input: OpenCodeReconcileTeamCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData> {
    const cwd = input.projectPath ?? process.cwd();
    const result = await this.executeStateChangingCommand<
      OpenCodeReconcileTeamCommandBody,
      OpenCodeLaunchTeamCommandData
    >('opencode.reconcileTeam', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId ?? null,
      cwd,
      timeoutMs: this.options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS,
    });
    return result.ok ? result.data : blockedLaunchData(input.runId, result);
  }

  async stopOpenCodeTeam(input: OpenCodeStopTeamCommandBody): Promise<OpenCodeStopTeamCommandData> {
    const cwd = input.projectPath ?? process.cwd();
    const result = await this.executeStateChangingCommand<
      OpenCodeStopTeamCommandBody,
      OpenCodeStopTeamCommandData
    >('opencode.stopTeam', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId ?? null,
      cwd,
      timeoutMs: this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      runId: input.runId,
      stopped: false,
      members: {},
      warnings: [],
      diagnostics: [
        {
          code: result.error.kind,
          severity: 'error',
          message: `OpenCode stop bridge failed: ${result.error.message}`,
        },
        ...result.diagnostics.map((event) => ({
          code: event.type,
          severity: event.severity,
          message: event.message,
        })),
      ],
    };
  }

  async answerOpenCodeRuntimePermission(
    input: OpenCodeAnswerPermissionCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData> {
    const result = await this.executeStateChangingCommand<
      OpenCodeAnswerPermissionCommandBody,
      OpenCodeLaunchTeamCommandData
    >('opencode.answerPermission', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId ?? null,
      cwd: input.projectPath,
      timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    });
    return result.ok ? result.data : blockedLaunchData(input.runId, result);
  }

  async listOpenCodeRuntimePermissions(
    input: OpenCodeListRuntimePermissionsCommandBody
  ): Promise<OpenCodeListRuntimePermissionsCommandData> {
    const cwd = input.projectPath ?? process.cwd();
    const result = await this.bridge.execute<
      OpenCodeListRuntimePermissionsCommandBody,
      OpenCodeListRuntimePermissionsCommandData
    >('opencode.listRuntimePermissions', input, {
      cwd,
      timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    });
    if (result.ok) {
      return result.data;
    }
    return { permissions: [] };
  }

  async cleanupOpenCodeHosts(
    input: OpenCodeCleanupHostsCommandBody
  ): Promise<OpenCodeCleanupHostsCommandData> {
    const cwd = input.projectPath ?? process.cwd();
    const result = await this.bridge.execute<
      OpenCodeCleanupHostsCommandBody,
      OpenCodeCleanupHostsCommandData
    >('opencode.cleanupHosts', input, {
      cwd,
      timeoutMs: this.options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      cleaned: 0,
      remaining: 0,
      hosts: [],
      diagnostics: [
        `OpenCode host cleanup bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
    };
  }

  async sendOpenCodeTeamMessage(
    input: OpenCodeSendMessageCommandBody
  ): Promise<OpenCodeSendMessageCommandData> {
    const commandRequestId = `opencode-send-${randomUUID()}`;
    const body: OpenCodeSendMessageCommandBody = {
      ...input,
      payloadHash: input.payloadHash ?? buildSendPayloadHash(input),
    };
    let activeRequestId = commandRequestId;
    let activeBody = body;
    let usedObservedFallback = false;
    const executeSend = async (
      nextBody: OpenCodeSendMessageCommandBody,
      requestId: string
    ): Promise<{
      result: OpenCodeBridgeResult<OpenCodeSendMessageCommandData>;
      requestId: string;
    }> => {
      if (this.options.stateChangingCommands && nextBody.settlementMode === 'acceptance') {
        const result = await this.options.stateChangingCommands.execute<
          OpenCodeSendMessageCommandBody,
          OpenCodeSendMessageCommandData
        >({
          command: 'opencode.sendMessage',
          teamName: nextBody.teamName,
          laneId: nextBody.laneId,
          runId: nextBody.runId ?? null,
          capabilitySnapshotId: null,
          behaviorFingerprint: null,
          body: nextBody,
          cwd: nextBody.projectPath,
          timeoutMs: this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
        });
        return { result, requestId: result.requestId || requestId };
      }

      const result = await this.bridge.execute<
        OpenCodeSendMessageCommandBody,
        OpenCodeSendMessageCommandData
      >('opencode.sendMessage', nextBody, {
        cwd: nextBody.projectPath,
        timeoutMs: this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
        requestId,
      });
      return { result, requestId: result.requestId || requestId };
    };

    let result: OpenCodeBridgeResult<OpenCodeSendMessageCommandData>;
    try {
      const executed = await executeSend(activeBody, activeRequestId);
      result = executed.result;
      activeRequestId = executed.requestId;
    } catch (error) {
      if (body.settlementMode === 'acceptance' && isOpenCodeCompletedCommandRecoveryError(error)) {
        const recovered = await this.recoverSendMessageOutcome({
          originalRequestId: null,
          body: activeBody,
          diagnosticCode: 'opencode_send_recovered_after_duplicate_completed_command',
          diagnosticMessage: 'OpenCode bridge outcome recovered after duplicate completed command.',
        });
        if (recovered) {
          return recovered;
        }
      }
      if (
        body.settlementMode !== 'acceptance' ||
        !isOpenCodeAcceptanceContractMissingError(error)
      ) {
        throw error;
      }
      if (body.forceSessionRefreshReason?.trim()) {
        return buildOpenCodeForceSessionRefreshUnsupportedData(body, error);
      }
      activeRequestId = `${commandRequestId}-observed`;
      activeBody = {
        ...body,
        settlementMode: 'observed',
      };
      usedObservedFallback = true;
      const executed = await executeSend(activeBody, activeRequestId);
      result = executed.result;
      activeRequestId = executed.requestId;
    }

    if (
      !result.ok &&
      activeBody.settlementMode === 'acceptance' &&
      isOpenCodeAcceptanceContractMissingError(result.error.message)
    ) {
      if (body.forceSessionRefreshReason?.trim()) {
        return buildOpenCodeForceSessionRefreshUnsupportedData(body, result.error.message);
      }
      activeRequestId = `${commandRequestId}-observed`;
      activeBody = {
        ...body,
        settlementMode: 'observed',
      };
      usedObservedFallback = true;
      const executed = await executeSend(activeBody, activeRequestId);
      result = executed.result;
      activeRequestId = executed.requestId;
    }

    if (result.ok) {
      return usedObservedFallback
        ? withOpenCodeObservedFallbackDiagnostic(result.data)
        : result.data;
    }
    if (result.error.kind === 'timeout') {
      const recovered = await this.recoverSendMessageOutcome({
        originalRequestId: activeRequestId,
        body: activeBody,
        diagnosticCode: 'opencode_send_recovered_after_bridge_timeout',
        diagnosticMessage: 'OpenCode bridge outcome recovered after timeout.',
      });
      if (recovered) {
        return usedObservedFallback ? withOpenCodeObservedFallbackDiagnostic(recovered) : recovered;
      }
    }
    return {
      accepted: false,
      memberName: activeBody.memberName,
      diagnostics: [
        {
          code: result.error.kind,
          severity: 'error',
          message: `OpenCode message bridge failed: ${result.error.message}`,
        },
        ...result.diagnostics.map((event) => ({
          code: event.type,
          severity: event.severity,
          message: event.message,
        })),
      ],
    };
  }

  private async recoverSendMessageOutcome(input: {
    originalRequestId?: string | null;
    body: OpenCodeSendMessageCommandBody;
    diagnosticCode: string;
    diagnosticMessage: string;
  }): Promise<OpenCodeSendMessageCommandData | null> {
    if (!input.originalRequestId && !input.body.deliveryAttemptId) {
      return null;
    }
    const statusBody: OpenCodeCommandStatusCommandBody = {
      originalCommand: 'opencode.sendMessage',
      deliveryAttemptId: input.body.deliveryAttemptId,
      teamId: input.body.teamId,
      teamName: input.body.teamName,
      laneId: input.body.laneId,
      memberName: input.body.memberName,
      messageId: input.body.messageId,
      payloadHash: input.body.payloadHash,
      projectPath: input.body.projectPath,
      runId: input.body.runId,
      ...(input.originalRequestId ? { originalRequestId: input.originalRequestId } : {}),
    };
    const statusResult = await this.bridge.execute<
      OpenCodeCommandStatusCommandBody,
      OpenCodeCommandStatusCommandData
    >('opencode.commandStatus', statusBody, {
      cwd: input.body.projectPath,
      timeoutMs: DEFAULT_COMMAND_STATUS_TIMEOUT_MS,
    });
    if (!statusResult.ok) {
      return null;
    }
    const status = statusResult.data;
    if (
      input.originalRequestId &&
      status.originalRequestId &&
      status.originalRequestId !== input.originalRequestId
    ) {
      return null;
    }
    if (
      input.body.deliveryAttemptId &&
      status.deliveryAttemptId &&
      status.deliveryAttemptId !== input.body.deliveryAttemptId
    ) {
      return null;
    }
    if (status.status === 'precondition_mismatch' || status.accepted !== true) {
      return null;
    }
    const diagnostics = [
      {
        code: input.diagnosticCode,
        severity: 'warning' as const,
        message: input.diagnosticMessage,
      },
      ...status.diagnostics.map((message) => ({
        code: 'opencode_command_status',
        severity: 'info' as const,
        message,
      })),
    ];
    if (status.sendMessageData?.accepted === true) {
      return {
        ...status.sendMessageData,
        diagnostics: [...diagnostics, ...status.sendMessageData.diagnostics],
      };
    }
    return {
      accepted: true,
      memberName: input.body.memberName,
      sessionId: status.sessionId,
      runtimePid: status.runtimePid,
      runtimePromptMessageId: status.runtimePromptMessageId,
      prePromptCursor: status.prePromptCursor,
      diagnostics,
    };
  }

  async observeOpenCodeTeamMessageDelivery(
    input: OpenCodeObserveMessageDeliveryCommandBody
  ): Promise<OpenCodeObserveMessageDeliveryCommandData> {
    const result = await this.bridge.execute<
      OpenCodeObserveMessageDeliveryCommandBody,
      OpenCodeObserveMessageDeliveryCommandData
    >('opencode.observeMessageDelivery', input, {
      cwd: input.projectPath,
      timeoutMs: this.options.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      observed: false,
      memberName: input.memberName,
      responseObservation: {
        state: 'reconcile_failed',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: result.error.message,
      },
      diagnostics: [
        {
          code: result.error.kind,
          severity: 'error',
          message: `OpenCode message delivery observe bridge failed: ${result.error.message}`,
        },
        ...result.diagnostics.map((event) => ({
          code: event.type,
          severity: event.severity,
          message: event.message,
        })),
      ],
    };
  }

  async backfillOpenCodeTaskLedger(
    input: OpenCodeBackfillTaskLedgerCommandBody
  ): Promise<OpenCodeBackfillTaskLedgerCommandData> {
    const cwd = input.workspaceRoot ?? input.projectDir ?? process.cwd();
    const result = await this.bridge.execute<
      OpenCodeBackfillTaskLedgerCommandBody,
      OpenCodeBackfillTaskLedgerCommandData
    >('opencode.backfillTaskLedger', input, {
      cwd,
      timeoutMs: DEFAULT_BACKFILL_TIMEOUT_MS,
      stdoutLimitBytes: 2_000_000,
      stderrLimitBytes: 512_000,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      schemaVersion: 1,
      providerId: 'opencode',
      teamName: input.teamName,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.projectDir ? { projectDir: input.projectDir } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      dryRun: input.dryRun === true,
      ...(input.attributionMode ? { attributionMode: input.attributionMode } : {}),
      scannedSessions: 0,
      scannedToolparts: 0,
      candidateEvents: 0,
      importedEvents: 0,
      skippedEvents: 0,
      outcome: result.error.retryable ? 'transient-error' : 'unsafe-input',
      notices: [],
      diagnostics: [
        `OpenCode task ledger backfill bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
    };
  }

  private async executeStateChangingCommand<TBody, TData>(
    command: OpenCodeStateChangingTeamCommandName,
    body: TBody,
    input: {
      teamName: string;
      laneId: string;
      runId: string;
      capabilitySnapshotId: string | null;
      cwd: string;
      timeoutMs: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>> {
    if (this.options.stateChangingCommands) {
      try {
        return await this.options.stateChangingCommands.execute<TBody, TData>({
          command,
          teamName: input.teamName,
          laneId: input.laneId,
          runId: input.runId,
          capabilitySnapshotId: input.capabilitySnapshotId,
          behaviorFingerprint: null,
          body,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        return thrownBridgeFailure(command, input.runId, error);
      }
    }

    return this.bridge.execute<TBody, TData>(command, body, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
  }
}

type OpenCodeStateChangingTeamCommandName = Extract<
  OpenCodeBridgeCommandName,
  | 'opencode.launchTeam'
  | 'opencode.reconcileTeam'
  | 'opencode.stopTeam'
  | 'opencode.sendMessage'
  | 'opencode.answerPermission'
>;

function blockedLaunchData(
  runId: string,
  result: OpenCodeBridgeResult<unknown>
): OpenCodeLaunchTeamCommandData {
  if (result.ok) {
    throw new Error('blockedLaunchData expects a failed bridge result');
  }
  return {
    runId,
    teamLaunchState: 'failed',
    members: {},
    warnings: [],
    diagnostics: [
      {
        code: result.error.kind,
        severity: 'error',
        message: `OpenCode bridge failed: ${result.error.message}`,
      },
      ...result.diagnostics.map((event) => ({
        code: event.type,
        severity: event.severity,
        message: event.message,
      })),
    ],
  };
}

function blockedReadiness(input: {
  state: OpenCodeTeamLaunchReadinessState;
  modelId: string | null;
  diagnostics: string[];
  missing: string[];
  supportDiagnostics?: OpenCodeTeamLaunchReadiness['supportDiagnostics'];
}): OpenCodeTeamLaunchReadiness {
  return {
    state: input.state,
    launchAllowed: false,
    modelId: input.modelId,
    availableModels: [],
    opencodeVersion: null,
    installMethod: null,
    binaryPath: null,
    hostHealthy: false,
    appMcpConnected: false,
    requiredToolsPresent: false,
    permissionBridgeReady: false,
    runtimeStoresReady: false,
    supportLevel: null,
    missing: dedupe(input.missing),
    diagnostics: dedupe(input.diagnostics),
    ...(input.supportDiagnostics?.length
      ? { supportDiagnostics: [...input.supportDiagnostics] }
      : {}),
    evidence: {
      capabilitiesReady: false,
      mcpToolProofRoute: null,
      observedMcpTools: [],
      runtimeStoreReadinessReason: null,
    },
  };
}

function mapBridgeFailureToReadinessState(
  kind: OpenCodeBridgeFailureKind
): OpenCodeTeamLaunchReadinessState {
  switch (kind) {
    case 'runtime_not_ready':
      return 'adapter_disabled';
    case 'timeout':
    case 'contract_violation':
    case 'provider_error':
    case 'unsupported_schema':
    case 'unsupported_command':
    case 'invalid_input':
    case 'internal_error':
    default:
      return 'unknown_error';
  }
}

function formatDiagnosticEvent(event: OpenCodeBridgeDiagnosticEvent): string {
  return `${event.type}: ${event.message}`;
}

function isOpenCodeAcceptanceContractMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OpenCode delivery acceptance mode is required');
}

function buildOpenCodeForceSessionRefreshUnsupportedData(
  body: OpenCodeSendMessageCommandBody,
  error: unknown
): OpenCodeSendMessageCommandData {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `OpenCode forced session refresh requires delivery acceptance contract version ${OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION}. Update agent_teams_orchestrator and restart the app.`;
  return {
    accepted: false,
    memberName: body.memberName,
    responseObservation: {
      state: 'session_stale',
      deliveredUserMessageId: null,
      assistantMessageId: null,
      toolCallNames: [],
      visibleMessageToolCallId: null,
      visibleReplyMessageId: null,
      visibleReplyCorrelation: null,
      latestAssistantPreview: null,
      reason,
    },
    diagnostics: [
      {
        code: 'opencode_force_session_refresh_contract_missing',
        severity: 'error',
        message: `${reason} ${detail}`,
      },
    ],
  };
}

function isOpenCodeCompletedCommandRecoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(OPEN_CODE_COMPLETED_COMMAND_RECOVERY_MESSAGE);
}

function withOpenCodeObservedFallbackDiagnostic(
  data: OpenCodeSendMessageCommandData
): OpenCodeSendMessageCommandData {
  return {
    ...data,
    diagnostics: [
      {
        code: 'opencode_accept_fast_capability_missing',
        severity: 'warning',
        message:
          'OpenCode delivery acceptance capability was not advertised by the orchestrator; used observed delivery mode.',
      },
      ...data.diagnostics,
    ],
  };
}

function thrownBridgeFailure<TData>(
  command: OpenCodeBridgeCommandName,
  runId: string,
  error: unknown
): OpenCodeBridgeResult<TData> {
  const message = error instanceof Error ? error.message : String(error);
  const completedAt = new Date().toISOString();
  return {
    ok: false,
    schemaVersion: 1,
    requestId: 'opencode-state-changing-bridge-exception',
    command,
    completedAt,
    durationMs: 0,
    error: {
      kind: 'internal_error',
      message,
      retryable: false,
    },
    diagnostics: [
      {
        type: 'opencode_state_changing_bridge_exception',
        providerId: 'opencode',
        runId,
        severity: 'error',
        message,
        createdAt: completedAt,
      },
    ],
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
