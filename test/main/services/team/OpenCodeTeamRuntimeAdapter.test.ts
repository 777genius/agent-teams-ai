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

  it('can rely on the launch bridge as the only readiness authority', async () => {
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
        state: 'unknown_error',
        launchAllowed: false,
        diagnostics: ['readiness should be skipped'],
      }),
      { launchOpenCodeTeam }
    );
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    const result = await adapter.launch(launchInput({ skipReadinessPreflight: true }));

    expect(result.teamLaunchState).toBe('clean_success');
    expect(bridge.checkOpenCodeTeamLaunchReadiness).not.toHaveBeenCalled();
    expect(launchOpenCodeTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedModel: 'openai/gpt-5.4-mini',
        expectedCapabilitySnapshotId: null,
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
                'Provider failed with --api-key sk-openroutersecret000000000000 and Bearer abc.def.ghi',
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
      'OpenCode capability snapshot changed between readiness and launch; refreshed readiness and retried once.'
    );
    expect(checkReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].expectedCapabilitySnapshotId).toBe('cap-old');
    expect(launchOpenCodeTeam.mock.calls[1]?.[0].expectedCapabilitySnapshotId).toBe('cap-new');
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
    expect(sentText).toContain('Include source="runtime_delivery"');
    expect(sentText).toContain('Include relayOfMessageId="msg-1"');
    expect(sentText).toContain('Action mode for this message: delegate.');
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
    expect(sentText).toContain('Do not mark the review complete from this prompt alone.');
    expect(sentText).toContain('agent-teams_member_work_sync_report');
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

function successfulOpenCodeLaunchData(): OpenCodeLaunchTeamCommandData {
  return {
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
