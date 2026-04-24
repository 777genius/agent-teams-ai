import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeReadinessBridge,
  type OpenCodeReadinessBridgeCommandExecutor,
  type OpenCodeProductionE2EEvidenceReadPort,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
  buildOpenCodeProjectPathFingerprint,
  type OpenCodeProductionE2EEvidence,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import {
  REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeBridgeFailureKind,
  OpenCodeBridgeCommandName,
  OpenCodeBridgeResult,
  OpenCodeBridgeSuccess,
  OpenCodeLaunchTeamCommandData,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

describe('OpenCodeReadinessBridge', () => {
  it('executes the read-only opencode.readiness command and returns readiness data', async () => {
    const readinessResult = readiness({ state: 'ready', launchAllowed: true });
    const executor = fakeExecutor(bridgeSuccess(readinessResult));
    const bridge = new OpenCodeReadinessBridge(executor, { timeoutMs: 15_000 });

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
      })
    ).resolves.toBe(readinessResult);

    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.readiness',
      {
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
      },
      {
        cwd: '/repo',
        timeoutMs: 15_000,
      }
    );
    expect(bridge.getLastOpenCodeRuntimeSnapshot('/repo')).toMatchObject({
      capabilitySnapshotId: 'cap-1',
      version: '1.14.19',
    });
  });

  it('maps bridge failures into fail-closed readiness', async () => {
    const executor = fakeExecutor(
      bridgeFailure('timeout', 'OpenCode readiness command timed out', [
        {
          id: 'diag-1',
          type: 'opencode_bridge_unknown_outcome',
          providerId: 'opencode',
          severity: 'warning',
          message: 'timed out',
          createdAt: '2026-04-21T12:00:00.000Z',
        },
      ])
    );
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: false,
      })
    ).resolves.toMatchObject({
      state: 'unknown_error',
      launchAllowed: false,
      modelId: 'openai/gpt-5.4-mini',
      hostHealthy: false,
      requiredToolsPresent: false,
      missing: ['OpenCode readiness command timed out'],
      diagnostics: [
        'OpenCode readiness bridge failed: timeout: OpenCode readiness command timed out',
        'opencode_bridge_unknown_outcome: timed out',
      ],
    });
    expect(bridge.getLastOpenCodeRuntimeSnapshot('/repo')).toBeNull();
  });

  it('blocks production readiness when strict production E2E evidence is missing', async () => {
    const executor = fakeExecutor(
      bridgeSuccess(readiness({ state: 'ready', launchAllowed: true }))
    );
    const evidence = fakeEvidenceStore(null);
    const bridge = new OpenCodeReadinessBridge(executor, { productionE2eEvidence: evidence });

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
        launchMode: 'production',
      })
    ).resolves.toMatchObject({
      state: 'e2e_missing',
      launchAllowed: false,
      supportLevel: 'supported_e2e_pending',
      missing: ['OpenCode production launch requires a current production E2E evidence artifact'],
      diagnostics: [
        'OpenCode production launch requires a current production E2E evidence artifact',
      ],
    });
    expect(evidence.read).toHaveBeenCalledOnce();
  });

  it('allows dogfood readiness while surfacing missing production E2E evidence diagnostics', async () => {
    const executor = fakeExecutor(
      bridgeSuccess(readiness({ state: 'ready', launchAllowed: true }))
    );
    const bridge = new OpenCodeReadinessBridge(executor, {
      productionE2eEvidence: fakeEvidenceStore(null),
    });

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
        launchMode: 'dogfood',
      })
    ).resolves.toMatchObject({
      state: 'ready',
      launchAllowed: true,
      supportLevel: 'supported_e2e_pending',
      diagnostics: [
        'OpenCode production launch requires a current production E2E evidence artifact',
      ],
    });
  });

  it('keeps production readiness open when evidence matches runtime identity and project context', async () => {
    const executor = fakeExecutor(
      bridgeSuccess(readiness({ state: 'ready', launchAllowed: true }))
    );
    const evidence = fakeEvidenceStore(productionEvidence());
    const bridge = new OpenCodeReadinessBridge(executor, {
      productionE2eEvidence: evidence,
    });

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
        launchMode: 'production',
      })
    ).resolves.toMatchObject({
      state: 'ready',
      launchAllowed: true,
      supportLevel: 'production_supported',
      diagnostics: [],
    });
    expect(evidence.read).toHaveBeenCalledWith({
      selectedModel: 'openai/gpt-5.4-mini',
      projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo'),
      opencodeVersion: '1.14.19',
      binaryFingerprint: 'bin-1',
      capabilitySnapshotId: 'cap-1',
    });
  });

  it('accepts production evidence recorded with a different OpenCode model when runtime identity matches', async () => {
    const executor = fakeExecutor(
      bridgeSuccess(readiness({ state: 'ready', launchAllowed: true }))
    );
    const evidence = fakeEvidenceStore(
      productionEvidence({ selectedModel: 'opencode/minimax-m2.5-free' })
    );
    const bridge = new OpenCodeReadinessBridge(executor, {
      productionE2eEvidence: evidence,
    });

    await expect(
      bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: '/repo',
        selectedModel: 'opencode/nemotron-3-super-free',
        requireExecutionProbe: true,
        launchMode: 'production',
      })
    ).resolves.toMatchObject({
      state: 'ready',
      launchAllowed: true,
      supportLevel: 'production_supported',
      diagnostics: [],
    });
  });

  it('routes state-changing launch commands through the guarded command service when configured', async () => {
    const executor = fakeExecutor(
      bridgeFailure('internal_error', 'direct bridge must not run', [])
    );
    const stateChangingExecute = vi.fn();
    const stateChangingCommands = {
      async execute<TBody, TData>(input: {
        command: OpenCodeBridgeCommandName;
        body: TBody;
      }): Promise<OpenCodeBridgeResult<TData>> {
        stateChangingExecute(input);
        return bridgeCommandSuccess<OpenCodeLaunchTeamCommandData>({
          command: input.command,
          requestId: 'guarded-req-1',
          data: {
            runId: 'run-1',
            teamLaunchState: 'ready',
            members: {},
            warnings: [],
            diagnostics: [],
            idempotencyKey: 'idem-1',
            runtimeStoreManifestHighWatermark: 0,
          },
        }) as unknown as OpenCodeBridgeResult<TData>;
      },
    };
    const bridge = new OpenCodeReadinessBridge(executor, { stateChangingCommands });

    await expect(
      bridge.launchOpenCodeTeam({
        mode: 'dogfood',
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/repo',
        selectedModel: 'openai/gpt-5.4-mini',
        members: [],
        leadPrompt: '',
        expectedCapabilitySnapshotId: 'cap-1',
        manifestHighWatermark: 0,
      })
    ).resolves.toMatchObject({
      runId: 'run-1',
      teamLaunchState: 'ready',
      idempotencyKey: 'idem-1',
    });

    expect(stateChangingExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'opencode.launchTeam',
        teamName: 'team-a',
        laneId: 'primary',
        runId: 'run-1',
        capabilitySnapshotId: 'cap-1',
        cwd: '/repo',
      })
    );
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

