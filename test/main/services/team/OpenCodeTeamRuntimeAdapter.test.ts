import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { stableHash } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
  type TeamRuntimeLaunchInput,
} from '../../../../src/main/services/team/runtime';
import orchestratorVector from '../../../fixtures/team/opencode-launch-request-correlation-golden.json';

import type {
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
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
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await expect(adapter.prepare(launchInput())).resolves.toEqual({
      ok: false,
      providerId: 'opencode',
      reason: 'mcp_unavailable',
      retryable: true,
      diagnostics: ['OpenCode missing canonical app MCP tool id', 'runtime_deliver_message'],
      warnings: [],
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo',
      selectedModel: 'openai/gpt-5.4-mini',
      requireExecutionProbe: true,
    }));
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledTimes(1);
  });

  it('uses runtime-only readiness for model-less preflight checks', async () => {
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true, modelId: null }));
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await expect(
      adapter.prepare(launchInput({ model: undefined, runtimeOnly: true }))
    ).resolves.toMatchObject({
      ok: true,
      providerId: 'opencode',
      modelId: null,
    });

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo',
      selectedModel: null,
      requireExecutionProbe: false,
    }));
  });

  it('surfaces unknown readiness failures with the concrete bridge diagnostic on launch', async () => {
    const bridge = bridgePort(
      readiness({
        state: 'unknown_error',
        launchAllowed: false,
        diagnostics: [
          'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
        ],
        missing: ['OpenCode bridge command timed out'],
      })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await expect(adapter.launch(launchInput())).resolves.toMatchObject({
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          launchState: 'failed_to_start',
          hardFailureReason: 'OpenCode is temporarily unavailable. Retry the launch.',
          diagnostics: [
            'OpenCode is temporarily unavailable. Retry the launch.',
            'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
            'OpenCode bridge command timed out',
          ],
        },
      },
    });
  });

  it('surfaces Cursor quota instead of generic readiness diagnostics on launch', async () => {
    const cursorQuota = "cursor-acp error: You've hit your Cursor usage limit";
    const bridge = bridgePort(
      readiness({
        state: 'model_unavailable',
        launchAllowed: false,
        diagnostics: [
          'OpenCode command timed out after 10000ms',
          'CLI-authenticated providers missing from live host (github-copilot)',
          'OpenCode session status busy',
          'OpenCode prompt start exposed a terminal provider error in 1700ms',
          'OpenCode retry status exposed a terminal provider error',
          'OpenCode session messages request exposed a terminal provider error',
          'OpenCode retry/error payload exposed a terminal provider failure before polling completed',
          'OpenCode assistant payload exposed a terminal provider failure after polling completed',
          'Cursor native failure probe will retry after a transient failure in 2040ms',
          'Cursor native execution preflight was inconclusive; falling back to the OpenCode execution probe',
          'Cursor native failure probe failed: temporary spawn failure',
          'Cursor native failure probe confirmed a terminal provider error in 2150ms',
          cursorQuota,
        ],
      })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(launchInput({ model: 'cursor-acp/auto' }));

    expect(result.members.alice?.hardFailureReason).toBe(cursorQuota);
  });

  it('still runs readiness when a legacy caller asks to skip OpenCode preflight', async () => {
    const invocation = launchInvocationFixture();
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command, options) =>
      invocation.dispatch(
        options,
        () =>
          ({
            ...successfulOpenCodeLaunchData(command),
            runId: 'run-1',
            teamLaunchState: 'ready',
            members: {
              alice: {
                sessionId: 'oc-session-1',
                launchState: 'confirmed_alive',
                runtimePid: 123,
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
            diagnostics: [
              {
                code: 'opencode_launch_total_timing',
                severity: 'info',
                message: 'total=12ms provisioningProbe=3ms members=1',
              },
              {
                code: 'member_reconcile',
                severity: 'warning',
                message: 'alice: sample reconcile diagnostic',
              },
            ],
          }) satisfies OpenCodeLaunchTeamCommandData
      )
    );
    const bridge = bridgePort(
      readiness({
        state: 'ready',
        launchAllowed: true,
        diagnostics: ['readiness was required'],
      }),
      {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-1')),
        launchOpenCodeTeam,
      }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(
      launchInput({
        skipReadinessPreflight: true,
        onInvocationBoundary: invocation.onBoundary,
      })
    );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'openai/gpt-5.4-mini',
        skipPermissions: true,
        expectedCapabilitySnapshotId: null,
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        'info:opencode_launch_total_timing: total=12ms provisioningProbe=3ms members=1',
      ])
    );
    expect(result.members.alice?.diagnostics).not.toContain(
      'info:opencode_launch_total_timing: total=12ms provisioningProbe=3ms members=1'
    );
    expect(result.members.alice?.diagnostics).toContain(
      'warning:member_reconcile: alice: sample reconcile diagnostic'
    );
  });

  it('requires execution proof when a runtime-only caller starts a real launch', async () => {
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-authless-launch')),
      launchOpenCodeTeam: vi.fn(async (command) => successfulOpenCodeLaunchData(command)),
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await adapter.launch(
      launchInput({
        model: 'cursor-acp/auto',
        runtimeOnly: true,
      })
    );

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo',
      selectedModel: 'cursor-acp/auto',
      requireExecutionProbe: true,
    }));
  });

  it('rejects raw session B when the committed linkage proves session A', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      const data = successfulOpenCodeLaunchData(command);
      data.members.alice!.sessionId = 'oc-session-B';
      return data;
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam,
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.members.alice).toMatchObject({
      runtimeAlive: false,
      bootstrapConfirmed: false,
    });
    expect(result.members.alice?.sessionId).toBeUndefined();
    expect(result.members.alice?.runtimePid).toBeUndefined();
    expect(result.members.alice?.diagnostics).toContain(
      'OpenCode committed member session did not match its strict launch linkage; live runtime evidence was rejected.'
    );
  });

  it('authorizes a committed member only when the raw session hashes to the exact linkage', async () => {
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam: vi.fn(async (command) => successfulOpenCodeLaunchData(command)),
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.members.alice).toMatchObject({
      sessionId: 'oc-session-1',
      runtimePid: 123,
      runtimeAlive: true,
      bootstrapConfirmed: true,
    });
  });

  it('retains validated member linkage reconstructed by durable bridge replay', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      const replay = successfulOpenCodeLaunchData(command);
      replay.diagnostics = [
        {
          code: 'opencode_strict_launch_durable_replay',
          severity: 'warning',
          message: 'Recovered validated member linkage without bridge dispatch.',
        },
      ];
      replay.members.alice = {
        sessionId: 'oc-session-1',
        launchState: 'confirmed_alive',
        model: command.selectedModel,
        evidence: [],
      };
      return replay;
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.members.alice).toMatchObject({
      sessionId: 'oc-session-1',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
    });
  });

  it('maps absent durable linkage to reconciliation pending instead of known-no-start failure', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      const replay = successfulOpenCodeLaunchData(command);
      replay.members = {};
      replay.launchAttempt!.launchAttempt.outcome = 'reconciliation_required';
      replay.launchAttempt!.launchAttempt.phase = 'cleanup';
      replay.launchAttempt!.failure = {
        code: 'unknown_transport_after_side_effect',
        origin: 'session',
        retryDisposition: 'never',
        retryable: false,
        phase: 'member_materialize',
        sideEffectsStarted: true,
      };
      return replay;
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.launchPhase).toBe('active');
    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      hardFailure: false,
      runtimeAlive: false,
      bootstrapConfirmed: false,
    });
    expect(result.openCodeStrictLaunchAttempt?.disposition).toBe('reconciliation_required');
  });

  it('blocks a local model before the state-changing launch when team tool coordination fails', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) => successfulOpenCodeLaunchData(command));
    const inspectLocalModelRuntime = vi.fn(async () => ({
      severity: 'blocking' as const,
      code: 'local_coordination_probe_failed',
      message: 'Local model ollama/qwen2.5:0.5b did not complete the Agent Teams tool sequence.',
    }));
    const bridge = bridgePort(
      readiness({
        state: 'ready',
        launchAllowed: true,
        modelId: 'ollama/qwen2.5:0.5b',
        availableModels: ['ollama/qwen2.5:0.5b'],
      }),
      {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-local-blocked')),
        launchOpenCodeTeam,
      }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(launchInput({ model: 'ollama/qwen2.5:0.5b' }));

    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/repo',
      modelRoute: 'ollama/qwen2.5:0.5b',
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          launchState: 'failed_to_start',
          hardFailureReason:
            'Local model ollama/qwen2.5:0.5b did not complete the Agent Teams tool sequence.',
        },
      },
    });
  });

  it('passes an explicit experimental override to local inspection and continues to execution proof', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) =>
      successfulOpenCodeLaunchData(command, { model: 'ollama/qwen2.5:0.5b' })
    );
    const inspectLocalModelRuntime = vi.fn(
      async ({
        modelRoute,
        allowExperimentalLocalModels,
      }: {
        modelRoute: string;
        allowExperimentalLocalModels?: boolean;
      }) =>
        modelRoute.startsWith('ollama/')
          ? {
              severity: allowExperimentalLocalModels ? ('warning' as const) : ('blocking' as const),
              code: 'local_coordination_probe_failed',
              message: 'Local coordination was not confirmed.',
            }
          : null
    );
    const bridge = bridgePort(
      readiness({
        state: 'ready',
        launchAllowed: true,
        modelId: 'ollama/qwen2.5:0.5b',
        availableModels: ['ollama/qwen2.5:0.5b'],
      }),
      {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-local-experimental')),
        launchOpenCodeTeam,
      }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(
      launchInput({
        model: 'ollama/qwen2.5:0.5b',
        allowExperimentalLocalModels: true,
      })
    );

    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/repo',
      modelRoute: 'ollama/qwen2.5:0.5b',
      allowExperimentalLocalModels: true,
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalled();
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.warnings).toContain('Local coordination was not confirmed.');
  });

  it('never lets the experimental local override bypass the real OpenCode execution proof', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) =>
      successfulOpenCodeLaunchData(command, { model: 'ollama/qwen3:8b' })
    );
    const inspectLocalModelRuntime = vi.fn(async () => ({
      severity: 'warning' as const,
      code: 'local_coordination_probe_failed',
      message: 'Experimental coordination override applied.',
    }));
    const bridge = bridgePort(
      readiness({
        state: 'model_unavailable',
        launchAllowed: false,
        modelId: 'ollama/qwen3:8b',
        diagnostics: ['OpenCode execution probe rejected ollama/qwen3:8b'],
      }),
      {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-local-rejected')),
        launchOpenCodeTeam,
      }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(
      launchInput({
        model: 'ollama/qwen3:8b',
        allowExperimentalLocalModels: true,
      })
    );

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/repo',
      selectedModel: 'ollama/qwen3:8b',
      requireExecutionProbe: true,
    }));
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          launchState: 'failed_to_start',
          hardFailureReason: 'OpenCode execution probe rejected ollama/qwen3:8b',
        },
      },
    });
  });

  it('blocks an incompatible local member model even when the lane default is remote', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) => successfulOpenCodeLaunchData(command));
    const inspectLocalModelRuntime = vi.fn(async ({ modelRoute }: { modelRoute: string }) =>
      modelRoute.startsWith('ollama/')
        ? {
            severity: 'blocking' as const,
            code: 'local_context_too_small',
            message: 'Ollama member model is running with 4K context; Agent Teams requires 16K.',
          }
        : null
    );
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-local-member-blocked')),
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(
      launchInput({
        model: 'openai/gpt-5.4-mini',
        expectedMembers: [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            cwd: '/repo',
          },
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'ollama/qwen3:4b',
            cwd: '/repo',
          },
        ],
      })
    );

    // The adapter checks each distinct source once so arbitrary configured local
    // provider ids can be discovered without hardcoding their names.
    expect(inspectLocalModelRuntime).toHaveBeenCalledTimes(2);
    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/repo',
      modelRoute: 'ollama/qwen3:4b',
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      teamLaunchState: 'partial_failure',
      members: {
        bob: {
          launchState: 'failed_to_start',
          hardFailureReason:
            'Ollama member model is running with 4K context; Agent Teams requires 16K.',
        },
      },
    });
  });

  it('blocks a local model when its configured provider cannot be resolved', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) => successfulOpenCodeLaunchData(command));
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime: vi.fn().mockResolvedValue(null),
    });

    const result = await adapter.launch(launchInput({ model: 'lmstudio/qwen3:8b' }));

    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      teamLaunchState: 'partial_failure',
      members: {
        alice: {
          launchState: 'failed_to_start',
          hardFailureReason: expect.stringContaining('Reconnect it'),
        },
      },
    });
  });

  it('blocks an incompatible custom local provider even with an arbitrary source id', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) => successfulOpenCodeLaunchData(command));
    const inspectLocalModelRuntime = vi.fn(async () => ({
      severity: 'blocking' as const,
      code: 'local_coordination_probe_failed',
      message: 'Custom local model did not complete Agent Teams coordination.',
    }));
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(launchInput({ model: 'local-lab/team-model' }));

    expect(inspectLocalModelRuntime).toHaveBeenCalledWith({
      projectPath: '/repo',
      modelRoute: 'local-lab/team-model',
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result.members.alice?.hardFailureReason).toContain(
      'did not complete Agent Teams coordination'
    );
  });

  it('checks an unconfigured cloud source only once during local model preflight', async () => {
    const inspectLocalModelRuntime = vi.fn().mockResolvedValue(null);
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true })),
      { inspectLocalModelRuntime }
    );

    const result = await adapter.preflightLocalModels({
      targets: [
        { projectPath: '/repo', modelRoute: 'openrouter/model-a' },
        { projectPath: '/repo', modelRoute: 'openrouter/model-b' },
      ],
    });

    expect(result).toEqual({ ok: true, warnings: [], diagnostics: [] });
    expect(inspectLocalModelRuntime).toHaveBeenCalledTimes(1);
  });

  it('allows a coordination-verified local model through the state-changing launch', async () => {
    const launchOpenCodeTeam = vi.fn(async (command) =>
      successfulOpenCodeLaunchData(command, { model: 'ollama/qwen3:4b' })
    );
    const inspectLocalModelRuntime = vi.fn(async ({ modelRoute }: { modelRoute: string }) =>
      modelRoute.startsWith('ollama/')
        ? {
            severity: 'ready' as const,
            code: 'local_coordination_verified',
            message: 'Local model ollama/qwen3:4b passed Agent Teams tool coordination.',
          }
        : null
    );
    const bridge = bridgePort(
      readiness({
        state: 'ready',
        launchAllowed: true,
        modelId: 'ollama/qwen3:4b',
        availableModels: ['ollama/qwen3:4b'],
      }),
      {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-local-ready')),
        launchOpenCodeTeam,
      }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge, {
      inspectLocalModelRuntime,
    });

    const result = await adapter.launch(launchInput({ model: 'ollama/qwen3:4b' }));

    expect(result.teamLaunchState).toBe('clean_success');
    expect(inspectLocalModelRuntime).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
  });

  it('launches isolated worktrees with the member worktree as the OpenCode project path', async () => {
    const worktreePath = '/tmp/generated-worktrees/alice';
    const invocation = launchInvocationFixture();
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command, options) =>
      invocation.dispatch(options, () => successfulOpenCodeLaunchData(command))
    );
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-worktree')),
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(
      launchInput({
        cwd: worktreePath,
        expectedMembers: [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            cwd: worktreePath,
            isolation: 'worktree',
          },
        ],
        onInvocationBoundary: invocation.onBoundary,
      })
    );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: worktreePath,
        selectedModel: 'openai/gpt-5.4-mini',
        requireExecutionProbe: true,
      })
    );
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: worktreePath,
        expectedCapabilitySnapshotId: null,
        members: [expect.objectContaining({ name: 'alice' })],
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
  });

  it('builds a lead-specific OpenCode bootstrap prompt for team-lead sessions', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async () => ({
      runId: 'run-1',
      teamLaunchState: 'ready',
      members: {
        'team-lead': {
          sessionId: 'oc-lead-session',
          launchState: 'confirmed_alive',
          runtimePid: 123,
          model: 'openai/gpt-5.4-mini',
          evidence: [
            { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'member_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
          ],
        },
        alice: {
          sessionId: 'oc-alice-session',
          launchState: 'confirmed_alive',
          runtimePid: 124,
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
    }));
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-lead')),
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await adapter.launch(
      launchInput({
        expectedMembers: [
          {
            name: 'team-lead',
            role: 'Team Lead',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            cwd: '/repo',
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            cwd: '/repo',
          },
        ],
      })
    );

    const command = launchOpenCodeTeam.mock.calls[0]?.[0];
    const leadPrompt = command?.members.find((member) => member.name === 'team-lead')?.prompt;
    expect(leadPrompt).toContain('You are team-lead, the team lead');
    expect(leadPrompt).toContain('message the human user or a teammate');
    expect(leadPrompt).toContain('Always set from="team-lead"');
    expect(leadPrompt).not.toContain('human user, team lead, or another teammate');
  });

  it.each([
    'Unable to connect',
    'Failed to connect',
    'connection reset',
    'connection refused',
    'connection closed',
    'connection hangup',
    'socket connection was closed',
    'socket closure',
    'socket hang up',
    'fetch failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'network error',
    'NetworkError',
  ])('retries cheap readiness transport failure %s before prepare succeeds', async (marker) => {
    const finalReadiness = readiness({
      state: 'ready',
      launchAllowed: true,
      diagnostics: ['OpenCode readiness recovered'],
    });
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(
        readiness({
          state: 'unknown_error',
          launchAllowed: false,
          diagnostics: [`OpenCode readiness bridge failed: ${marker}`],
        })
      )
      .mockResolvedValueOnce(finalReadiness);
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.prepare(launchInput());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);

      await expect(resultPromise).resolves.toEqual({
        ok: true,
        providerId: 'opencode',
        modelId: 'openai/gpt-5.4-mini',
        diagnostics: ['OpenCode readiness recovered'],
        warnings: [],
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(adapter.getLastOpenCodeTeamLaunchReadiness('/repo')).toBe(finalReadiness);
  });

  it('does not retry the exhausted readiness work from the six-member issue bundle', async () => {
    const issueFailure = readiness({
      state: 'unknown_error',
      launchAllowed: false,
      diagnostics: [
        'OpenCode inventory probe timed out after 45000ms while waiting for six expected members',
        'Failed to query OpenCode models: OpenCode command timed out after 10000ms',
        'Failed to query OpenCode agents: OpenCode bridge command timed out after 10000ms',
        '/config request failed: OpenCode request timed out after 15000ms for /config',
        'OpenCode readiness bridge failed: fetch failed after request was aborted',
      ],
      missing: ['OpenCode live inventory unavailable'],
    });
    const checkReadiness = vi.fn(async () => issueFailure);
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });
    const expectedMembers = ['lead', 'researcher', 'implementer', 'reviewer', 'tester', 'writer'].map(
      (name) => ({
        name,
        providerId: 'opencode' as const,
        model: 'openai/gpt-5.4-mini',
        cwd: '/repo',
      })
    );

    await expect(adapter.prepare(launchInput({ expectedMembers }))).resolves.toEqual({
      ok: false,
      providerId: 'opencode',
      reason: 'unknown_error',
      retryable: true,
      diagnostics: [...issueFailure.diagnostics, ...issueFailure.missing],
      warnings: [],
    });

    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(adapter.getLastOpenCodeTeamLaunchReadiness('/repo')).toBe(issueFailure);
  });

  it.each([
    'OpenCode inventory probe timed out after 45000ms',
    'Failed to query OpenCode models: request timed out after 10000ms',
    'Failed to query OpenCode agents: request timed out after 10000ms',
    'OpenCode command timed out after 10000ms',
    'OpenCode bridge command timed out after 10000ms',
    '/config request failed: request timed out after 15000ms',
    'OpenCode request timed out after 15000ms while loading /config',
  ])('does not retry internally exhausted readiness work: %s', async (exhaustedDiagnostic) => {
    const failedReadiness = readiness({
      state: 'unknown_error',
      launchAllowed: false,
      diagnostics: [
        exhaustedDiagnostic,
        'OpenCode readiness bridge also reported fetch failed, aborted, and network error',
      ],
    });
    const checkReadiness = vi.fn(async () => failedReadiness);
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    await expect(adapter.prepare(launchInput())).resolves.toMatchObject({
      ok: false,
      reason: 'unknown_error',
      retryable: true,
    });
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('returns the final readiness failure after three repeated cheap transport attempts', async () => {
    const finalReadiness = readiness({
      state: 'mcp_unavailable',
      launchAllowed: false,
      diagnostics: ['OpenCode readiness bridge failed: fetch failed'],
      missing: ['final transport missing'],
    });
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValue(finalReadiness);
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.prepare(launchInput());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        providerId: 'opencode',
        reason: 'mcp_unavailable',
        retryable: true,
        diagnostics: ['OpenCode readiness bridge failed: fetch failed', 'final transport missing'],
        warnings: [],
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(3);
    expect(adapter.getLastOpenCodeTeamLaunchReadiness('/repo')).toBe(finalReadiness);
  });

  it.each([
    {
      state: 'not_authenticated' as const,
      diagnostics: ['OpenCode provider returned 401 unauthorized'],
    },
    {
      state: 'not_installed' as const,
      diagnostics: ['OpenCode runtime binary is not installed'],
    },
    {
      state: 'model_unavailable' as const,
      diagnostics: ['Selected model is unavailable'],
    },
    {
      state: 'mcp_unavailable' as const,
      diagnostics: ['OpenCode /experimental/tool/ids unavailable - HTTP 403 forbidden'],
    },
    {
      state: 'mcp_unavailable' as const,
      diagnostics: ['OpenCode /experimental/tool/ids unavailable - HTTP 404 Not Found'],
    },
    {
      state: 'mcp_unavailable' as const,
      diagnostics: [
        'OpenCode /experimental/tool/ids unavailable - fetch failed',
        'App MCP tool missing: runtime_deliver_message',
      ],
    },
    {
      state: 'unknown_error' as const,
      diagnostics: ['OpenCode bridge contract violation: schema mismatch'],
    },
    {
      state: 'unknown_error' as const,
      diagnostics: ['OpenCode readiness check timed out'],
    },
    {
      state: 'unknown_error' as const,
      diagnostics: ['OpenCode readiness timeout'],
    },
    {
      state: 'unknown_error' as const,
      diagnostics: ['OpenCode readiness request aborted'],
    },
    {
      state: 'mcp_unavailable' as const,
      diagnostics: ['OpenCode /experimental/tool/ids unavailable'],
    },
  ])('does not retry $state readiness failures', async ({ state, diagnostics }) => {
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValue(readiness({ state, launchAllowed: false, diagnostics }));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    await expect(adapter.prepare(launchInput())).resolves.toMatchObject({
      ok: false,
      reason: state,
    });
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('launch retries transient readiness before a capability-unbound strict command', async () => {
    const invocation = launchInvocationFixture();
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(
        readiness({
          state: 'mcp_unavailable',
          launchAllowed: false,
          diagnostics: ['OpenCode /experimental/tool/ids unavailable - Unable to connect'],
        })
      )
      .mockResolvedValueOnce(readiness({ state: 'ready', launchAllowed: true }));
    const getLastOpenCodeRuntimeSnapshot = vi.fn(() => runtimeSnapshot('cap-fresh'));
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command, options) =>
      Promise.resolve(invocation.dispatch(options, () => successfulOpenCodeLaunchData(command)))
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot,
      launchOpenCodeTeam,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.launch(
        launchInput({ onInvocationBoundary: invocation.onBoundary })
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);

      await expect(resultPromise).resolves.toMatchObject({
        teamLaunchState: 'clean_success',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(getLastOpenCodeRuntimeSnapshot).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCapabilitySnapshotId: null,
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
  });

  it('refreshes readiness availability without forwarding execution proof authorization', async () => {
    const executionProof = reusableExecutionProof();
    const invocation = launchInvocationFixture();
    const checkReadiness = vi.fn(async () =>
      readiness({ state: 'ready', launchAllowed: true, executionProof })
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command, options) =>
      Promise.resolve(invocation.dispatch(options, () => successfulOpenCodeLaunchData(command)))
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-proof')),
      launchOpenCodeTeam,
    });

    await adapter.prepare(launchInput());
    await adapter.launch(launchInput({ onInvocationBoundary: invocation.onBoundary }));

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.not.objectContaining({ executionProof: expect.anything() }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    expect(launchOpenCodeTeam.mock.calls[0]?.[1]).not.toHaveProperty('executionProof');
    invocation.expectConsumed();
  });

  it('does not reuse OAuth execution proof across prepare and launch', async () => {
    const oauthProof = {
      ...reusableExecutionProof(),
      credentialMode: 'oauth' as const,
      reusable: false,
    };
    const invocation = launchInvocationFixture();
    const checkReadiness = vi.fn(async () =>
      readiness({ state: 'ready', launchAllowed: true, executionProof: oauthProof })
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command, options) =>
      Promise.resolve(invocation.dispatch(options, () => successfulOpenCodeLaunchData(command)))
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-proof')),
      launchOpenCodeTeam,
    });

    await adapter.prepare(launchInput());
    await adapter.launch(launchInput({ onInvocationBoundary: invocation.onBoundary }));

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.not.objectContaining({ executionProof: expect.anything() }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    expect(launchOpenCodeTeam.mock.calls[0]?.[1]).not.toHaveProperty('executionProof');
    invocation.expectConsumed();
  });

  it('singleflights concurrent readiness availability checks', async () => {
    const readinessResolvers: Array<(value: OpenCodeTeamLaunchReadiness) => void> = [];
    const checkReadiness = vi.fn(
      () =>
        new Promise<OpenCodeTeamLaunchReadiness>((resolve) => {
          readinessResolvers.push(resolve);
        })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    const first = adapter.prepare(launchInput());
    const second = adapter.prepare(launchInput());
    await vi.waitFor(() => expect(readinessResolvers).toHaveLength(1));
    for (const resolveReadiness of readinessResolvers) {
      resolveReadiness(
        readiness({
          state: 'ready',
          launchAllowed: true,
          executionProof: reusableExecutionProof(),
        })
      );
    }

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('passes manual tool approval intent with a fresh capability precondition', async () => {
    const invocation = launchInvocationFixture();
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command, options) =>
      Promise.resolve(invocation.dispatch(options, () => successfulOpenCodeLaunchData(command)))
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: vi.fn(async () =>
        readiness({ state: 'ready', launchAllowed: true })
      ),
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-manual')),
      launchOpenCodeTeam,
    });

    await expect(
      adapter.launch(
        launchInput({
          skipPermissions: false,
          onInvocationBoundary: invocation.onBoundary,
        })
      )
    ).resolves.toMatchObject({ teamLaunchState: 'clean_success' });

    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        skipPermissions: false,
        expectedCapabilitySnapshotId: null,
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
  });

  it('preserves Kimi K3 effort as the OpenCode launch variant', async () => {
    const invocation = launchInvocationFixture();
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command, options) =>
      Promise.resolve(
        invocation.dispatch(options, () =>
          successfulOpenCodeLaunchData(command, { model: 'kimi-for-coding/k3' })
        )
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: vi.fn(async () =>
        readiness({
          state: 'ready',
          launchAllowed: true,
          modelId: 'kimi-for-coding/k3',
          availableModels: ['kimi-for-coding/k3'],
        })
      ),
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-kimi-k3')),
      launchOpenCodeTeam,
    });

    await adapter.launch(
      launchInput({
        model: 'kimi-for-coding/k3',
        effort: 'high',
        expectedMembers: [
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'kimi-for-coding/k3',
            effort: 'max',
            cwd: '/repo',
          },
        ],
        onInvocationBoundary: invocation.onBoundary,
      })
    );

    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'kimi-for-coding/k3',
        effort: 'high',
        members: [
          expect.objectContaining({
            name: 'alice',
            effort: 'max',
          }),
        ],
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
  });

  it('launches model-less Default selections with the readiness-resolved model', async () => {
    const invocation = launchInvocationFixture();
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command, options) =>
      invocation.dispatch(options, () =>
        successfulOpenCodeLaunchData(command, { model: 'opencode/big-pickle' })
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(
        readiness({
          state: 'ready',
          launchAllowed: true,
          modelId: 'opencode/big-pickle',
          availableModels: ['opencode/big-pickle'],
        }),
        { launchOpenCodeTeam }
      )
    );

    const result = await adapter.launch(
      launchInput({
        model: undefined,
        expectedMembers: [
          {
            name: 'alice',
            providerId: 'opencode',
            cwd: '/repo',
          },
        ],
        onInvocationBoundary: invocation.onBoundary,
      })
    );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'opencode/big-pickle',
        launchAttempt: expect.objectContaining({ requireFreshRetainedHostProof: true }),
      }),
      expect.objectContaining({ invocationAuthority: invocation.authority })
    );
    invocation.expectConsumed();
    expect(result.members.alice?.model).toBe('opencode/big-pickle');
  });

  it('rejects non-OpenCode members before readiness or launch bridge dispatch', async () => {
    const launchOpenCodeTeam = vi.fn();
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(
      launchInput({
        expectedMembers: [
          {
            name: 'bob',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            cwd: '/repo',
          },
        ],
      })
    );

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.members.bob).toMatchObject({
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'opencode_invalid_expected_members',
      diagnostics: [
        'OpenCode runtime adapter received non-OpenCode member "bob" with provider "codex".',
      ],
    });
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
  });

  it('rejects empty OpenCode rosters before readiness or launch bridge dispatch', async () => {
    const launchOpenCodeTeam = vi.fn();
    const bridge = bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
      launchOpenCodeTeam,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(launchInput({ expectedMembers: [] }));

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.members).toEqual({});
    expect(result.diagnostics).toEqual([
      'OpenCode runtime adapter requires at least one expected OpenCode member.',
    ]);
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
  });

  it('retains app-managed candidate state when strict session linkage is committed', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command) => {
      const data = successfulOpenCodeLaunchData(command);
      const member = data.members.alice;
      const sessionId = member.sessionId;
      if (sessionId === undefined) {
        throw new Error('Expected successful OpenCode launch data to include an Alice session ID.');
      }
      member.bootstrapEvidenceSource = 'app_managed_bootstrap';
      member.bootstrapMode = 'app_managed_context';
      member.appManagedBootstrapCandidate = appManagedCandidate(command, sessionId);
      member.pendingPermissionRequestIds = ['permission-1'];
      member.pendingPermissions = [
        {
          requestId: 'permission-1',
          sessionId,
          tool: 'bash',
          title: 'Run command',
          kind: 'tool',
        },
      ];
      return Promise.resolve(data);
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice).toMatchObject({
      launchState: 'confirmed_alive',
      sessionId: 'oc-session-1',
      runtimePid: 123,
      appManagedBootstrapCandidate: {
        runtimeSessionId: 'oc-session-1',
        messageID: 'msg-bootstrap-alice',
      },
      pendingPermissionRequestIds: ['permission-1'],
      pendingApprovals: [{ requestId: 'permission-1', sessionId: 'oc-session-1' }],
    });
  });

  it.each(['proof_null', 'cancelled', 'failed', 'session_linkage_mismatch'] as const)(
    'clears retainable raw session state for unauthorized strict launch result: %s',
    async (rejection) => {
      const launchOpenCodeTeam = vi.fn<
        NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
      >((command) => {
        const data = successfulOpenCodeLaunchData(command);
        const member = data.members.alice;
        const sessionId = member.sessionId;
        if (sessionId === undefined) {
          throw new Error(
            'Expected successful OpenCode launch data to include an Alice session ID.'
          );
        }
        member.bootstrapEvidenceSource = 'app_managed_bootstrap';
        member.bootstrapMode = 'app_managed_context';
        member.appManagedBootstrapCandidate = appManagedCandidate(command, sessionId);
        member.pendingPermissionRequestIds = ['permission-1'];
        member.pendingPermissions = [
          {
            requestId: 'permission-1',
            sessionId,
            tool: 'bash',
            title: 'Run command',
            kind: 'tool',
          },
        ];
        const strict = data.launchAttempt;
        if (strict === undefined) {
          throw new Error('Expected successful OpenCode launch data to include a launch attempt.');
        }
        const memberIdentity = command.members[0].memberIdentity;
        if (rejection === 'session_linkage_mismatch') {
          strict.members.committed[0].sessionIdentity = `sha256:${stableHash('other-session')}`;
        } else {
          delete strict.proof;
          strict.members.committed = [];
          if (rejection === 'failed') {
            strict.launchAttempt.outcome = 'failed';
            strict.members.failed = [
              {
                memberIdentity,
                failure: {
                  code: 'external_dependency',
                  origin: 'provider',
                  retryDisposition: 'never',
                  retryable: false,
                  phase: 'member_materialize',
                  sideEffectsStarted: false,
                },
              },
            ];
            strict.failure = strict.members.failed[0].failure;
          } else {
            strict.members.pending = [memberIdentity];
            if (rejection === 'cancelled') {
              strict.launchAttempt.outcome = 'cancelled';
            } else {
              strict.launchAttempt.outcome = 'reconciliation_required';
              strict.failure = {
                code: 'unknown_transport_after_side_effect',
                origin: 'session',
                retryDisposition: 'never',
                retryable: false,
                phase: 'member_materialize',
                sideEffectsStarted: true,
              };
            }
          }
        }
        return Promise.resolve(data);
      });
      const adapter = new OpenCodeTeamRuntimeAdapter(
        bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
      );

      const result = await adapter.launch(launchInput());
      const member = result.members.alice;

      expect(member.agentToolAccepted).toBe(false);
      expect(member.runtimeAlive).toBe(false);
      expect(member).not.toHaveProperty('sessionId');
      expect(member).not.toHaveProperty('runtimePid');
      expect(member).not.toHaveProperty('bootstrapEvidenceSource');
      expect(member).not.toHaveProperty('bootstrapMode');
      expect(member).not.toHaveProperty('appManagedBootstrapCandidate');
      expect(member).not.toHaveProperty('pendingPermissionRequestIds');
      expect(member).not.toHaveProperty('pendingApprovals');
      expect(member).not.toHaveProperty('pendingPermissions');
    }
  );

  it('advances a correlated user continuation without replaying the uncertain generation', async () => {
    const commands: OpenCodeLaunchTeamCommandBody[] = [];
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        const partial = successfulOpenCodeLaunchData(command);
        const strict = partial.launchAttempt!;
        strict.launchAttempt.outcome = 'partial';
        strict.launchAttempt.phase = 'cleanup';
        strict.members.committed = strict.members.committed.slice(0, 1);
        strict.members.failed = [
          {
            memberIdentity: command.members[1]!.memberIdentity,
            failure: {
              code: 'rate_limited',
              origin: 'provider',
              retryDisposition: 'backoff',
              retryable: true,
              phase: 'member_materialize',
              sideEffectsStarted: false,
            },
          },
        ];
        strict.members.continuationToken = 'opaque-continuation-token';
        strict.failure = {
          code: 'deadline_after_partial',
          origin: 'deadline',
          retryDisposition: 'continuation',
          retryable: true,
          phase: 'member_materialize',
          sideEffectsStarted: true,
        };
        return partial;
      }
      return successfulOpenCodeLaunchData(command);
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-continuation')),
        launchOpenCodeTeam,
      })
    );

    const expectedMembers = [
      ...launchInput().expectedMembers,
      {
        name: 'bob',
        providerId: 'opencode' as const,
        model: 'openai/gpt-5.4-mini',
        cwd: '/repo',
      },
    ];
    const first = await adapter.launch(launchInput({ expectedMembers }));
    const persisted = launchSnapshot();
    persisted.expectedMembers = ['alice', 'bob'];
    persisted.openCodeStrictLaunchAttempt = first.openCodeStrictLaunchAttempt;
    const restartedAdapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );
    await restartedAdapter.launch(
      launchInput({ runId: 'new-app-run', expectedMembers, previousLaunchState: persisted })
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]?.launchAttempt).toMatchObject({
      attemptId: commands[0]?.launchAttempt.attemptId,
      payloadHash: commands[0]?.launchAttempt.payloadHash,
      generation: 2,
      continuationToken: 'opaque-continuation-token',
    });
    expect(commands[1]?.runId).toBe('run-1');
    expect(commands[1]?.members).toEqual(commands[0]?.members);
  });

  it('reconstructs the same first-generation request identity after an app restart', async () => {
    const commands: OpenCodeLaunchTeamCommandBody[] = [];
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      commands.push(command);
      return successfulOpenCodeLaunchData(command);
    });
    const createAdapter = () =>
      new OpenCodeTeamRuntimeAdapter(
        bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
      );

    await createAdapter().launch(launchInput());
    await createAdapter().launch(launchInput());

    expect(commands).toHaveLength(2);
    expect(commands[1]?.launchAttempt).toEqual(commands[0]?.launchAttempt);
  });

  it('blocks an uncertain user retry when the response omitted durable continuation identity', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async (command) => {
      const unknown = successfulOpenCodeLaunchData(command);
      const strict = unknown.launchAttempt!;
      strict.launchAttempt.outcome = 'reconciliation_required';
      strict.launchAttempt.phase = 'cleanup';
      delete strict.proof;
      strict.members.committed = [];
      strict.members.pending = command.members.map((member) => member.memberIdentity);
      strict.failure = {
        code: 'unknown_transport_after_side_effect',
        origin: 'session',
        retryDisposition: 'never',
        retryable: false,
        phase: 'member_materialize',
        sideEffectsStarted: true,
      };
      return unknown;
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-uncertain')),
        launchOpenCodeTeam,
      })
    );

    const first = await adapter.launch(launchInput());
    const persisted = launchSnapshot();
    persisted.openCodeStrictLaunchAttempt = first.openCodeStrictLaunchAttempt;
    const retry = await adapter.launch(launchInput({ previousLaunchState: persisted }));

    expect(first.openCodeStrictLaunchAttempt).toMatchObject({
      disposition: 'reconciliation_required',
    });
    expect(first.openCodeStrictLaunchAttempt).not.toHaveProperty('continuationToken');
    expect(retry.diagnostics).toContain(
      'OpenCode launch has an unknown post-side-effect outcome. Reconcile the exact durable attempt before any retry.'
    );
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
  });

  it('does not retry a successful launch just because stale diagnostics mention pre-launch mismatch', async () => {
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => Promise.resolve(readiness({ state: 'ready', launchAllowed: true }))
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((command) =>
      Promise.resolve({
        ...successfulOpenCodeLaunchData(command),
        diagnostics: [
          {
            code: 'stale_note',
            severity: 'warning',
            message: 'OpenCode bridge capability snapshot precondition mismatch',
          },
        ],
      })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-1')),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
  });

  it('does not retry a strict launch capability mismatch response', async () => {
    const { result, checkReadiness, launchOpenCodeTeam } =
      await launchWithStaleCapabilitySnapshotRecovery(
        'OpenCode bridge capability snapshot mismatch'
      );

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toContain(
      'OpenCode strict launch response failed correlation at $. The attempt must be reconciled before retrying.'
    );
    expect(result.openCodeStrictLaunchAttempt).toMatchObject({
      disposition: 'reconciliation_required',
      inputDigest: null,
      immutableDigest: null,
    });
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
          runtimeAlive: false,
          bootstrapConfirmed: false,
        },
      },
      snapshot,
    });
  });

  it('sends direct teammate messages through the OpenCode message bridge', async () => {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async () => ({
      accepted: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      runtimePid: 456,
      runtimePromptMessageId: 'msg_prompt_1',
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        sendOpenCodeTeamMessage,
      })
    );

    await expect(
      adapter.sendMessageToMember({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
        text: 'hello bob',
        messageId: 'msg-1',
        replyRecipient: 'alice',
        actionMode: 'delegate',
        forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
        taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
      })
    ).resolves.toEqual({
      ok: true,
      providerId: 'opencode',
      memberName: 'bob',
      sessionId: 'oc-session-bob',
      runtimePid: 456,
      runtimePromptMessageId: 'msg_prompt_1',
      diagnostics: [],
    });
    expect(sendOpenCodeTeamMessage).toHaveBeenCalledWith({
      runId: 'run-1',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'bob',
      text: expect.stringContaining('agent-teams_message_send'),
      messageId: 'msg-1',
      settlementMode: 'acceptance',
      actionMode: 'delegate',
      forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
      taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
      agent: 'teammate',
    });
    const sentText = sendOpenCodeTeamMessage.mock.calls[0]?.[0]?.text ?? '';
    expect(sentText).toContain('hello bob');
    expect(sentText).toContain('Use teamName="team-a", to="alice", from="bob", text, and summary.');
    expect(sentText).toContain(
      'Required message_send argument envelope: {"teamName":"team-a","to":"alice","from":"bob","source":"runtime_delivery","relayOfMessageId":"msg-1"'
    );
    expect(sentText).toContain(
      'If message_send reports parameter validation failure, correct the missing or invalid arguments'
    );
    expect(sentText).toContain('Include source="runtime_delivery"');
    expect(sentText).toContain('Include relayOfMessageId="msg-1"');
    expect(sentText).toContain('Action mode for this message: delegate.');
    expect(sentText).toContain('Action mode DELEGATE is orchestration-only');
    expect(sentText).not.toContain('If this delivered message assigns implementation');
    expect(sentText).toContain('You must not end this turn empty.');
    expect(sentText).toContain('<opencode_delivery_context>');
    expect(sentText).toContain('"kind":"opencode-delivery-context"');
    expect(sentText).toContain('"inboundMessageId":"msg-1"');
    expect(sentText).toContain('include taskRefs exactly as provided');
    expect(sentText).not.toContain('The inbound app messageId is');
    expect(sentText).toContain('Do not use SendMessage or runtime_deliver_message');
    expect(sentText).toContain('never use #00000000');
  });

  it('uses observed settlement for member-work-sync nudges so turn-settled can drive reconcile', async () => {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async () => ({
      accepted: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      runtimePid: 456,
      runtimePromptMessageId: 'msg_prompt_1',
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        sendOpenCodeTeamMessage,
      })
    );

    await expect(
      adapter.sendMessageToMember({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
        text: 'sync your current work state',
        messageId: 'sync-1',
        messageKind: 'member_work_sync_nudge',
        taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
      })
    ).resolves.toMatchObject({
      ok: true,
      runtimePromptMessageId: 'msg_prompt_1',
    });

    expect(sendOpenCodeTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'sync-1',
        messageKind: 'member_work_sync_nudge',
        settlementMode: 'observed',
      })
    );
  });

  it('observes direct teammate messages by exact accepted runtime prompt id', async () => {
    const observeOpenCodeTeamMessageDelivery = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['observeOpenCodeTeamMessageDelivery']>
    >(async () => ({
      observed: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      runtimePid: 456,
      runtimePromptMessageId: 'msg_prompt_1',
      responseObservation: {
        state: 'responded_plain_text',
        deliveredUserMessageId: 'msg_prompt_1',
        assistantMessageId: 'oc-assistant-1',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: 'done',
        reason: null,
      },
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        observeOpenCodeTeamMessageDelivery,
      })
    );

    await expect(
      adapter.observeMessageDelivery({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo',
        text: 'hello bob',
        messageId: 'msg-1',
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_1',
        prePromptCursor: 'cursor-before',
      })
    ).resolves.toMatchObject({
      ok: true,
      sessionId: 'oc-session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
      responseObservation: {
        deliveredUserMessageId: 'msg_prompt_1',
      },
    });

    expect(observeOpenCodeTeamMessageDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'oc-session-bob',
        runtimePromptMessageId: 'msg_prompt_1',
        prePromptCursor: 'cursor-before',
      })
    );
  });

  it('sends member work sync nudges with report-oriented response instructions', async () => {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async () => ({
      accepted: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        sendOpenCodeTeamMessage,
      })
    );

    await adapter.sendMessageToMember({
      runId: 'run-1',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: '/repo',
      text: 'Work sync check',
      messageId: 'msg-work-sync',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      messageKind: 'member_work_sync_nudge',
      controlUrl: 'http://127.0.0.1:43123',
      taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
    });

    expect(sendOpenCodeTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageKind: 'member_work_sync_nudge',
        actionMode: 'do',
      })
    );
    const sentText = sendOpenCodeTeamMessage.mock.calls[0]?.[0]?.text ?? '';
    expect(sentText).toContain('"messageKind":"member_work_sync_nudge"');
    expect(sentText).toContain('This delivered app message is a member-work-sync nudge.');
    expect(sentText).toContain('agent-teams_member_work_sync_status');
    expect(sentText).toContain('agent-teams_member_work_sync_report');
    expect(sentText).toContain('mcp__agent-teams__member_work_sync_report');
    expect(sentText).toContain('For agenda sync, only agent-teams_member_work_sync_report');
    expect(sentText).not.toContain('Concrete task progress');
    expect(sentText).toContain('If this delivered message assigns implementation');
    expect(sentText).toContain(
      'you may inspect, read/search, and edit files in the project working directory as your available tools allow'
    );
    expect(sentText).toContain('A status-only tool call is incomplete');
    expect(sentText).toContain('teamName="team-a"');
    expect(sentText).toContain('memberName="bob"');
    expect(sentText).toContain('controlUrl="http://127.0.0.1:43123"');
    expect(sentText).toContain('taskIds: "task-1"');
    expect(sentText).toContain(
      'Do not use provider names, runtime names, or team names as memberName'
    );
    expect(sentText).not.toContain('Include relayOfMessageId="msg-work-sync"');
    expect(sentText).not.toContain('You must not end this turn empty.');
  });

  it('sends review pickup work sync nudges with review-oriented response instructions', async () => {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async () => ({
      accepted: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        sendOpenCodeTeamMessage,
      })
    );

    await adapter.sendMessageToMember({
      runId: 'run-1',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: '/repo',
      text: 'Review pickup required',
      messageId: 'msg-review-pickup',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      messageKind: 'member_work_sync_nudge',
      workSyncIntent: 'review_pickup',
      workSyncReviewRequestEventIds: ['evt-review-request'],
      taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
    });

    const sentText = sendOpenCodeTeamMessage.mock.calls[0]?.[0]?.text ?? '';
    expect(sentText).toContain('"workSyncIntent":"review_pickup"');
    expect(sentText).toContain('"workSyncReviewRequestEventIds":["evt-review-request"]');
    expect(sentText).toContain('targeted member-work-sync review pickup nudge');
    expect(sentText).toContain('review workflow tools');
    expect(sentText).toContain('Review workflow tool usage');
    expect(sentText).not.toContain('Concrete review progress');
    expect(sentText).toContain('Do not mark the review complete from this prompt alone.');
    expect(sentText).toContain('agent-teams_member_work_sync_report');
    expect(sentText).toContain('A status-only tool call is incomplete');
    expect(sentText).not.toContain('This delivered app message is a member-work-sync nudge.');
  });

  it('does not parse legacy native SendMessage wording to infer OpenCode reply recipient', async () => {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async () => ({
      accepted: true,
      sessionId: 'oc-session-bob',
      memberName: 'bob',
      diagnostics: [],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        sendOpenCodeTeamMessage,
      })
    );

    await adapter.sendMessageToMember({
      runId: 'run-1',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      cwd: '/repo',
      text: 'CRITICAL: The destination must be exactly to="alice". Please reply back to recipient "alice".',
      messageId: 'msg-legacy-native',
    });

    const sentText = sendOpenCodeTeamMessage.mock.calls[0]?.[0]?.text ?? '';
    expect(sentText).toContain('Use teamName="team-a", to="user", from="bob", text, and summary.');
    expect(sentText).not.toContain(
      'Use teamName="team-a", to="alice", from="bob", text, and summary.'
    );
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

  it('answers OpenCode runtime permissions through the bridge and remaps the lane state', async () => {
    const answerOpenCodeRuntimePermission = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['answerOpenCodeRuntimePermission']>
    >(async () => ({
      runId: 'run-1',
      teamLaunchState: 'ready',
      members: {
        alice: {
          sessionId: 'oc-session-1',
          launchState: 'confirmed_alive',
          runtimePid: 123,
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
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        answerOpenCodeRuntimePermission,
      })
    );

    const result = await adapter.answerRuntimePermission({
      runId: 'run-1',
      teamName: 'team-a',
      laneId: 'primary',
      cwd: '/repo',
      providerId: 'opencode',
      memberName: 'alice',
      requestId: 'perm-1',
      decision: 'allow',
      expectedMembers: launchInput().expectedMembers,
      previousLaunchState: null,
    });

    expect(answerOpenCodeRuntimePermission).toHaveBeenCalledWith({
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'alice',
      requestId: 'perm-1',
      decision: 'allow',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });
    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.members.alice?.launchState).toBe('confirmed_alive');
  });

  it('fails runtime permission answers when the OpenCode answer bridge is unavailable', async () => {
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }))
    );

    await expect(
      adapter.answerRuntimePermission({
        runId: 'run-1',
        teamName: 'team-a',
        laneId: 'primary',
        cwd: '/repo',
        providerId: 'opencode',
        memberName: 'alice',
        requestId: 'perm-1',
        decision: 'allow',
        expectedMembers: launchInput().expectedMembers,
        previousLaunchState: null,
      })
    ).rejects.toThrow('OpenCode permission answer bridge is not registered.');
  });

  it('lists OpenCode runtime permissions through the bridge', async () => {
    const listOpenCodeRuntimePermissions = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['listOpenCodeRuntimePermissions']>
    >(async () => ({
      permissions: [
        {
          requestId: 'perm-1',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
        {
          requestId: 'perm-1',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Duplicate',
          kind: 'tool',
        },
        {
          requestId: '   ',
          sessionId: null,
          tool: null,
          title: null,
          kind: null,
        },
      ],
      diagnostics: ['permission list recovered from bridge warning'],
    }));
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        listOpenCodeRuntimePermissions,
      })
    );

    await expect(
      adapter.listRuntimePermissions({
        teamName: 'team-a',
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
        sessionId: 'session-alice',
        cwd: '/repo',
      })
    ).resolves.toEqual({
      permissions: [
        {
          providerId: 'opencode',
          requestId: 'perm-1',
          sessionId: 'session-alice',
          tool: 'bash',
          title: 'Run git status',
          kind: 'tool',
          raw: { patterns: ['git status'] },
        },
      ],
      diagnostics: ['permission list recovered from bridge warning'],
    });
    expect(listOpenCodeRuntimePermissions).toHaveBeenCalledWith({
      teamId: 'team-a',
      teamName: 'team-a',
      laneId: 'secondary:opencode:alice',
      memberName: 'alice',
      sessionId: 'session-alice',
      projectPath: '/repo',
    });
  });

  it('returns a diagnostic when the OpenCode runtime permission list bridge is unavailable', async () => {
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }))
    );

    await expect(
      adapter.listRuntimePermissions({
        teamName: 'team-a',
        laneId: 'primary',
        cwd: '/repo',
      })
    ).resolves.toEqual({
      permissions: [],
      diagnostics: ['OpenCode runtime permission list bridge is not registered.'],
    });
  });

});

