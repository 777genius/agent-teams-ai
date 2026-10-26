import { getDesktopMcpChildEnvironment } from '@features/external-agent-connection/main';
import { randomUUID } from 'crypto';

import { openCodeReadinessArtifactKey } from '../readiness/OpenCodeExpectedBehaviorFingerprint';
import { normalizeOpenCodeProjectIdentity } from '../readiness/OpenCodeProjectIdentity';

import {
  OPEN_CODE_DELIVERY_ACCEPTANCE_CONTRACT_VERSION,
  stableHash,
} from './OpenCodeBridgeCommandContract';
import { OpenCodeBridgeCommandLedgerError } from './OpenCodeBridgeCommandLedgerStore';
import {
  findOpenCodeFreeTierVersionFailure,
  getKnownOpenCodeFreeTierVersionFailure,
} from './OpenCodeBridgeFreeTierReadiness';
import {
  blockedReadiness,
  mapBridgeFailureToReadinessState,
} from './OpenCodeBridgeReadinessResult';
import { buildOpenCodeBridgeSupportDiagnostic } from './OpenCodeBridgeSupportDiagnostics';
import { createOpenCodeUnobservedDeliveryResponse } from './OpenCodeDeliveryObservation';
import {
  blockedLaunchData,
  isAmbiguousOpenCodeLaunchFailure,
  isOpenCodeBridgeEmptyOutputFailure,
  reconciliationRequiredLaunchData,
} from './OpenCodeLaunchResultHelpers';
import {
  OPEN_CODE_BRIDGE_TIMEOUTS_MS,
  resolveOpenCodeLaunchTimeoutMs,
  resolveOpenCodeReadinessTimeoutMs,
} from './OpenCodeReadinessTimeoutPolicy';
import { recoverOpenCodeSendMessageOutcome } from './OpenCodeSendMessageOutcomeRecovery';
import { executeOpenCodeStartupCleanup } from './OpenCodeStartupCleanupBridge';
import { type OpenCodeStateChangingBridgeCommandService } from './OpenCodeStateChangingBridgeCommandService';
import { isOpenCodePromptNotSubmittedFailure } from './OpenCodeStateChangingBridgePreconditions';
import {
  ownedOpenCodeStateChangingFailure,
  projectOpenCodeStateChangingFailure,
} from './OpenCodeStateChangingCausalFailure';

import type { OpenCodeTeamRuntimeBridgePort } from '../../runtime/OpenCodeTeamRuntimeAdapter';
import type { OpenCodeTeamLaunchReadiness } from '../readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeAnswerPermissionCommandBody,
  OpenCodeBackfillTaskLedgerCommandBody,
  OpenCodeBackfillTaskLedgerCommandData,
  OpenCodeBridgeCommandName,
  OpenCodeBridgeDiagnosticEvent,
  OpenCodeBridgeResult,
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeCleanupHostsCommandBody,
  OpenCodeCleanupHostsCommandData,
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeListRuntimePermissionsCommandBody,
  OpenCodeListRuntimePermissionsCommandData,
  OpenCodeObserveMessageDeliveryCommandBody,
  OpenCodeObserveMessageDeliveryCommandData,
  OpenCodeReconcileTeamCommandBody,
  OpenCodeReconcileTeamCommandData,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
  OpenCodeStopTeamCommandBody,
  OpenCodeStopTeamCommandData,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeReadinessBridgeTimeoutOptions } from './OpenCodeReadinessTimeoutPolicy';
import type { RuntimeStopObservation } from './OpenCodeRuntimeStopProtocol';
import type { OpenCodeStartupCleanupData } from './OpenCodeStartupCleanupBridge';
import type { OpenCodeStartupCleanupBudget } from './OpenCodeStartupCleanupBudget';

export interface OpenCodeLedgerBackfillPort {
  getRuntimeIdentity?(): Promise<string | null>;
  backfillOpenCodeTaskLedger(
    input: OpenCodeBackfillTaskLedgerCommandBody
  ): Promise<OpenCodeBackfillTaskLedgerCommandData>;
}

