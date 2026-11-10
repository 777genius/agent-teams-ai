import type {
  OpenCodeTeamLaunchReadiness,
  OpenCodeTeamLaunchReadinessState,
} from '../readiness/OpenCodeTeamLaunchReadiness';
import type { OpenCodeBridgeFailureKind } from './OpenCodeBridgeCommandContract';

export function blockedReadiness(input: {
  state: OpenCodeTeamLaunchReadinessState;
  modelId: string | null;
  diagnostics: string[];
  missing: string[];
  supportDiagnostics?: OpenCodeTeamLaunchReadiness['supportDiagnostics'];
}): OpenCodeTeamLaunchReadiness {
  const dedupe = (values: string[]): string[] => [
    ...new Set(values.filter((value) => value.trim().length > 0)),
  ];
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

export function mapBridgeFailureToReadinessState(
  kind: OpenCodeBridgeFailureKind
): OpenCodeTeamLaunchReadinessState {
  return kind === 'runtime_not_ready' ? 'adapter_disabled' : 'unknown_error';
}