async function launchWithStaleCapabilitySnapshotRecovery(message: string) {
  let readinessCalls = 0;
  let capabilitySnapshotId = 'cap-old';
  const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
    () => {
      readinessCalls += 1;
      capabilitySnapshotId = readinessCalls === 1 ? 'cap-old' : 'cap-new';
      return Promise.resolve(readiness({ state: 'ready', launchAllowed: true }));
    }
  );
  const launchOpenCodeTeam = vi.fn<
    NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
  >((input) =>
    Promise.resolve(
      input.expectedCapabilitySnapshotId === null
        ? failedCapabilitySnapshotLaunchData(message)
        : successfulOpenCodeLaunchData(input)
    )
  );
  const adapter = new OpenCodeTeamRuntimeAdapter({
    checkOpenCodeTeamLaunchReadiness: checkReadiness,
    getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot(capabilitySnapshotId)),
    launchOpenCodeTeam,
  });

  return {
    result: await adapter.launch(launchInput()),
    checkReadiness,
    launchOpenCodeTeam,
  };
}

function runtimeSnapshot(capabilitySnapshotId: string) {
  return {
    providerId: 'opencode' as const,
    binaryPath: '/opt/homebrew/bin/opencode',
    binaryFingerprint: 'version:1.14.19',
    version: '1.14.19',
    capabilitySnapshotId,
  };
}