export interface OpenCodeReadinessBridgeCommandExecutor {
  prepareShutdownCleanup?(currentBoundChildEnv: Readonly<Record<string, string>>): void;
  getRuntimeIdentity?(): Promise<string | null>;
  observeStartupCleanup?(
    requestId: string
  ): Promise<OpenCodeBridgeResult<OpenCodeStartupCleanupData> | null>;
  execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: {
      cwd: string;
      timeoutMs: number;
      requestId?: string;
      canDispatch?: () => boolean;
      stdoutLimitBytes?: number;
      stderrLimitBytes?: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>>;
}

export interface OpenCodeReadinessBridgeOptions extends OpenCodeReadinessBridgeTimeoutOptions {
  appVersion?: string;
  stateChangingCommands?: Pick<OpenCodeStateChangingBridgeCommandService, 'execute'>;
  readOpenCodeRuntimeStatus?: () => Promise<{ installed: boolean; version?: string }>;
}

export interface OpenCodeReadinessBridgeCommandBody {
  projectPath: string;
  selectedModel: string | null;
  requireExecutionProbe: boolean;
  skipPermissions?: boolean;
}

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
  private readonly lastRuntimeSnapshotsByReadinessKey = new Map<
    string,
    OpenCodeBridgeRuntimeSnapshot
  >();

  constructor(
    private readonly bridge: OpenCodeReadinessBridgeCommandExecutor,
    private readonly options: OpenCodeReadinessBridgeOptions = {}
  ) {}

  prepareShutdownCleanup(): void {
    if (!this.bridge.prepareShutdownCleanup) return;
    let current: Record<string, string> = {};
    try {
      current = getDesktopMcpChildEnvironment();
    } catch {
      /* No current binding must clear any previously prepared cleanup. */
    }
    try {
      this.bridge.prepareShutdownCleanup(current);
    } catch {
      /* Preparation never replaces the normal environment-provider refusal. */
    }
  }

  getRuntimeIdentity(): Promise<string | null> {
    return this.bridge.getRuntimeIdentity?.() ?? Promise.resolve(null);
  }

