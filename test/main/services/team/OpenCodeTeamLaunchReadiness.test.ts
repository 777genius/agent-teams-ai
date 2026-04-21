import { describe, expect, it, vi } from 'vitest';

import { createEmptyEndpointMap } from '../../../../src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities';
import {
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import { REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import {
  OpenCodeTeamLaunchReadinessService,
  type OpenCodeApiCapabilityPort,
  type OpenCodeModelExecutionProbePort,
  type OpenCodeMcpToolProofPort,
  type OpenCodeProductionE2EEvidencePort,
  type OpenCodeRuntimeInventory,
  type OpenCodeRuntimeInventoryPort,
  type OpenCodeRuntimeStoreReadinessPort,
} from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';

import type {
  OpenCodeApiCapabilities,
  OpenCodeApiEndpointKey,
} from '../../../../src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities';
import type { OpenCodeMcpToolProof } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import type { RuntimeStoreReadinessCheck } from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';
import type { OpenCodeProductionE2EEvidence } from '../../../../src/main/services/team/opencode/version/OpenCodeVersionPolicy';

describe('OpenCodeTeamLaunchReadinessService', () => {
  it('returns not_installed before probing deeper runtime dependencies', async () => {
    const ports = createPorts({
      inventory: { detected: false, diagnostics: ['PATH checked'] },
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'not_installed',
      launchAllowed: false,
      hostHealthy: false,
      diagnostics: ['PATH checked', 'OpenCode CLI not detected on PATH'],
    });
    expect(ports.capabilities.detect).not.toHaveBeenCalled();
    expect(ports.mcpTools.prove).not.toHaveBeenCalled();
  });

  it('blocks unauthenticated OpenCode even when the binary is installed', async () => {
    const ports = createPorts({
      inventory: { authenticated: false, connectedProviders: [] },
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'not_authenticated',
      launchAllowed: false,
      opencodeVersion: '1.14.19',
      diagnostics: ['No connected OpenCode providers found'],
    });
  });

  it('blocks unsupported versions before MCP and model probes', async () => {
    const ports = createPorts({
      inventory: { version: '1.4.0' },
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'unsupported_version',
      launchAllowed: false,
      supportLevel: 'unsupported_too_old',
      missing: ['OpenCode 1.4.0 is below supported minimum 1.14.19'],
    });
    expect(ports.mcpTools.prove).not.toHaveBeenCalled();
  });

  it('blocks when API capabilities are missing required permission or tool routes', async () => {
    const ports = createPorts({
      capabilities: capabilities({ ready: false, missing: ['POST permission reply route'] }),
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'capabilities_missing',
      launchAllowed: false,
      permissionBridgeReady: false,
      missing: ['POST permission reply route'],
      evidence: {
        capabilitiesReady: false,
      },
    });
  });

  it('blocks capability-compatible versions until production E2E evidence exists', async () => {
    const ports = createPorts({
      evidence: null,
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'e2e_missing',
      launchAllowed: false,
      supportLevel: 'supported_e2e_pending',
      missing: ['OpenCode version is capability-compatible but production E2E evidence is missing'],
    });
  });

  it('blocks when runtime stores need recovery before readiness', async () => {
    const ports = createPorts({
      runtimeStores: {
        ok: false,
        reason: 'runtime_store_recovery_required',
        diagnostics: ['Incomplete batch must be reconciled before readiness'],
      },
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'runtime_store_blocked',
      launchAllowed: false,
      runtimeStoresReady: false,
      missing: ['Incomplete batch must be reconciled before readiness'],
      evidence: {
        runtimeStoreReadinessReason: 'runtime_store_recovery_required',
      },
    });
  });

  it('blocks when required app MCP tools are not proven through OpenCode', async () => {
    const ports = createPorts({
      toolProof: toolProof({
        ok: false,
        missingTools: ['runtime_deliver_message'],
        diagnostics: [
          'OpenCode missing canonical app MCP tool id agent-teams_runtime_deliver_message',
        ],
      }),
    });

    await expect(service(ports).check(readinessInput())).resolves.toMatchObject({
      state: 'mcp_unavailable',
      launchAllowed: false,
      appMcpConnected: true,
      requiredToolsPresent: false,
      missing: ['runtime_deliver_message'],
      diagnostics: [
        'OpenCode missing canonical app MCP tool id agent-teams_runtime_deliver_message',
      ],
    });
  });

  it('runs optional execution probe and blocks unavailable selected model', async () => {
    const ports = createPorts({
      modelProbe: {
        outcome: 'unavailable',
        reason: 'model rejected by provider',
        diagnostics: ['model rejected by provider'],
      },
    });

    await expect(
      service(ports).check(readinessInput({ requireExecutionProbe: true }))
    ).resolves.toMatchObject({
      state: 'model_unavailable',
      launchAllowed: false,
      modelId: 'openai/gpt-5.4-mini',
      missing: ['model rejected by provider'],
    });
  });

  it('fails closed behind adapter feature gate after all runtime evidence is healthy', async () => {
    const ports = createPorts();

    await expect(
      service(ports, { adapterEnabled: false }).check(readinessInput())
    ).resolves.toMatchObject({
      state: 'adapter_disabled',
      launchAllowed: false,
      missing: ['OpenCode team launch adapter is disabled by feature gate'],
    });
    expect(ports.inventory.probe).not.toHaveBeenCalled();
  });

  it('allows dogfood launch to continue without production E2E evidence after runtime checks pass', async () => {
    const ports = createPorts({ evidence: null });

    await expect(
      service(ports, { launchMode: 'dogfood' }).check(
        readinessInput({ requireExecutionProbe: true })
      )
    ).resolves.toMatchObject({
      state: 'ready',
      launchAllowed: true,
      supportLevel: 'supported_e2e_pending',
      requiredToolsPresent: true,
      runtimeStoresReady: true,
      diagnostics: [
        'OpenCode production E2E evidence is missing; dogfood launch remains allowed after runtime checks.',
      ],
    });
    expect(ports.mcpTools.prove).toHaveBeenCalled();
    expect(ports.modelExecution.verify).toHaveBeenCalled();
  });

  it('allows launch only when inventory, capabilities, E2E, stores, MCP and model probe are healthy', async () => {
    const ports = createPorts();

    await expect(
      service(ports, { adapterEnabled: true }).check(readinessInput())
    ).resolves.toMatchObject({
      state: 'ready',
      launchAllowed: true,
      modelId: 'openai/gpt-5.4-mini',
      opencodeVersion: '1.14.19',
      hostHealthy: true,
      appMcpConnected: true,
      requiredToolsPresent: true,
      permissionBridgeReady: true,
      runtimeStoresReady: true,
      supportLevel: 'production_supported',
      evidence: {
        capabilitiesReady: true,
        mcpToolProofRoute: '/experimental/tool/ids',
        runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
      },
    });
  });
});

function service(
  ports: ReturnType<typeof createPorts>,
  options: { adapterEnabled?: boolean; launchMode?: 'disabled' | 'dogfood' | 'production' } = {}
): OpenCodeTeamLaunchReadinessService {
  return new OpenCodeTeamLaunchReadinessService(
    ports.inventory,
    ports.capabilities,
    ports.mcpTools,
    ports.runtimeStores,
    ports.modelExecution,
    ports.e2eEvidence,
    options.launchMode
      ? { launchMode: options.launchMode }
      : { adapterEnabled: options.adapterEnabled ?? true }
  );
}

function readinessInput(
  overrides: Partial<{
    projectPath: string;
    selectedModel: string | null;
    requireExecutionProbe: boolean;
  }> = {}
) {
  return {
    projectPath: '/repo',
    selectedModel: 'openai/gpt-5.4-mini',
    requireExecutionProbe: false,
    ...overrides,
  };
}

function createPorts(
  overrides: {
    inventory?: Partial<OpenCodeRuntimeInventory>;
    capabilities?: OpenCodeApiCapabilities;
    toolProof?: OpenCodeMcpToolProof;
    runtimeStores?: RuntimeStoreReadinessCheck;
    modelProbe?: {
      outcome: 'available' | 'unavailable' | 'unknown';
      reason: string | null;
      diagnostics: string[];
    };
    evidence?: OpenCodeProductionE2EEvidence | null;
  } = {}
): {
  inventory: OpenCodeRuntimeInventoryPort & { probe: ReturnType<typeof vi.fn> };
  capabilities: OpenCodeApiCapabilityPort & { detect: ReturnType<typeof vi.fn> };
  mcpTools: OpenCodeMcpToolProofPort & { prove: ReturnType<typeof vi.fn> };
  runtimeStores: OpenCodeRuntimeStoreReadinessPort & { check: ReturnType<typeof vi.fn> };
  modelExecution: OpenCodeModelExecutionProbePort & { verify: ReturnType<typeof vi.fn> };
  e2eEvidence: OpenCodeProductionE2EEvidencePort & { read: ReturnType<typeof vi.fn> };
} {
  return {
    inventory: {
      probe: vi.fn(async () => inventory(overrides.inventory)),
    },
    capabilities: {
      detect: vi.fn(async () => overrides.capabilities ?? capabilities()),
    },
    mcpTools: {
      prove: vi.fn(async () => overrides.toolProof ?? toolProof()),
    },
    runtimeStores: {
      check: vi.fn(async () => overrides.runtimeStores ?? runtimeStores()),
    },
    modelExecution: {
      verify: vi.fn(async () => overrides.modelProbe ?? modelProbe()),
    },
    e2eEvidence: {
      read: vi.fn(async () => (overrides.evidence === undefined ? evidence() : overrides.evidence)),
    },
  };
}

function inventory(overrides: Partial<OpenCodeRuntimeInventory> = {}): OpenCodeRuntimeInventory {
  return {
    detected: true,
    binaryPath: '/opt/homebrew/bin/opencode',
    installMethod: 'brew',
    version: '1.14.19',
    authenticated: true,
    connectedProviders: ['openai'],
    models: ['openai/gpt-5.4-mini'],
    diagnostics: [],
    ...overrides,
  };
}

function capabilities(
  overrides: Partial<{
    ready: boolean;
    missing: string[];
  }> = {}
): OpenCodeApiCapabilities {
  const endpoints = createEmptyEndpointMap();
  const evidence = {} as OpenCodeApiCapabilities['evidence'];
  for (const key of Object.keys(endpoints) as OpenCodeApiEndpointKey[]) {
    endpoints[key] = true;
    evidence[key] = 'openapi';
  }
  if (overrides.ready === false) {
    endpoints.permissionReply = false;
    endpoints.permissionLegacySessionRespond = false;
  }

  return {
    version: '1.14.19',
    source: 'openapi_doc',
    endpoints,
    requiredForTeamLaunch: {
      ready: overrides.ready ?? true,
      missing: overrides.missing ?? [],
    },
    evidence,
    diagnostics: [],
  };
}

function toolProof(overrides: Partial<OpenCodeMcpToolProof> = {}): OpenCodeMcpToolProof {
  return {
    ok: true,
    route: '/experimental/tool/ids',
    canonicalServerName: 'agent_teams',
    canonicalExpectedIds: Object.fromEntries(
      REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => [tool, `agent_teams_${tool}`])
    ),
    observedTools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => `agent_teams_${tool}`),
    missingTools: [],
    matchedByRequiredTool: Object.fromEntries(
      REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => [tool, `agent_teams_${tool}`])
    ),
    aliasMatchedByRequiredTool: Object.fromEntries(
      REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => [tool, null])
    ),
    diagnostics: [],
    ...overrides,
  };
}