function reusableExecutionProof() {
  return {
    schemaVersion: 1 as const,
    providerId: 'opencode' as const,
    modelId: 'openai/gpt-5.4-mini',
    projectPath: '/repo',
    profileRootKey: 'profile-root',
    projectBehaviorFingerprint: 'behavior-v1',
    managedConfigFingerprint: 'config-v1',
    managedAuthFingerprint: 'auth-v1',
    binaryPath: '/opt/homebrew/bin/opencode',
    binaryFingerprint: 'binary-v1',
    opencodeVersion: '1.14.19',
    capabilitySnapshotId: 'cap-proof',
    credentialMode: 'api' as const,
    reusable: true,
    verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    proofHash: 'proof-hash',
  };
}

function appManagedCandidate(command: OpenCodeLaunchTeamCommandBody, runtimeSessionId: string) {
  return {
    schemaVersion: 1 as const,
    source: 'app_managed_bootstrap' as const,
    teamName: command.teamName,
    memberName: command.members[0]!.name,
    runId: command.runId,
    laneId: command.laneId,
    runtimeSessionId,
    messageID: 'msg-bootstrap-alice',
    contextHash: 'context-alice',
    briefingHash: 'briefing-alice',
    injectionVerifiedAt: '2026-04-21T00:00:00.000Z',
    candidateAt: '2026-04-21T00:00:01.000Z',
  };
}