  async checkOpenCodeTeamLaunchReadiness(
    input: OpenCodeReadinessBridgeCommandBody
  ): Promise<OpenCodeTeamLaunchReadiness> {
    const { failure: knownVersionFailure, runtimeStatus } =
      await getKnownOpenCodeFreeTierVersionFailure(
        input.selectedModel,
        this.options.readOpenCodeRuntimeStatus
      );
    if (knownVersionFailure) {
      this.clearRuntimeSnapshots(input);
      return blockedReadiness({
        state: 'unsupported_version',
        modelId: input.selectedModel,
        diagnostics: [knownVersionFailure],
        missing: [knownVersionFailure],
      });
    }
    const result = await this.bridge.execute<
      OpenCodeReadinessBridgeCommandBody,
      OpenCodeTeamLaunchReadiness
    >('opencode.readiness', input, {
      cwd: input.projectPath,
      timeoutMs: resolveOpenCodeReadinessTimeoutMs(input.selectedModel, this.options.timeoutMs),
    });

    if (result.ok) {
      const versionFailure = !result.data.launchAllowed
        ? findOpenCodeFreeTierVersionFailure(
            [...result.data.missing, ...result.data.diagnostics],
            result.data.opencodeVersion,
            runtimeStatus?.binaryOverrideEnvName
          )
        : null;
      if (versionFailure) {
        this.clearRuntimeSnapshots(input);
        return blockedReadiness({
          state: 'unsupported_version',
          modelId: input.selectedModel,
          diagnostics: [versionFailure],
          missing: [versionFailure],
        });
      }
      this.lastRuntimeSnapshotsByProjectPath.set(
        normalizeOpenCodeProjectIdentity(input.projectPath),
        result.runtime
      );
      this.lastRuntimeSnapshotsByReadinessKey.set(
        openCodeReadinessArtifactKey(input),
        result.runtime
      );
      return result.data;
    }

    this.clearRuntimeSnapshots(input);
    const versionFailure = findOpenCodeFreeTierVersionFailure(
      [result.error.message, ...result.diagnostics.map(formatDiagnosticEvent)],
      runtimeStatus?.version,
      runtimeStatus?.binaryOverrideEnvName
    );
    const supportDiagnostic = buildOpenCodeBridgeSupportDiagnostic({
      result,
      projectPath: input.projectPath,
      selectedModel: input.selectedModel,
      appVersion: this.options.appVersion ?? null,
    });
    return blockedReadiness({
      state: versionFailure
        ? 'unsupported_version'
        : mapBridgeFailureToReadinessState(result.error.kind),
      modelId: input.selectedModel,
      diagnostics: [
        ...(versionFailure ? [versionFailure] : []),
        `OpenCode readiness bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
      missing: [versionFailure ?? result.error.message],
      supportDiagnostics: supportDiagnostic ? [supportDiagnostic] : undefined,
    });
  }

  private clearRuntimeSnapshots(input: OpenCodeReadinessBridgeCommandBody): void {
    this.lastRuntimeSnapshotsByProjectPath.delete(
      normalizeOpenCodeProjectIdentity(input.projectPath)
    );
    this.lastRuntimeSnapshotsByReadinessKey.delete(openCodeReadinessArtifactKey(input));
  }

  getLastOpenCodeRuntimeSnapshot(
    projectPath: string,
    selectedModel?: string | null,
    requireExecutionProbe?: boolean,
    skipPermissions?: boolean
  ): OpenCodeBridgeRuntimeSnapshot | null {
    if (requireExecutionProbe !== undefined) {
      return (
        this.lastRuntimeSnapshotsByReadinessKey.get(
          openCodeReadinessArtifactKey({
            projectPath,
            selectedModel: selectedModel ?? null,
            requireExecutionProbe,
            skipPermissions,
          })
        ) ?? null
      );
    }
    return (
      this.lastRuntimeSnapshotsByProjectPath.get(normalizeOpenCodeProjectIdentity(projectPath)) ??
      null
    );
  }

  async launchOpenCodeTeam(
    input: OpenCodeLaunchTeamCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData> {
    // Managed Cursor receives profile HTTP MCP configuration from the runtime.
    // Launch must never register an app endpoint in the user's global Cursor config.
    const result = await this.executeStateChangingCommand<
      OpenCodeLaunchTeamCommandBody,
      OpenCodeLaunchTeamCommandData
    >('opencode.launchTeam', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId,
      cwd: input.projectPath,
      timeoutMs: resolveOpenCodeLaunchTimeoutMs(input, this.options.launchTimeoutMs),
    });
    return result.ok
      ? result.data
      : isAmbiguousOpenCodeLaunchFailure(result)
        ? reconciliationRequiredLaunchData(input, result)
        : blockedLaunchData(input.runId, result);
  }

  async reconcileOpenCodeTeam(
    input: OpenCodeReconcileTeamCommandBody
  ): Promise<OpenCodeReconcileTeamCommandData> {
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
      timeoutMs: this.options.reconcileTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.reconcile,
    });
    return result.ok
      ? result.data
      : { ...blockedLaunchData(input.runId, result), observationUnavailable: true };
  }

  async stopOpenCodeTeam(
    input: OpenCodeStopTeamCommandBody
  ): Promise<OpenCodeStopTeamCommandData | RuntimeStopObservation> {
    const cwd = input.projectPath ?? process.cwd();
    const result = await this.executeStateChangingCommand<
      OpenCodeStopTeamCommandBody,
      OpenCodeStopTeamCommandData | RuntimeStopObservation
    >('opencode.stopTeam', input, {
      teamName: input.teamName,
      laneId: input.laneId,
      runId: input.runId,
      capabilitySnapshotId: input.expectedCapabilitySnapshotId ?? null,
      cwd,
      timeoutMs: this.options.stopTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.stop,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      runId: input.runId,
      stopped: false,
      causalFailure: ownedOpenCodeStateChangingFailure(result.error.details?.causalFailure),
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
      timeoutMs: OPEN_CODE_BRIDGE_TIMEOUTS_MS.permission,
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
      timeoutMs: OPEN_CODE_BRIDGE_TIMEOUTS_MS.permission,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      permissions: [],
      diagnostics: [
        `OpenCode runtime permission list bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
    };
  }

  observeOpenCodeStartupCleanup(requestId: string) {
    return this.bridge.observeStartupCleanup?.(requestId) ?? Promise.resolve(null);
  }

  cleanupOpenCodeStartupHosts(
    budget: OpenCodeStartupCleanupBudget,
    appStartedAtMs = Date.now(),
    canDispatch?: () => boolean,
    requestId?: string
  ) {
    return executeOpenCodeStartupCleanup(
      this.bridge,
      budget,
      appStartedAtMs,
      canDispatch,
      requestId
    );
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
      timeoutMs: this.options.cleanupTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.cleanup,
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
      if (this.options.stateChangingCommands) {
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
          timeoutMs: this.options.sendTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.send,
        });
        return { result, requestId: result.requestId || requestId };
      }

      const result = await this.bridge.execute<
        OpenCodeSendMessageCommandBody,
        OpenCodeSendMessageCommandData
      >('opencode.sendMessage', nextBody, {
        cwd: nextBody.projectPath,
        timeoutMs: this.options.sendTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.send,
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
        const recovered = await recoverOpenCodeSendMessageOutcome(this.bridge, {
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
    if (
      !isOpenCodePromptNotSubmittedFailure(result) &&
      (result.error.kind === 'timeout' ||
        result.error.kind === 'transport_watchdog_timeout' ||
        isOpenCodeBridgeEmptyOutputFailure(result))
    ) {
      const recoveredAfterEmptyOutput = isOpenCodeBridgeEmptyOutputFailure(result);
      const recovered = await recoverOpenCodeSendMessageOutcome(this.bridge, {
        originalRequestId: activeRequestId,
        body: activeBody,
        diagnosticCode: recoveredAfterEmptyOutput
          ? 'opencode_send_recovered_after_bridge_empty_output'
          : 'opencode_send_recovered_after_bridge_timeout',
        diagnosticMessage: recoveredAfterEmptyOutput
          ? 'OpenCode bridge outcome recovered after empty bridge output.'
          : 'OpenCode bridge outcome recovered after timeout.',
      });
      if (recovered) {
        return usedObservedFallback ? withOpenCodeObservedFallbackDiagnostic(recovered) : recovered;
      }
    }
    return {
      accepted: false,
      ...(isOpenCodePromptNotSubmittedFailure(result) ? { promptNotSubmitted: true as const } : {}),
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

  async observeOpenCodeTeamMessageDelivery(
    input: OpenCodeObserveMessageDeliveryCommandBody
  ): Promise<OpenCodeObserveMessageDeliveryCommandData> {
    let correctivePromptId: string | undefined;
    if (input.deliveryAttemptId) {
      const recovered = await recoverOpenCodeSendMessageOutcome(this.bridge, {
        body: input,
        requireExactDeliveryAttempt: true,
        diagnosticCode: 'opencode_corrective_handoff_recovered',
        diagnosticMessage: 'Recovered the exact corrective prompt acceptance.',
      });
      if (!recovered?.runtimePromptMessageId)
        return {
          observed: false,
          responseObservation: createOpenCodeUnobservedDeliveryResponse(
            'not_observed',
            'corrective_handoff_unknown'
          ),
          memberName: input.memberName,
          diagnostics: [
            {
              code: 'opencode_corrective_handoff_unknown',
              severity: 'warning',
              message: 'The corrective prompt acceptance is still unknown.',
            },
          ],
        };
      input = { ...input, runtimePromptMessageId: recovered.runtimePromptMessageId };
      correctivePromptId = recovered.runtimePromptMessageId;
    }
    const result = await this.bridge.execute<
      OpenCodeObserveMessageDeliveryCommandBody,
      OpenCodeObserveMessageDeliveryCommandData
    >('opencode.observeMessageDelivery', input, {
      cwd: input.projectPath,
      timeoutMs: this.options.observeTimeoutMs ?? OPEN_CODE_BRIDGE_TIMEOUTS_MS.observe,
    });
    if (result.ok) {
      if (
        correctivePromptId &&
        result.data.responseObservation?.deliveredUserMessageId !== correctivePromptId
      )
        return {
          observed: false,
          responseObservation: createOpenCodeUnobservedDeliveryResponse(
            'not_observed',
            'corrective_handoff_unknown'
          ),
          memberName: input.memberName,
          diagnostics: [
            {
              code: 'opencode_corrective_prompt_not_observed',
              severity: 'warning',
              message: 'The exact corrective prompt is not indexed in the observation yet.',
            },
          ],
        };
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
      timeoutMs: OPEN_CODE_BRIDGE_TIMEOUTS_MS.backfill,
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
          behaviorFingerprint:
            command === 'opencode.launchTeam'
              ? (body as OpenCodeLaunchTeamCommandBody).expectedBehaviorFingerprint
              : null,
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
  const unknownOutcome =
    error instanceof OpenCodeBridgeCommandLedgerError &&
    (message === 'OpenCode bridge command outcome must be reconciled before retry' ||
      message === 'OpenCode bridge command already started');
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
      details: { causalFailure: projectOpenCodeStateChangingFailure(error) },
    },
    diagnostics: [
      {
        type: unknownOutcome
          ? 'opencode_bridge_unknown_outcome'
          : 'opencode_state_changing_bridge_exception',
        providerId: 'opencode',
        runId,
        severity: unknownOutcome ? 'warning' : 'error',
        message,
        createdAt: completedAt,
      },
    ],
  };
}
