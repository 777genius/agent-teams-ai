import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
  type TeamRuntimeLaunchInput,
} from '../../../../src/main/services/team/runtime';

import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { OpenCodeLaunchTeamCommandData } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { PersistedTeamLaunchSnapshot } from '../../../../src/shared/types';
import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

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
            prompt: expect.stringContaining('agent-teams_member_briefing'),
          }),
        ],
      })
    );
    const launchArg = launchOpenCodeTeam.mock.calls[0]?.[0];
    expect(launchArg?.members[0]?.prompt).toContain('Do NOT create local team files');
    expect(launchArg?.members[0]?.prompt).not.toContain('Join team "team-a"');
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
        taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'team-a' }],
      })
    ).resolves.toEqual({
      ok: true,
      providerId: 'opencode',
      memberName: 'bob',
      sessionId: 'oc-session-bob',
      runtimePid: 456,
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
      agent: 'teammate',
    });
    const sentText = sendOpenCodeTeamMessage.mock.calls[0]?.[0]?.text ?? '';
    expect(sentText).toContain('hello bob');
    expect(sentText).toContain('Use teamName="team-a", to="alice", from="bob", text, and summary.');
    expect(sentText).toContain('Action mode for this message: delegate.');
    expect(sentText).toContain(
      'If your reply is about these tasks, include taskRefs exactly: [{"taskId":"task-1","displayId":"abcd1234","teamName":"team-a"}]'
    );
    expect(sentText).toContain('Do not use SendMessage or runtime_deliver_message');
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
    expect(sentText).not.toContain('Use teamName="team-a", to="alice", from="bob", text, and summary.');
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

  it('treats materialized bridge members without session or pid as accepted but not alive', async () => {
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
      agentToolAccepted: true,
      runtimeAlive: false,
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic: 'OpenCode session exists without verified runtime pid',
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