function runtimeStores(): RuntimeStoreReadinessCheck {
  return {
    ok: true,
    reason: 'runtime_store_manifest_valid',
    diagnostics: [],
  };
}

function modelProbe() {
  return {
    outcome: 'available' as const,
    reason: null,
    diagnostics: [],
  };
}

function evidence(): OpenCodeProductionE2EEvidence {
  const createdAt = new Date().toISOString();
  const sessionId = 'session-1';
  const requiredToolIds = REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) => `agent_teams_${tool}`);
  return {
    schemaVersion: 1,
    evidenceId: 'e2e-1',
    createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    version: '1.14.19',
    passed: true,
    artifactPath: '/tmp/opencode-e2e',
    binaryFingerprint: 'version:1.14.19',
    capabilitySnapshotId: 'cap-1',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPathFingerprint: 'project-a',
    requiredSignals: Object.fromEntries(
      OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.map((signal) => [signal, true])
    ) as OpenCodeProductionE2EEvidence['requiredSignals'],
    mcpTools: {
      requiredTools: requiredToolIds,
      observedTools: requiredToolIds,
    },
    launch: {
      runId: 'run-1',
      teamId: 'team-a',
      teamLaunchState: 'ready',
      memberCount: 1,
      sessions: [
        {
          memberName: 'Dev',
          sessionId,
          launchState: 'confirmed_alive',
        },
      ],
      durableCheckpoints: OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS.map((name) => ({
        name,
        observedAt: createdAt,
      })),
    },
    reconcile: {
      runId: 'run-1',
      teamLaunchState: 'ready',
      memberCount: 1,
    },
    stop: {
      runId: 'run-1',
      stopped: true,
      stoppedSessionIds: [sessionId],
    },
    logProjection: {
      observed: true,
      projectedMessageCount: 1,
    },
  };
}
