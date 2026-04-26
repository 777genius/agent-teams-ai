import type { OpenCodeTeamRuntimeBridgePort } from '../../runtime/OpenCodeTeamRuntimeAdapter';
import type {
  OpenCodeTeamLaunchReadiness,
  OpenCodeTeamLaunchReadinessState,
} from '../readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeDiagnosticEvent,
  OpenCodeBridgeFailureKind,
  OpenCodeBridgeResult,
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeBackfillTaskLedgerCommandBody,
  OpenCodeBackfillTaskLedgerCommandData,
  OpenCodeCleanupHostsCommandBody,
  OpenCodeCleanupHostsCommandData,
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
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
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_OBSERVE_TIMEOUT_MS = 8_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_BACKFILL_TIMEOUT_MS = 45_000;

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
    return blockedReadiness({
      state: mapBridgeFailureToReadinessState(result.error.kind),
      modelId: input.selectedModel,
      diagnostics: [
        `OpenCode readiness bridge failed: ${result.error.kind}: ${result.error.message}`,
        ...result.diagnostics.map(formatDiagnosticEvent),
      ],
      missing: [result.error.message],
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
    const result = await this.bridge.execute<
      OpenCodeSendMessageCommandBody,
      OpenCodeSendMessageCommandData
    >('opencode.sendMessage', input, {
      cwd: input.projectPath,
      timeoutMs: this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    });
    if (result.ok) {
      return result.data;
    }
    return {
      accepted: false,
      memberName: input.memberName,
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
  'opencode.launchTeam' | 'opencode.reconcileTeam' | 'opencode.stopTeam'
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