function successfulOpenCodeLaunchData(
  command: OpenCodeLaunchTeamCommandBody,
  overrides: { model?: string } = {}
): OpenCodeLaunchTeamCommandData {
  const opaque = (value: unknown) => `sha256:${stableHash(value)}` as const;
  const sessionIdentity = (id: string) =>
    `sha256:${createHash('sha256')
      .update(JSON.stringify({ kind: 'opencode-session', id }))
      .digest('hex')}` as const;
  const retainedHostIdentity = {
    hostKeyIdentity: opaque('host'),
    processId: 123,
    processStartedAtMs: 1_776_600_000_001,
    profileScopeIdentity: opaque('profile-scope'),
  };
  return {
    runId: command.runId,
    teamLaunchState: 'ready',
    members: Object.fromEntries(
      command.members.map((member, index) => [
        member.name,
        {
          sessionId: `oc-session-${index + 1}`,
          launchState: 'confirmed_alive' as const,
          runtimePid: 123 + index,
          model: overrides.model ?? 'openai/gpt-5.4-mini',
          evidence: [
            { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'member_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
          ],
        },
      ])
    ),
    warnings: [],
    diagnostics: [],
    launchAttempt: {
      launchAttempt: {
        contractVersion: 1,
        attemptId: command.launchAttempt.attemptId,
        idempotencyKey: 'attemptId',
        payloadHash: command.launchAttempt.payloadHash,
        generation: command.launchAttempt.generation,
        inputDigest: orchestratorVector.wire.response.launchAttempt.inputDigest,
        immutableDigest: orchestratorVector.wire.response.launchAttempt.immutableDigest,
        requestCorrelationDigest:
          orchestratorVector.wire.request.launchAttempt.requestCorrelationDigest,
        outcome: 'succeeded',
        phase: 'complete',
        startedAt: 1_776_600_000_000,
        workDeadlineAt: 1_776_600_060_000,
        absoluteDeadlineAt: 1_776_600_075_000,
        cleanupReserveMs: 15_000,
        elapsedMs: 2_500,
        providerId: command.launchAttempt.providerId,
        modelId: command.launchAttempt.modelId,
        profilePurpose: 'launch_attempt',
        projectIdentity: opaque('project'),
        profileIdentity: retainedHostIdentity.profileScopeIdentity,
        configIdentity: opaque('config'),
        authIdentity: opaque('auth'),
        pluginPolicyIdentity: opaque('plugin'),
        cacheIdentity: opaque('cache'),
        binaryIdentity: opaque('binary'),
        retainedHostIdentity,
        processStartedAtMs: retainedHostIdentity.processStartedAtMs,
      },
      proof: {
        generation: command.launchAttempt.generation,
        attemptId: command.launchAttempt.attemptId,
        parent: command.launchAttempt.parent,
        providerId: command.launchAttempt.providerId,
        modelId: command.launchAttempt.modelId,
        retainedHostIdentity,
        observedMcpTools: [...command.launchAttempt.requiredMcpTools],
        nonceHash: createHash('sha256')
          .update(command.launchAttempt.proofNonce, 'utf8')
          .digest('hex'),
        sessionIdentity: opaque('proof-session'),
        promptMessageIdentity: opaque('proof-prompt'),
        assistantMessageIdentity: opaque('proof-assistant'),
        verifiedAt: 1_776_600_030_000,
        authorizationSource: 'fresh_live_attempt',
        cacheUsed: false,
        requestCorrelationDigest:
          orchestratorVector.wire.request.launchAttempt.requestCorrelationDigest,
      },
      members: {
        committed: command.members.map((member, index) => ({
          memberIdentity: member.memberIdentity,
          sessionIdentity: sessionIdentity(`oc-session-${index + 1}`),
          bootstrapMessageIdentity: opaque(`bootstrap-${index}`),
          commitIdentity: opaque(`commit-${index}`),
        })),
        failed: [],
        pending: [],
        cleanupPending: [],
      },
    },
  };
}

function failedCapabilitySnapshotLaunchData(message: string): OpenCodeLaunchTeamCommandData {
  return {
    runId: 'run-1',
    teamLaunchState: 'failed',
    members: {},
    warnings: [],
    diagnostics: [
      {
        code: 'opencode_bridge',
        severity: 'error',
        message: `OpenCode bridge failed: ${message}`,
      },
    ],
  };
}

function bridgePort(
  readinessResult: OpenCodeTeamLaunchReadiness,
  overrides: Partial<OpenCodeTeamRuntimeBridgePort> = {}
): OpenCodeTeamRuntimeBridgePort {
  return {
    checkOpenCodeTeamLaunchReadiness: vi.fn(async () => readinessResult),
    ...overrides,
  };
}

function launchInvocationFixture() {
  type InvocationAuthority = NonNullable<
    NonNullable<
      Parameters<NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>>[1]
    >['invocationAuthority']
  >;

  let consumed = false;
  let authority: InvocationAuthority | undefined;
  const onBoundary = vi.fn(async () => {
    authority = {
      invoke<T>(invocation: () => T): T {
        if (consumed) throw new Error('Launch invocation authority was already used');
        consumed = true;
        return invocation();
      },
    };
    return authority;
  });
  return {
    get authority(): InvocationAuthority {
      if (!authority) throw new Error('Launch invocation authority was not issued');
      return authority;
    },
    onBoundary,
    dispatch<T>(
      options: Parameters<NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>>[1],
      invocation: () => T
    ): T {
      expect(options?.invocationAuthority).toBe(authority);
      if (!authority) throw new Error('Launch invocation authority was not issued');
      return authority.invoke(invocation);
    },
    expectConsumed(): void {
      expect(onBoundary).toHaveBeenCalledTimes(1);
      expect(Object.keys(authority ?? {})).toEqual(['invoke']);
      if (!authority) throw new Error('Launch invocation authority was not issued');
      const issuedAuthority = authority;
      expect(() => issuedAuthority.invoke(() => undefined)).toThrow(
        'Launch invocation authority was already used'
      );
    },
  };
}

function launchInput(overrides: Partial<TeamRuntimeLaunchInput> = {}): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    cwd: '/repo',
    providerId: 'opencode',
    model: 'openai/gpt-5.4-mini',
    skipPermissions: true,
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
      observedMcpTools: [...REQUIRED_AGENT_TEAMS_APP_TOOL_IDS],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
    ...overrides,
  };
}

function launchSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 3,
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
