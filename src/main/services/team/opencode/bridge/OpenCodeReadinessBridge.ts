import {
  assertOpenCodeProductionE2EArtifactGate,
  buildOpenCodeProjectPathFingerprint,
  type OpenCodeProductionE2EEvidence,
} from '../e2e/OpenCodeProductionE2EEvidence';
import {
  buildOpenCodeCanonicalMcpToolId,
  REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS,
} from '../mcp/OpenCodeMcpToolAvailability';

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
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeReconcileTeamCommandBody,
  OpenCodeStopTeamCommandBody,
  OpenCodeStopTeamCommandData,
  OpenCodeTeamLaunchMode,
} from './OpenCodeBridgeCommandContract';
import type { OpenCodeStateChangingBridgeCommandService } from './OpenCodeStateChangingBridgeCommandService';

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
  stopTimeoutMs?: number;
  stateChangingCommands?: Pick<OpenCodeStateChangingBridgeCommandService, 'execute'>;
  productionE2eEvidence?: OpenCodeProductionE2EEvidenceReadPort;
}

export interface OpenCodeProductionE2EEvidenceReadPort {
  read(input?: {
    selectedModel?: string | null;
    projectPathFingerprint?: string | null;
    opencodeVersion?: string | null;
    binaryFingerprint?: string | null;
    capabilitySnapshotId?: string | null;
  }): Promise<{
    ok: boolean;
    evidence: OpenCodeProductionE2EEvidence | null;
    artifactPath: string;
    diagnostics: string[];
  }>;
}

export interface OpenCodeReadinessBridgeCommandBody {
  projectPath: string;
  selectedModel: string | null;
  requireExecutionProbe: boolean;
  launchMode?: OpenCodeTeamLaunchMode;
}

const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

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
      return this.applyProductionE2EGate({
        input,
        readiness: result.data,
        runtime: result.runtime,
      });
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

  private async applyProductionE2EGate(input: {
    input: OpenCodeReadinessBridgeCommandBody;
    readiness: OpenCodeTeamLaunchReadiness;
    runtime: OpenCodeBridgeRuntimeSnapshot;
  }): Promise<OpenCodeTeamLaunchReadiness> {
    const launchMode = input.input.launchMode;
    if (launchMode !== 'production' && launchMode !== 'dogfood') {
      return input.readiness;
    }
    if (!input.readiness.launchAllowed) {
      return input.readiness;
    }

    const expectedModel = input.readiness.modelId ?? input.input.selectedModel;
    const projectPathFingerprint = buildOpenCodeProjectPathFingerprint(input.input.projectPath);
    const evidenceRead = this.options.productionE2eEvidence
      ? await this.options.productionE2eEvidence.read({
          selectedModel: expectedModel,
          projectPathFingerprint,
          opencodeVersion: input.runtime.version,
          binaryFingerprint: input.runtime.binaryFingerprint,
          capabilitySnapshotId: input.runtime.capabilitySnapshotId,
        })
      : {
          ok: false,
          evidence: null,
          artifactPath: '',
          diagnostics: ['OpenCode production E2E evidence store is not configured'],
        };
    const gate = evidenceRead.ok
      ? assertOpenCodeProductionE2EArtifactGate({
          evidence: evidenceRead.evidence,
          artifactPath: evidenceRead.artifactPath,
          expected: {
            opencodeVersion: input.runtime.version,
            binaryFingerprint: input.runtime.binaryFingerprint,
            capabilitySnapshotId: input.runtime.capabilitySnapshotId,
            selectedModel: expectedModel,
            projectPathFingerprint,
            requiredMcpTools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) =>
              buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
            ),
          },
        })
      : {
          ok: false,
          diagnostics: evidenceRead.diagnostics,
        };

    if (gate.ok) {
      return {
        ...input.readiness,
        diagnostics: dedupe([...input.readiness.diagnostics, ...evidenceRead.diagnostics]),
        supportLevel: 'production_supported',
      };
    }

    const diagnostics = dedupe([
      ...input.readiness.diagnostics,
      ...evidenceRead.diagnostics,
      ...gate.diagnostics,
    ]);
    if (launchMode === 'dogfood') {
      return {
        ...input.readiness,
        supportLevel: 'supported_e2e_pending',
        diagnostics,
      };
    }

    return {
      ...input.readiness,
      state: 'e2e_missing',
      launchAllowed: false,
      supportLevel: 'supported_e2e_pending',
      missing: dedupe([...input.readiness.missing, ...gate.diagnostics]),
      diagnostics,
    };
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
