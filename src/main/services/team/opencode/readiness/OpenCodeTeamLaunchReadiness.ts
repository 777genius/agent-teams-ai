import type { OpenCodeApiCapabilities } from '../capabilities/OpenCodeApiCapabilities';
import type { OpenCodeTeamLaunchMode } from '../bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeMcpToolProof } from '../mcp/OpenCodeMcpToolAvailability';
import {
  evaluateOpenCodeSupport,
  OPENCODE_TEAM_LAUNCH_VERSION_POLICY,
  type OpenCodeInstallMethod,
  type OpenCodeProductionE2EEvidence,
  type OpenCodeSupportLevel,
  type OpenCodeSupportedVersionPolicy,
} from '../version/OpenCodeVersionPolicy';
import type { RuntimeStoreReadinessCheck } from '../store/RuntimeStoreManifest';

export type OpenCodeTeamLaunchReadinessState =
  | 'ready'
  | 'not_installed'
  | 'not_authenticated'
  | 'unsupported_version'
  | 'capabilities_missing'
  | 'e2e_missing'
  | 'runtime_store_blocked'
  | 'mcp_unavailable'
  | 'model_unavailable'
  | 'adapter_disabled'
  | 'unknown_error';

export interface OpenCodeRuntimeInventory {
  detected: boolean;
  binaryPath: string | null;
  installMethod: OpenCodeInstallMethod;
  version: string | null;
  authenticated: boolean;
  connectedProviders: string[];
  models: string[];
  diagnostics: string[];
}

export interface OpenCodeModelExecutionProbeResult {
  outcome: 'available' | 'unavailable' | 'unknown';
  reason: string | null;
  diagnostics: string[];
}

export interface OpenCodeTeamLaunchReadiness {
  state: OpenCodeTeamLaunchReadinessState;
  launchAllowed: boolean;
  modelId: string | null;
  availableModels: string[];
  opencodeVersion: string | null;
  installMethod: OpenCodeInstallMethod | null;
  binaryPath: string | null;
  hostHealthy: boolean;
  appMcpConnected: boolean;
  requiredToolsPresent: boolean;
  permissionBridgeReady: boolean;
  runtimeStoresReady: boolean;
  supportLevel: OpenCodeSupportLevel | null;
  missing: string[];
  diagnostics: string[];
  evidence: {
    capabilitiesReady: boolean;
    mcpToolProofRoute: OpenCodeMcpToolProof['route'];
    observedMcpTools: string[];
    runtimeStoreReadinessReason: RuntimeStoreReadinessCheck['reason'] | null;
  };
}

export interface OpenCodeRuntimeInventoryPort {
  probe(input: { projectPath: string }): Promise<OpenCodeRuntimeInventory>;
}

export interface OpenCodeApiCapabilityPort {
  detect(input: {
    projectPath: string;
    inventory: OpenCodeRuntimeInventory;
  }): Promise<OpenCodeApiCapabilities>;
}

export interface OpenCodeMcpToolProofPort {
  prove(input: {
    projectPath: string;
    modelId: string;
    inventory: OpenCodeRuntimeInventory;
    capabilities: OpenCodeApiCapabilities;
  }): Promise<OpenCodeMcpToolProof>;
}

export interface OpenCodeRuntimeStoreReadinessPort {
  check(input: { projectPath: string }): Promise<RuntimeStoreReadinessCheck>;
}

export interface OpenCodeModelExecutionProbePort {
  verify(input: {
    projectPath: string;
    modelId: string;
    inventory: OpenCodeRuntimeInventory;
  }): Promise<OpenCodeModelExecutionProbeResult>;
}

export interface OpenCodeProductionE2EEvidencePort {
  read(input: {
    projectPath: string;
    inventory: OpenCodeRuntimeInventory;
    capabilities: OpenCodeApiCapabilities;
  }): Promise<OpenCodeProductionE2EEvidence | null>;
}

export interface OpenCodeTeamLaunchReadinessServiceOptions {
  versionPolicy?: OpenCodeSupportedVersionPolicy;
  launchMode?: OpenCodeTeamLaunchMode;
  /**
   * @deprecated Use launchMode. Kept for callers that still pass a boolean feature gate.
   */
  adapterEnabled?: boolean;
}

