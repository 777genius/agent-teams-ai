import { describe, expect, it, vi } from 'vitest';

import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
  type TeamRuntimeLaunchInput,
} from '../../../../src/main/services/team/runtime';

import type { OpenCodeLaunchTeamCommandData } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
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
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: '/repo',
      selectedModel: 'openai/gpt-5.4-mini',
      requireExecutionProbe: true,
    });
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

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: '/repo',
      selectedModel: null,
      requireExecutionProbe: false,
    });
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
          hardFailureReason:
            'OpenCode readiness bridge failed: timeout: OpenCode bridge command timed out',
          diagnostics: [
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
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
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

    const result = await adapter.launch(launchInput({ skipReadinessPreflight: true }));

    expect(result.teamLaunchState).toBe('clean_success');
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'openai/gpt-5.4-mini',
        skipPermissions: true,
        expectedCapabilitySnapshotId: 'cap-1',
      })
    );
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
      launchOpenCodeTeam: vi.fn(async () => successfulOpenCodeLaunchData()),
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await adapter.launch(
      launchInput({
        model: 'cursor-acp/auto',
        runtimeOnly: true,
      })
    );

    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: '/repo',
      selectedModel: 'cursor-acp/auto',
      requireExecutionProbe: true,
    });
  });

  it('blocks a local model before the state-changing launch when team tool coordination fails', async () => {
    const launchOpenCodeTeam = vi.fn(async () => successfulOpenCodeLaunchData());
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

  it('blocks an incompatible local member model even when the lane default is remote', async () => {
    const launchOpenCodeTeam = vi.fn(async () => successfulOpenCodeLaunchData());
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
    const launchOpenCodeTeam = vi.fn(async () => successfulOpenCodeLaunchData());
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
    const launchOpenCodeTeam = vi.fn(async () => successfulOpenCodeLaunchData());
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
    const launchOpenCodeTeam = vi.fn(async () =>
      successfulOpenCodeLaunchData({ model: 'ollama/qwen3:4b' })
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
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async () => successfulOpenCodeLaunchData());
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
      })
    );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(bridge.checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledWith({
      projectPath: worktreePath,
      selectedModel: 'openai/gpt-5.4-mini',
      requireExecutionProbe: true,
    });
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: worktreePath,
        expectedCapabilitySnapshotId: 'cap-worktree',
        members: [expect.objectContaining({ name: 'alice' })],
      })
    );
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

  it('retries transient MCP readiness transport failures before prepare succeeds', async () => {
    const firstReadiness = readiness({
      state: 'mcp_unavailable',
      launchAllowed: false,
      diagnostics: [
        'OpenCode /experimental/tool/ids unavailable - Unable to connect. Is the computer able to access the url?',
      ],
      missing: ['runtime_deliver_message'],
    });
    const finalReadiness = readiness({
      state: 'ready',
      launchAllowed: true,
      diagnostics: ['OpenCode readiness recovered'],
    });
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(firstReadiness)
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

  it('retries unknown readiness failures only when diagnostics show transport failure', async () => {
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(
        readiness({
          state: 'unknown_error',
          launchAllowed: false,
          diagnostics: ['OpenCode readiness bridge failed: fetch failed'],
        })
      )
      .mockResolvedValueOnce(readiness({ state: 'ready', launchAllowed: true }));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.prepare(launchInput());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        providerId: 'opencode',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('retries the OpenCode inventory and config timeout seen during multi-member launch', async () => {
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(
        readiness({
          state: 'unknown_error',
          launchAllowed: false,
          diagnostics: [
            'Failed to query OpenCode agents: OpenCode command timed out after 10000ms',
            'Failed to query OpenCode models: OpenCode command timed out after 10000ms',
            '/config request failed: request timed out after 15000ms',
            'OpenCode raw model id "zai-coding-plan/glm-5.1" was not found in live provider catalog',
          ],
        })
      )
      .mockResolvedValueOnce(readiness({ state: 'ready', launchAllowed: true }));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.prepare(launchInput());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);

      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        providerId: 'opencode',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('returns the final readiness failure after transient retries are exhausted', async () => {
    const finalReadiness = readiness({
      state: 'mcp_unavailable',
      launchAllowed: false,
      diagnostics: ['Final OpenCode /experimental/tool/ids unavailable - ECONNRESET'],
      missing: ['final transport missing'],
    });
    const checkReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(
        readiness({
          state: 'mcp_unavailable',
          launchAllowed: false,
          diagnostics: ['First OpenCode /experimental/tool/ids unavailable - Unable to connect'],
        })
      )
      .mockResolvedValueOnce(
        readiness({
          state: 'unknown_error',
          launchAllowed: false,
          diagnostics: ['Second OpenCode readiness bridge failed: socket hang up'],
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
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        providerId: 'opencode',
        reason: 'mcp_unavailable',
        retryable: true,
        diagnostics: [
          'Final OpenCode /experimental/tool/ids unavailable - ECONNRESET',
          'final transport missing',
        ],
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

  it('launch retries readiness before bridge launch and uses the fresh runtime snapshot', async () => {
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
    >(() => Promise.resolve(successfulOpenCodeLaunchData()));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot,
      launchOpenCodeTeam,
    });

    vi.useFakeTimers();
    try {
      const resultPromise = adapter.launch(launchInput());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(750);

      await expect(resultPromise).resolves.toMatchObject({
        teamLaunchState: 'clean_success',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(getLastOpenCodeRuntimeSnapshot).toHaveBeenCalledWith(
      '/repo',
      'openai/gpt-5.4-mini',
      true
    );
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCapabilitySnapshotId: 'cap-fresh',
      })
    );
  });

  it('reuses an exact short-lived execution proof from prepare during launch', async () => {
    const executionProof = reusableExecutionProof();
    const checkReadiness = vi.fn(async () =>
      readiness({ state: 'ready', launchAllowed: true, executionProof })
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(() => Promise.resolve(successfulOpenCodeLaunchData()));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-proof')),
      launchOpenCodeTeam,
    });

    await adapter.prepare(launchInput());
    await adapter.launch(launchInput());

    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(expect.objectContaining({ executionProof }));
  });

  it('does not reuse OAuth execution proof across prepare and launch', async () => {
    const oauthProof = {
      ...reusableExecutionProof(),
      credentialMode: 'oauth' as const,
      reusable: false,
    };
    const checkReadiness = vi.fn(async () =>
      readiness({ state: 'ready', launchAllowed: true, executionProof: oauthProof })
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(() => Promise.resolve(successfulOpenCodeLaunchData()));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-proof')),
      launchOpenCodeTeam,
    });

    await adapter.prepare(launchInput());
    await adapter.launch(launchInput());

    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.not.objectContaining({ executionProof: expect.anything() })
    );
  });

  it('singleflights concurrent readiness for the same project model and depth', async () => {
    let resolveReadiness!: (value: OpenCodeTeamLaunchReadiness) => void;
    const checkReadiness = vi.fn(
      () =>
        new Promise<OpenCodeTeamLaunchReadiness>((resolve) => {
          resolveReadiness = resolve;
        })
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
    });

    const first = adapter.prepare(launchInput());
    const second = adapter.prepare(launchInput());
    resolveReadiness(
      readiness({
        state: 'ready',
        launchAllowed: true,
        executionProof: reusableExecutionProof(),
      })
    );

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('passes manual tool approval intent with a fresh capability precondition', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(() => Promise.resolve(successfulOpenCodeLaunchData()));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: vi.fn(async () =>
        readiness({ state: 'ready', launchAllowed: true })
      ),
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-manual')),
      launchOpenCodeTeam,
    });

    await expect(adapter.launch(launchInput({ skipPermissions: false }))).resolves.toMatchObject({
      teamLaunchState: 'clean_success',
    });

    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        skipPermissions: false,
        expectedCapabilitySnapshotId: 'cap-manual',
      })
    );
  });

  it('launches model-less Default selections with the readiness-resolved model', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async () => successfulOpenCodeLaunchData({ model: 'opencode/big-pickle' }));
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
      })
    );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'opencode/big-pickle',
      })
    );
    expect(result.members.alice?.model).toBe('opencode/big-pickle');
  });

  it('uses concrete member diagnostics as failed OpenCode hard failure reasons', async () => {
    const concreteReason =
      'Latest assistant message msg_123 failed with APIError - Insufficient credits. Add more using https://openrouter.ai/settings/credits';
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'failed',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'failed',
              model: 'openai/gpt-5.4-mini',
              diagnostics: ['OpenCode bridge reported member launch failure', concreteReason],
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice).toMatchObject({
      launchState: 'failed_to_start',
      hardFailureReason: concreteReason,
    });
  });

  it('prefers actionable provider errors over timeout and inventory diagnostics', async () => {
    const actionableReason =
      'Latest assistant message msg_456 failed with APIError - This model is not available on the chat endpoint';
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'failed',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'failed',
              model: 'xai/grok-imagine-image-quality',
              diagnostics: [
                'OpenCode command timed out after 10000ms',
                'CLI-authenticated providers missing from live host (github-copilot)',
                actionableReason,
              ],
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice?.hardFailureReason).toBe(actionableReason);
  });

  it('falls back to bridge error diagnostics when member failure details are generic', async () => {
    const bridgeError = 'Provider runtime returned a concrete launch error';
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'failed',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'failed',
              model: 'openai/gpt-5.4-mini',
              diagnostics: ['OpenCode bridge reported member launch failure'],
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [{ code: 'provider_error', severity: 'error', message: bridgeError }],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice?.hardFailureReason).toBe(bridgeError);
  });

  it('redacts secret-like values in selected OpenCode failure reasons', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'failed',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'failed',
              model: 'openai/gpt-5.4-mini',
              diagnostics: [
                'Provider failed with --api-key test-fixture-literal and Bearer abc.def.ghi',
              ],
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), { launchOpenCodeTeam })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice?.hardFailureReason).toBe(
      'Provider failed with --api-key [redacted] and Bearer [redacted]'
    );
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

  it('maps ready bridge launch data to successful runtime evidence only with required checkpoints', async () => {
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(
      async () =>
        ({
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
        }) satisfies OpenCodeLaunchTeamCommandData
    );
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
      })
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
          runtimePid: 123,
          hardFailure: false,
        },
      },
    });
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCapabilitySnapshotId: 'cap-1',
        manifestHighWatermark: null,
        members: [
          expect.objectContaining({
            name: 'alice',
            prompt: expect.stringContaining('AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1'),
          }),
        ],
      })
    );
    const launchArg = launchOpenCodeTeam.mock.calls[0]?.[0];
    expect(launchArg?.members[0]?.prompt).toContain('Do NOT create local team files');
    expect(launchArg?.members[0]?.prompt).toContain(
      'That bootstrap restriction is only about team registry/startup files'
    );
    expect(launchArg?.members[0]?.prompt).toContain(
      'you may inspect, read/search, and edit files in the project working directory as your available tools allow'
    );
    expect(launchArg?.members[0]?.prompt).toContain('Launch bootstrap is a silent attach');
    expect(launchArg?.members[0]?.prompt).toContain('stay idle silently');
    expect(launchArg?.members[0]?.prompt).not.toContain('agent-teams_member_briefing');
    expect(launchArg?.members[0]?.prompt).not.toContain('Join team "team-a"');
  });

  it('refreshes readiness and retries once when the launch handshake sees a newer capability snapshot', async () => {
    const { result, checkReadiness, launchOpenCodeTeam } =
      await launchWithStaleCapabilitySnapshotRecovery('Bridge server capability snapshot mismatch');

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.warnings).toContain(
      'OpenCode capability snapshot changed between readiness and launch; refreshed readiness and retried launch.'
    );
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].expectedCapabilitySnapshotId).toBe('cap-old');
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].expectedCapabilitySnapshotId).toBe('cap-new');
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].capabilitySnapshotRecoveryAttemptId).toBe(
      undefined
    );
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].capabilitySnapshotRecoveryAttemptId).toMatch(
      /^opencode-capability-recovery-/
    );
  });

  it('forces a readiness refresh after capability mismatch even when the execution proof is reusable', async () => {
    let readinessCalls = 0;
    let capabilitySnapshotId = 'cap-old';
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => {
        readinessCalls += 1;
        capabilitySnapshotId = readinessCalls === 1 ? 'cap-old' : 'cap-new';
        return Promise.resolve(
          readiness({
            state: 'ready',
            launchAllowed: true,
            executionProof: {
              ...reusableExecutionProof(),
              capabilitySnapshotId,
            },
          })
        );
      }
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((input) =>
      Promise.resolve(
        input.expectedCapabilitySnapshotId === 'cap-old'
          ? failedCapabilitySnapshotLaunchData('Bridge server capability snapshot mismatch')
          : successfulOpenCodeLaunchData()
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot(capabilitySnapshotId)),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(
      launchOpenCodeTeam.mock.calls.map((call) => call[0].expectedCapabilitySnapshotId)
    ).toEqual(['cap-old', 'cap-new']);
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].executionProof).toMatchObject({
      capabilitySnapshotId: 'cap-new',
    });
  });

  it('refreshes readiness and retries once when the launch command sees a newer capability snapshot', async () => {
    const { result, checkReadiness, launchOpenCodeTeam } =
      await launchWithStaleCapabilitySnapshotRecovery(
        'OpenCode bridge capability snapshot precondition mismatch'
      );

    expect(result.teamLaunchState).toBe('clean_success');
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].expectedCapabilitySnapshotId).toBe('cap-old');
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].expectedCapabilitySnapshotId).toBe('cap-new');
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].capabilitySnapshotRecoveryAttemptId).toMatch(
      /^opencode-capability-recovery-/
    );
  });

  it('keeps refreshing bounded capability snapshot churn until launch observes the current snapshot', async () => {
    let readinessCalls = 0;
    const capabilitySnapshots = ['cap-1', 'cap-2', 'cap-3', 'cap-4'];
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => {
        readinessCalls += 1;
        return Promise.resolve(readiness({ state: 'ready', launchAllowed: true }));
      }
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((input) =>
      Promise.resolve(
        input.expectedCapabilitySnapshotId === 'cap-3'
          ? successfulOpenCodeLaunchData()
          : failedCapabilitySnapshotLaunchData('Bridge server capability snapshot mismatch')
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() =>
        runtimeSnapshot(
          capabilitySnapshots[Math.max(0, Math.min(readinessCalls - 1, 3))] ?? 'cap-4'
        )
      ),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(result.warnings).toContain(
      'OpenCode capability snapshot changed between readiness and launch; refreshed readiness and retried launch.'
    );
    expect(checkReadiness).toHaveBeenCalledTimes(3);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(3);
    expect(
      launchOpenCodeTeam.mock.calls.map((call) => call[0].expectedCapabilitySnapshotId)
    ).toEqual(['cap-1', 'cap-2', 'cap-3']);
    expect(
      launchOpenCodeTeam.mock.calls
        .slice(1)
        .every((call) =>
          /^opencode-capability-recovery-/.test(call[0].capabilitySnapshotRecoveryAttemptId ?? '')
        )
    ).toBe(true);
  });

  it('uses a fresh recovery attempt id when capability refresh returns the same snapshot', async () => {
    let readinessCalls = 0;
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => {
        readinessCalls += 1;
        return Promise.resolve(readiness({ state: 'ready', launchAllowed: true }));
      }
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((input) =>
      Promise.resolve(
        input.capabilitySnapshotRecoveryAttemptId
          ? successfulOpenCodeLaunchData()
          : failedCapabilitySnapshotLaunchData(
              'OpenCode bridge capability snapshot precondition mismatch'
            )
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-1')),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(readinessCalls).toBe(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].expectedCapabilitySnapshotId).toBe('cap-1');
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].expectedCapabilitySnapshotId).toBe('cap-1');
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].capabilitySnapshotRecoveryAttemptId).toBe(
      undefined
    );
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].capabilitySnapshotRecoveryAttemptId).toMatch(
      /^opencode-capability-recovery-/
    );
  });

  it('retries pre-launch capability mismatch reported in member diagnostics', async () => {
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => Promise.resolve(readiness({ state: 'ready', launchAllowed: true }))
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >((input) =>
      Promise.resolve(
        input.capabilitySnapshotRecoveryAttemptId
          ? successfulOpenCodeLaunchData()
          : failedMemberCapabilitySnapshotLaunchData(
              'OpenCode bridge capability snapshot precondition mismatch'
            )
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-1')),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('clean_success');
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].capabilitySnapshotRecoveryAttemptId).toMatch(
      /^opencode-capability-recovery-/
    );
  });

  it('does not retry a successful launch just because stale diagnostics mention pre-launch mismatch', async () => {
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => Promise.resolve(readiness({ state: 'ready', launchAllowed: true }))
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(() =>
      Promise.resolve({
        ...successfulOpenCodeLaunchData(),
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

  it('does not retry post-result capability snapshot mismatch', async () => {
    const { result, checkReadiness, launchOpenCodeTeam } =
      await launchWithStaleCapabilitySnapshotRecovery(
        'OpenCode bridge capability snapshot mismatch'
      );

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toContain(
      'error:opencode_bridge: OpenCode bridge failed: OpenCode bridge capability snapshot mismatch'
    );
  });

  it('keeps the original precondition mismatch when the recovery retry also fails', async () => {
    const checkReadiness = vi.fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>(
      () => Promise.resolve(readiness({ state: 'ready', launchAllowed: true }))
    );
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(() =>
      Promise.resolve(
        failedCapabilitySnapshotLaunchData(
          'OpenCode bridge capability snapshot precondition mismatch'
        )
      )
    );
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: checkReadiness,
      getLastOpenCodeRuntimeSnapshot: vi.fn(() => runtimeSnapshot('cap-1')),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(checkReadiness).toHaveBeenCalledTimes(4);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(4);
    expect(result.diagnostics).toContain(
      'error:opencode_bridge: OpenCode bridge failed: OpenCode bridge capability snapshot precondition mismatch'
    );
    expect(result.diagnostics.join('\n')).not.toContain(
      'OpenCode bridge command cannot be retried from status failed'
    );
  });

  it('does not mark the lane clean_success when ready bridge data omits an expected member', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
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
          durableCheckpoints: [
            { name: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
            { name: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { name: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
          ],
          manifestHighWatermark: null,
          runtimeStoreManifestHighWatermark: null,
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam,
      })
    );

    const result = await adapter.launch({
      ...launchInput(),
      expectedMembers: [
        ...launchInput().expectedMembers,
        {
          name: 'bob',
          providerId: 'opencode',
          model: 'openai/gpt-5.4-mini',
          cwd: '/repo',
        },
      ],
    });

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.launchPhase).toBe('active');
    expect(result.members.alice?.launchState).toBe('confirmed_alive');
    expect(result.members.bob).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      hardFailure: false,
    });
    expect(result.members.bob?.diagnostics).toContain(
      'OpenCode bridge response did not include bob; keeping the member pending until lane state materializes.'
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

  it('keeps missing bridge members pending while reconcile is still launching', async () => {
    const reconcileOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'launching',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'confirmed_alive',
              model: 'openai/gpt-5.4-mini',
              evidence: [{ kind: 'member_ready', observedAt: '2026-04-21T00:00:00.000Z' }],
            },
          },
          warnings: [],
          diagnostics: [],
          durableCheckpoints: [],
          manifestHighWatermark: null,
          runtimeStoreManifestHighWatermark: null,
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        reconcileOpenCodeTeam,
      })
    );

    const result = await adapter.reconcile({
      runId: 'run-1',
      teamName: 'team-a',
      providerId: 'opencode',
      expectedMembers: [
        ...launchInput().expectedMembers,
        {
          name: 'bob',
          providerId: 'opencode',
          model: 'openai/gpt-5.4-mini',
          cwd: '/repo',
        },
      ],
      previousLaunchState: launchSnapshot(),
      reason: 'startup_recovery',
    });

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.members.alice?.launchState).toBe('confirmed_alive');
    expect(result.members.bob).toMatchObject({
      providerId: 'opencode',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      agentToolAccepted: false,
      bootstrapConfirmed: false,
      hardFailure: false,
    });
    expect(result.members.bob?.diagnostics).toContain(
      'OpenCode bridge response did not include bob; keeping the member pending until lane state materializes.'
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

  it('maps permission-blocked bridge members to runtime_pending_permission instead of bootstrap pending', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'permission_blocked',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'permission_blocked',
              pendingPermissionRequestIds: ['perm-1', 'perm-1', 'perm-2'],
              pendingPermissions: [
                {
                  requestId: 'perm-1',
                  sessionId: 'oc-session-1',
                  tool: 'bash',
                  title: 'Run git status',
                  kind: 'tool',
                  raw: {
                    requestID: 'perm-1',
                    sessionID: 'oc-session-1',
                    tool: 'bash',
                    title: 'Run git status',
                    kind: 'tool',
                    patterns: ['git status'],
                  },
                },
              ],
              diagnostics: ['waiting for permission approval'],
              runtimePid: 123,
              model: 'openai/gpt-5.4-mini',
              evidence: [
                { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
                { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
                { kind: 'permission_blocked', observedAt: '2026-04-21T00:00:00.000Z' },
              ],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
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
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result).toMatchObject({
      teamLaunchState: 'partial_pending',
      members: {
        alice: {
          providerId: 'opencode',
          launchState: 'runtime_pending_permission',
          pendingPermissionRequestIds: ['perm-1', 'perm-2'],
          pendingPermissions: [
            {
              providerId: 'opencode',
              requestId: 'perm-1',
              sessionId: 'oc-session-1',
              tool: 'bash',
              title: 'Run git status',
            },
          ],
          runtimeAlive: false,
          agentToolAccepted: true,
          livenessKind: 'permission_blocked',
          bootstrapConfirmed: false,
          hardFailure: false,
        },
      },
    });
    expect(result).toMatchObject({
      members: {
        alice: {
          diagnostics: expect.arrayContaining(['waiting for permission approval']),
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

  it('does not mark created bridge members without runtimePid as runtimeAlive', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'launching',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'created',
              model: 'openai/gpt-5.4-mini',
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam,
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic: 'OpenCode session exists without verified runtime pid',
    });
  });

  it('keeps created bridge runtimePid provisional until local process verification', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'launching',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'created',
              runtimePid: 123,
              model: 'openai/gpt-5.4-mini',
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam,
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: false,
      livenessKind: 'runtime_process_candidate',
      runtimePid: 123,
      runtimeDiagnostic:
        'OpenCode runtime pid reported by bridge without local process verification',
    });
  });

  it('does not treat bridge members without session or pid as runtime candidates', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'launching',
          members: {
            alice: {
              sessionId: '',
              launchState: 'created',
              model: 'openai/gpt-5.4-mini',
              evidence: [],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(
      bridgePort(readiness({ state: 'ready', launchAllowed: true }), {
        launchOpenCodeTeam,
      })
    );

    const result = await adapter.launch(launchInput());

    expect(result.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: false,
      runtimeAlive: false,
      livenessKind: 'registered_only',
      runtimeDiagnostic: 'OpenCode bridge did not report a runtime session or pid for this member',
    });
  });

  it('keeps missing bridge members in bootstrap pending even when another member blocks on permission', async () => {
    const launchOpenCodeTeam = vi.fn(
      async () =>
        ({
          runId: 'run-1',
          teamLaunchState: 'permission_blocked',
          members: {
            alice: {
              sessionId: 'oc-session-1',
              launchState: 'permission_blocked',
              pendingPermissionRequestIds: ['perm-1'],
              diagnostics: ['waiting for permission approval'],
              runtimePid: 123,
              model: 'openai/gpt-5.4-mini',
              evidence: [
                { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
                { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
                { kind: 'permission_blocked', observedAt: '2026-04-21T00:00:00.000Z' },
              ],
            },
          },
          warnings: [],
          diagnostics: [],
        }) satisfies OpenCodeLaunchTeamCommandData
    );
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
      })
    );

    const result = await adapter.launch(
      launchInput({
        expectedMembers: [
          ...launchInput().expectedMembers,
          {
            name: 'bob',
            providerId: 'opencode',
            model: 'openai/gpt-5.4-mini',
            cwd: '/repo',
          },
        ],
      })
    );

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.members.alice?.launchState).toBe('runtime_pending_permission');
    expect(result.members.bob).toMatchObject({
      providerId: 'opencode',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      agentToolAccepted: false,
      bootstrapConfirmed: false,
      hardFailure: false,
      pendingPermissionRequestIds: undefined,
    });
    expect(result.members.bob?.diagnostics).toContain(
      'OpenCode bridge response did not include bob; keeping the member pending until lane state materializes.'
    );
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
      input.expectedCapabilitySnapshotId === 'cap-old'
        ? failedCapabilitySnapshotLaunchData(message)
        : successfulOpenCodeLaunchData()
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

function successfulOpenCodeLaunchData(
  overrides: { model?: string } = {}
): OpenCodeLaunchTeamCommandData {
  return {
    runId: 'run-1',
    teamLaunchState: 'ready',
    members: {
      alice: {
        sessionId: 'oc-session-1',
        launchState: 'confirmed_alive',
        runtimePid: 123,
        model: overrides.model ?? 'openai/gpt-5.4-mini',
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

function failedMemberCapabilitySnapshotLaunchData(message: string): OpenCodeLaunchTeamCommandData {
  return {
    runId: 'run-1',
    teamLaunchState: 'failed',
    members: {
      alice: {
        sessionId: 'oc-session-1',
        launchState: 'failed',
        runtimePid: 123,
        model: 'openai/gpt-5.4-mini',
        evidence: [],
        diagnostics: [message],
      },
    },
    warnings: [],
    diagnostics: [],
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
