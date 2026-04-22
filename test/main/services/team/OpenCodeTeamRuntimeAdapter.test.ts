import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
  type TeamRuntimeLaunchInput,
} from '../../../../src/main/services/team/runtime';

import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { OpenCodeLaunchTeamCommandData } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { PersistedTeamLaunchSnapshot } from '../../../../src/shared/types';

describe('OpenCodeTeamRuntimeAdapter', () => {
  it('maps readiness failures to a structured prepare block', async () => {
    const bridge = bridgePort(
      readiness({
        state: 'mcp_unavailable',
        launchAllowed: false,
        missing: ['runtime_deliver_message'],
        diagnostics: ['OpenCode missing canonical app MCP tool id'],
      })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, { launchMode: 'production' });

    await expect(adapter.prepare(launchInput())).resolves.toEqual({
      ok: false,
      providerId: 'opencode',
      reason: 'mcp_unavailable',
      retryable: true,
      diagnostics: ['OpenCode missing canonical app MCP tool id', 'runtime_deliver_message'],
      warnings: [],
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: '/repo',
      selectedModel: 'openai/gpt-5.4-mini',
      requireExecutionProbe: true,
      launchMode: 'production',
    });
  });

  it('uses runtime-only readiness for model-less preflight checks', async () => {
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true, modelId: null }));
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, { launchMode: 'production' });

    await expect(adapter.prepare(launchInput({ model: undefined, runtimeOnly: true }))).resolves
      .toMatchObject({
        ok: true,
        providerId: 'opencode',
        modelId: null,
      });

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: '/repo',
      selectedModel: null,
      requireExecutionProbe: false,
      launchMode: undefined,
    });
  });

  it('fails closed when launch mode is disabled', async () => {
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridge
    );

    await expect(adapter.prepare(launchInput())).resolves.toMatchObject({
      ok: false,
      providerId: 'opencode',
      reason: 'opencode_team_launch_disabled',
      retryable: false,
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
  });

  it('maps ready bridge launch data to successful runtime evidence only with required checkpoints', async () => {
    const launchOpenCodeTeam = vi.fn(async () => ({
      runId: 'run-1',
      teamLaunchState: 'ready',
      members: {
        alice: {
          sessionId: 'oc-session-1',
          launchState: 'confirmed_alive',
          model: 'openai/gpt-5.4-mini',
          evidence: [
            { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'member_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
          ],
        },
      },
      warnings: [],
      diagnostics: [],
    }) satisfies OpenCodeLaunchTeamCommandData);
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => ({
          providerId: 'opencode' as const,
          binaryPath: '/opt/homebrew/bin/opencode',
          binaryFingerprint: 'version:1.14.19',
          version: '1.14.19',
          capabilitySnapshotId: 'cap-1',
        })),
        launchOpenCodeTeam,
      }),
      { launchMode: 'dogfood' }
    );

    await expect(adapter.launch(launchInput())).resolves.toMatchObject({
      runId: 'run-1',
      teamName: 'team-a',
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {
        alice: {
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          sessionId: 'oc-session-1',
          hardFailure: false,
        },
      },
    });
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCapabilitySnapshotId: 'cap-1',
        manifestHighWatermark: null,
      })
    );
  });

  it('reconciles from existing persisted launch snapshot without treating OpenCode as truth', async () => {
    const snapshot = launchSnapshot();
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'adapter_disabled', launchAllowed: false }))
    );

    await expect(
      adapter.reconcile({
        runId: 'run-1',
        teamName: 'team-a',
        providerId: 'opencode',
        expectedMembers: launchInput().expectedMembers,
        previousLaunchState: snapshot,
        reason: 'startup_recovery',
      })
    ).resolves.toMatchObject({
      runId: 'run-1',
      teamName: 'team-a',
      launchPhase: 'active',
      teamLaunchState: 'partial_pending',
      members: {
        alice: {
          providerId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          bootstrapConfirmed: false,
        },
      },
      snapshot,
    });
  });

  it('acknowledges stop without mutating live OpenCode ownership in the adapter shell', async () => {
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'adapter_disabled', launchAllowed: false }))
    );

    await expect(
      adapter.stop({
        runId: 'run-1',
        teamName: 'team-a',
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState: launchSnapshot(),
      })
    ).resolves.toMatchObject({
      stopped: true,
      members: {
        alice: {
          providerId: 'opencode',
          stopped: true,
        },
      },
    });
  });
});

function bridgePort(
  readinessResult: OpenCodeTeamLaunchReadiness,
  overrides: Partial<OpenCodeTeamRuntimeBridgePort> = {}
): OpenCodeTeamRuntimeBridgePort {
  return {
    checkOpenCodeTeamLaunchReadiness: vi.fn(async () => readinessResult),
    ...overrides,
  };
}

function launchInput(overrides: Partial<TeamRuntimeLaunchInput> = {}): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    cwd: '/repo',
    providerId: 'opencode',
    model: 'openai/gpt-5.4-mini',
    skipPermissions: false,
    expectedMembers: [
      {
        name: 'alice',
        providerId: 'opencode',
        model: 'openai/gpt-5.4-mini',
        cwd: '/repo',
      },
    ],
    previousLaunchState: null,
    ...overrides,
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
      observedMcpTools: ['agent-teams_runtime_deliver_message'],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
    ...overrides,
  };
}

function launchSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: '2026-04-21T00:00:00.000Z',
    launchPhase: 'active',
    expectedMembers: ['alice'],
    teamLaunchState: 'partial_pending',
    summary: {
      confirmedCount: 0,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
    },
    members: {
      alice: {
        name: 'alice',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: '2026-04-21T00:00:00.000Z',
        diagnostics: ['waiting for teammate check-in'],
      },
    },
  };
}