export class OpenCodeTeamLaunchReadinessService {
  constructor(
    private readonly inventory: OpenCodeRuntimeInventoryPort,
    private readonly capabilities: OpenCodeApiCapabilityPort,
    private readonly mcpTools: OpenCodeMcpToolProofPort,
    private readonly runtimeStores: OpenCodeRuntimeStoreReadinessPort,
    private readonly modelExecution: OpenCodeModelExecutionProbePort,
    private readonly e2eEvidence: OpenCodeProductionE2EEvidencePort,
    private readonly options: OpenCodeTeamLaunchReadinessServiceOptions = {}
  ) {}

  async check(input: {
    projectPath: string;
    selectedModel: string | null;
    requireExecutionProbe: boolean;
    launchMode?: OpenCodeTeamLaunchMode;
  }): Promise<OpenCodeTeamLaunchReadiness> {
    const launchMode = resolveReadinessLaunchMode(input.launchMode, this.options);
    const policy = this.options.versionPolicy ?? OPENCODE_TEAM_LAUNCH_VERSION_POLICY;
    const dogfoodWarnings: string[] = [];

    if (launchMode === 'disabled') {
      return readiness({
        state: 'adapter_disabled',
        inventory: null,
        modelId: input.selectedModel,
        missing: ['OpenCode team launch adapter is disabled by feature gate'],
        diagnostics: ['OpenCode team launch adapter is disabled by feature gate'],
      });
    }

    try {
      const inventory = await this.inventory.probe({ projectPath: input.projectPath });
      if (!inventory.detected) {
        return readiness({
          state: 'not_installed',
          inventory,
          modelId: input.selectedModel,
          diagnostics: appendDiagnostics(inventory.diagnostics, [
            'OpenCode CLI not detected on PATH',
          ]),
        });
      }

      if (!inventory.authenticated || inventory.connectedProviders.length === 0) {
        return readiness({
          state: 'not_authenticated',
          inventory,
          modelId: input.selectedModel,
          diagnostics: appendDiagnostics(inventory.diagnostics, [
            'No connected OpenCode providers found',
          ]),
        });
      }

      const modelId = input.selectedModel ?? inventory.models[0] ?? null;
      if (!modelId) {
        return readiness({
          state: 'model_unavailable',
          inventory,
          modelId: null,
          diagnostics: appendDiagnostics(inventory.diagnostics, ['No OpenCode model is available']),
        });
      }

      const capabilities = await this.capabilities.detect({
        projectPath: input.projectPath,
        inventory,
      });
      const evidence = await this.e2eEvidence.read({
        projectPath: input.projectPath,
        inventory,
        capabilities,
      });
      const support = evaluateOpenCodeSupport({
        version: inventory.version ?? '0.0.0',
        capabilities,
        evidence,
        policy,
      });

      if (!support.supported) {
        if (launchMode === 'dogfood' && support.supportLevel === 'supported_e2e_pending') {
          dogfoodWarnings.push(
            'OpenCode production E2E evidence is missing; dogfood launch remains allowed after runtime checks.'
          );
        } else {
          return readiness({
            state: mapSupportLevelToReadinessState(support.supportLevel),
            inventory,
            modelId,
            capabilities,
            supportLevel: support.supportLevel,
            missing: support.diagnostics,
            diagnostics: appendDiagnostics(inventory.diagnostics, support.diagnostics),
          });
        }
      }

      const runtimeStoreReadiness = await this.runtimeStores.check({
        projectPath: input.projectPath,
      });
      if (!runtimeStoreReadiness.ok) {
        return readiness({
          state: 'runtime_store_blocked',
          inventory,
          modelId,
          capabilities,
          runtimeStoreReadiness,
          supportLevel: support.supportLevel,
          missing: runtimeStoreReadiness.diagnostics,
          diagnostics: appendDiagnostics(inventory.diagnostics, runtimeStoreReadiness.diagnostics),
        });
      }

      const toolProof = await this.mcpTools.prove({
        projectPath: input.projectPath,
        modelId,
        inventory,
        capabilities,
      });
      if (!toolProof.ok) {
        return readiness({
          state: 'mcp_unavailable',
          inventory,
          modelId,
          capabilities,
          toolProof,
          runtimeStoreReadiness,
          supportLevel: support.supportLevel,
          missing: toolProof.missingTools,
          diagnostics: appendDiagnostics(inventory.diagnostics, toolProof.diagnostics),
        });
      }

      if (input.requireExecutionProbe) {
        const modelProbe = await this.modelExecution.verify({
          projectPath: input.projectPath,
          modelId,
          inventory,
        });
        if (modelProbe.outcome !== 'available') {
          return readiness({
            state: 'model_unavailable',
            inventory,
            modelId,
            capabilities,
            toolProof,
            runtimeStoreReadiness,
            supportLevel: support.supportLevel,
            missing: [modelProbe.reason ?? 'OpenCode selected model execution is unavailable'],
            diagnostics: appendDiagnostics(inventory.diagnostics, modelProbe.diagnostics),
          });
        }
      }

      return readiness({
        state: 'ready',
        inventory,
        modelId,
        capabilities,
        toolProof,
        runtimeStoreReadiness,
        supportLevel: support.supportLevel,
        launchAllowed: true,
        diagnostics: appendDiagnostics(inventory.diagnostics, dogfoodWarnings),
      });
    } catch (error) {
      return readiness({
        state: 'unknown_error',
        inventory: null,
        modelId: input.selectedModel,
        diagnostics: [`OpenCode readiness check failed: ${stringifyError(error)}`],
      });
    }
  }
}

