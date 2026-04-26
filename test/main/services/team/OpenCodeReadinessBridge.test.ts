import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeReadinessBridge,
  type OpenCodeReadinessBridgeCommandExecutor,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
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

  it('executes host cleanup through the direct bridge command', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess({
        command: 'opencode.cleanupHosts',
        requestId: 'cleanup-req-1',
        data: {
          cleaned: 1,
          remaining: 0,
          hosts: [
            {
              hostKey: 'host-key',
              projectPath: '/repo',
              pid: 123,
              port: 43116,
              action: 'disposed',
              reason: 'stale host has no active leases during startup',
              leaseCount: 0,
            },
          ],
          diagnostics: [],
        },
      })
    );
    const bridge = new OpenCodeReadinessBridge(executor, { cleanupTimeoutMs: 5_000 });

    await expect(
      bridge.cleanupOpenCodeHosts({
        reason: 'startup',
        mode: 'stale',
        projectPath: '/repo',
        staleAgeMs: 1_000,
      })
    ).resolves.toMatchObject({
      cleaned: 1,
      remaining: 0,
    });

    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.cleanupHosts',
      {
        reason: 'startup',
        mode: 'stale',
        projectPath: '/repo',
        staleAgeMs: 1_000,
      },
      {
        cwd: '/repo',
        timeoutMs: 5_000,
      }
    );
  });

  it('executes OpenCode task ledger backfill through a direct read-only bridge command', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess({
        command: 'opencode.backfillTaskLedger',
        requestId: 'backfill-req-1',
        data: {
          schemaVersion: 1,
          providerId: 'opencode',
          teamName: 'team-a',
          taskId: 'task-1',
          projectDir: '/claude/project',
          workspaceRoot: '/repo',
          dryRun: false,
          scannedSessions: 1,
          scannedToolparts: 2,
          candidateEvents: 2,
          importedEvents: 2,
          skippedEvents: 0,
          outcome: 'imported',
          notices: [],
          diagnostics: [],
        },
      })
    );
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.backfillOpenCodeTaskLedger({
        teamName: 'team-a',
        taskId: 'task-1',
        taskDisplayId: 'abc12345',
        projectDir: '/claude/project',
        workspaceRoot: '/repo',
      })
    ).resolves.toMatchObject({
      outcome: 'imported',
      importedEvents: 2,
    });

    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.backfillTaskLedger',
      {
        teamName: 'team-a',
        taskId: 'task-1',
        taskDisplayId: 'abc12345',
        projectDir: '/claude/project',
        workspaceRoot: '/repo',
      },
      {
        cwd: '/repo',
        timeoutMs: 45_000,
        stdoutLimitBytes: 2_000_000,
        stderrLimitBytes: 512_000,
      }
    );
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