function fakeExecutor(
  result: OpenCodeBridgeResult<unknown>
): OpenCodeReadinessBridgeCommandExecutor {
  return {
    execute: vi.fn(async () => result) as OpenCodeReadinessBridgeCommandExecutor['execute'],
  };
}

function fakeEvidenceStore(
  evidence: OpenCodeProductionE2EEvidence | null
): OpenCodeProductionE2EEvidenceReadPort & { read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async () => ({
      ok: true,
      evidence,
      artifactPath: '/tmp/opencode-production-e2e.json',
      diagnostics: [],
    })),
  };
}

function bridgeSuccess(
  data: OpenCodeTeamLaunchReadiness
): OpenCodeBridgeSuccess<OpenCodeTeamLaunchReadiness> {
  return {
    ok: true,
    schemaVersion: 1,
    requestId: 'req-1',
    command: 'opencode.readiness',
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    runtime: {
      providerId: 'opencode',
      binaryPath: '/opt/homebrew/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.14.19',
      capabilitySnapshotId: 'cap-1',
    },
    diagnostics: [],
    data,
  };
}

function bridgeFailure(
  kind: OpenCodeBridgeFailureKind,
  message: string,
  diagnostics: OpenCodeBridgeResult<unknown>['diagnostics']
): OpenCodeBridgeResult<unknown> {
  return {
    ok: false,
    schemaVersion: 1,
    requestId: 'req-1',
    command: 'opencode.readiness',
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    error: {
      kind,
      message,
      retryable: true,
    },
    diagnostics,
  };
}

function bridgeCommandSuccess<TData>(input: {
  command: OpenCodeBridgeCommandName;
  requestId: string;
  data: TData;
}): OpenCodeBridgeSuccess<TData> {
  return {
    ok: true,
    schemaVersion: 1,
    requestId: input.requestId,
    command: input.command,
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    runtime: {
      providerId: 'opencode',
      binaryPath: '/opt/homebrew/bin/opencode',
      binaryFingerprint: 'bin-1',
      version: '1.14.19',
      capabilitySnapshotId: 'cap-1',
    },
    diagnostics: [],
    data: input.data,
  };
}

function readiness(
  overrides: Partial<OpenCodeTeamLaunchReadiness> = {}
): OpenCodeTeamLaunchReadiness {
  return {
    state: 'adapter_disabled',
    launchAllowed: false,
    modelId: 'openai/gpt-5.4-mini',
    availableModels: ['openai/gpt-5.4-mini'],
    opencodeVersion: '1.14.19',
    installMethod: 'brew',
    binaryPath: '/opt/homebrew/bin/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'production_supported',
    missing: [],
    diagnostics: [],
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: '/experimental/tool/ids',
      observedMcpTools: [...REQUIRED_AGENT_TEAMS_APP_TOOL_IDS],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
    ...overrides,
  };
}

function productionEvidence(
  overrides: Partial<OpenCodeProductionE2EEvidence> = {}
): OpenCodeProductionE2EEvidence {
  const createdAt = new Date().toISOString();
  const sessionId = 'session-1';
  const requiredToolIds = REQUIRED_AGENT_TEAMS_APP_TOOL_IDS;
  return {
    schemaVersion: 1,
    evidenceId: 'e2e-1',
    createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    version: '1.14.19',
    passed: true,
    artifactPath: '/tmp/opencode-production-e2e.json',
    binaryFingerprint: 'bin-1',
    capabilitySnapshotId: 'cap-1',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo'),
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
    ...overrides,
  };
}