function resolveReadinessLaunchMode(
  requested: OpenCodeTeamLaunchMode | undefined,
  options: OpenCodeTeamLaunchReadinessServiceOptions
): OpenCodeTeamLaunchMode {
  if (requested) {
    return requested;
  }
  if (options.launchMode) {
    return options.launchMode;
  }
  if (options.adapterEnabled === true) {
    return 'production';
  }
  return 'disabled';
}

function readiness(input: {
  state: OpenCodeTeamLaunchReadinessState;
  inventory: OpenCodeRuntimeInventory | null;
  modelId: string | null;
  capabilities?: OpenCodeApiCapabilities;
  toolProof?: OpenCodeMcpToolProof;
  runtimeStoreReadiness?: RuntimeStoreReadinessCheck;
  supportLevel?: OpenCodeSupportLevel | null;
  launchAllowed?: boolean;
  missing?: string[];
  diagnostics: string[];
}): OpenCodeTeamLaunchReadiness {
  const toolProof = input.toolProof ?? null;
  const capabilitiesReady = input.capabilities?.requiredForTeamLaunch.ready === true;

  return {
    state: input.state,
    launchAllowed: input.launchAllowed === true,
    modelId: input.modelId,
    availableModels: input.inventory?.models ?? [],
    opencodeVersion: input.inventory?.version ?? null,
    installMethod: input.inventory?.installMethod ?? null,
    binaryPath: input.inventory?.binaryPath ?? null,
    hostHealthy: input.inventory?.detected === true,
    appMcpConnected: toolProof !== null,
    requiredToolsPresent: toolProof?.ok === true,
    permissionBridgeReady:
      input.capabilities?.endpoints.permissionList === true &&
      (input.capabilities.endpoints.permissionReply === true ||
        input.capabilities.endpoints.permissionLegacySessionRespond === true),
    runtimeStoresReady: input.runtimeStoreReadiness?.ok === true,
    supportLevel: input.supportLevel ?? null,
    missing: dedupe(input.missing ?? []),
    diagnostics: dedupe(input.diagnostics),
    evidence: {
      capabilitiesReady,
      mcpToolProofRoute: toolProof?.route ?? null,
      observedMcpTools: toolProof?.observedTools ?? [],
      runtimeStoreReadinessReason: input.runtimeStoreReadiness?.reason ?? null,
    },
  };
}

function mapSupportLevelToReadinessState(
  supportLevel: OpenCodeSupportLevel
): OpenCodeTeamLaunchReadinessState {
  switch (supportLevel) {
    case 'unsupported_too_old':
    case 'unsupported_prerelease':
      return 'unsupported_version';
    case 'supported_capabilities_pending':
      return 'capabilities_missing';
    case 'supported_e2e_pending':
      return 'e2e_missing';
    case 'production_supported':
      return 'ready';
  }
}

function appendDiagnostics(left: string[], right: string[]): string[] {
  return dedupe([...left, ...right]);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
