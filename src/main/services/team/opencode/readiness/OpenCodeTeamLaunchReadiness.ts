import {
  evaluateOpenCodeSupport,
  OPENCODE_TEAM_LAUNCH_VERSION_POLICY,
  type OpenCodeInstallMethod,
  type OpenCodeSupportedVersionPolicy,
  type OpenCodeSupportLevel,
} from '../version/OpenCodeVersionPolicy';

import type { OpenCodeApiCapabilities } from '../capabilities/OpenCodeApiCapabilities';
import type { OpenCodeMcpToolProof } from '../mcp/OpenCodeMcpToolAvailability';
import type { RuntimeStoreReadinessCheck } from '../store/RuntimeStoreManifest';

export type OpenCodeTeamLaunchReadinessState =
  | 'ready'
  | 'not_installed'
  | 'not_authenticated'
  | 'unsupported_version'
  | 'capabilities_missing'
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

export interface OpenCodeTeamLaunchReadinessServiceOptions {
  versionPolicy?: OpenCodeSupportedVersionPolicy;
}

export class OpenCodeTeamLaunchReadinessService {
  constructor(
    private readonly inventory: OpenCodeRuntimeInventoryPort,
    private readonly capabilities: OpenCodeApiCapabilityPort,
    private readonly mcpTools: OpenCodeMcpToolProofPort,
    private readonly runtimeStores: OpenCodeRuntimeStoreReadinessPort,
    private readonly modelExecution: OpenCodeModelExecutionProbePort,
    private readonly options: OpenCodeTeamLaunchReadinessServiceOptions = {}
  ) {}

  async check(input: {
    projectPath: string;
    selectedModel: string | null;
    requireExecutionProbe: boolean;
  }): Promise<OpenCodeTeamLaunchReadiness> {
    const policy = this.options.versionPolicy ?? OPENCODE_TEAM_LAUNCH_VERSION_POLICY;

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
      const support = evaluateOpenCodeSupport({
        version: inventory.version ?? '0.0.0',
        capabilities,
        policy,
      });

      if (!support.supported) {
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
        diagnostics: inventory.diagnostics,
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
