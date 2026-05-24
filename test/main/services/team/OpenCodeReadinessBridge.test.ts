import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeReadinessBridge,
  type OpenCodeReadinessBridgeCommandExecutor,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

import type {
  OpenCodeBridgeCommandName,
  OpenCodeBridgeFailureKind,
  OpenCodeBridgeResult,
  OpenCodeBridgeSuccess,
  OpenCodeLaunchTeamCommandData,
  OpenCodeSendMessageCommandData,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';

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

  it('adds copyable support diagnostics for bridge no-output contract failures', async () => {
    const executor = fakeExecutor(
      bridgeFailure(
        'contract_violation',
        'Bridge stdout was empty',
        [
          {
            id: 'diag-empty-stdout',
            type: 'opencode_bridge_contract_violation',
            providerId: 'opencode',
            severity: 'error',
            message: 'Bridge stdout was empty',
            data: {
              command: 'opencode.readiness',
              requestId: 'req-1',
              attempts: 2,
              exitCode: 0,
              timedOut: false,
              stdoutBytes: 0,
              stderrBytes: 27,
              outputSource: 'none',
              outputFileBytes: 0,
              outputReadError: 'ENOENT',
              stderrPreview: 'token=secret',
            },
            createdAt: '2026-04-21T12:00:00.000Z',
          },
        ],
        {
          attempts: 2,
          outputReadError: 'ENOENT',
        }
      )
    );
    const bridge = new OpenCodeReadinessBridge(executor, {
      appVersion: '1.3.0-test',
    });

    const result = await bridge.checkOpenCodeTeamLaunchReadiness({
      projectPath: 'D:\\project\\03_codex',
      selectedModel: 'qwen3.6-2b',
      requireExecutionProbe: false,
    });

    expect(result.supportDiagnostics).toEqual([
      expect.objectContaining({
        id: 'diag-empty-stdout',
        providerId: 'opencode',
        kind: 'opencode_bridge_no_output',
        severity: 'error',
        title: 'OpenCode runtime check returned no output',
        summary: 'OpenCode readiness bridge exited without returning diagnostic JSON.',
      }),
    ]);
    expect(result.supportDiagnostics?.[0]?.copyText).toContain(
      'Agent Teams OpenCode diagnostics'
    );
    expect(result.supportDiagnostics?.[0]?.copyText).toContain('outputReadError: ENOENT');
    expect(result.supportDiagnostics?.[0]?.copyText).toContain('appVersion: 1.3.0-test');
    expect(result.supportDiagnostics?.[0]?.copyText).toContain('selectedModel: qwen3.6-2b');
    expect(result.supportDiagnostics?.[0]?.copyText).toContain('token=[redacted]');
    expect(result.supportDiagnostics?.[0]?.copyText).not.toContain('token=secret');
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

  it('gives observeMessageDelivery enough time for OpenCode plain-text fallback reconciliation', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess({
        command: 'opencode.observeMessageDelivery',
        requestId: 'observe-req-1',
        data: {
          observed: true,
          memberName: 'tom',
          sessionId: 'session-tom',
          diagnostics: [],
          responseObservation: {
            state: 'responded_plain_text',
            deliveredUserMessageId: 'user-message-1',
            assistantMessageId: 'assistant-message-1',
            toolCallNames: ['message_send'],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: 'plain_assistant_text',
            latestAssistantPreview: 'GAUNTLET_CONCURRENT_TOM_OK_1',
            reason: 'assistant_replied_with_plain_text',
          },
        },
      })
    );
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.observeOpenCodeTeamMessageDelivery({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'primary',
        runId: 'run-1',
        projectPath: '/repo',
        memberName: 'tom',
        messageId: 'gauntlet-concurrent-tom-1',
        prePromptCursor: 'cursor-before',
      })
    ).resolves.toMatchObject({
      observed: true,
      responseObservation: {
        state: 'responded_plain_text',
        latestAssistantPreview: 'GAUNTLET_CONCURRENT_TOM_OK_1',
      },
    });

    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.observeMessageDelivery',
      {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'primary',
        runId: 'run-1',
        projectPath: '/repo',
        memberName: 'tom',
        messageId: 'gauntlet-concurrent-tom-1',
        prePromptCursor: 'cursor-before',
      },
      {
        cwd: '/repo',
        timeoutMs: 20_000,
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
        deliveryContextPath: '/tmp/claude-team-opencode-ledger-context-test/delivery-context.json',
        deliveryContextHash: 'a'.repeat(64),
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
        deliveryContextPath: '/tmp/claude-team-opencode-ledger-context-test/delivery-context.json',
        deliveryContextHash: 'a'.repeat(64),
      },
      {
        cwd: '/repo',
        timeoutMs: 45_000,
        stdoutLimitBytes: 2_000_000,
        stderrLimitBytes: 512_000,
      }
    );
  });

  it('does not query commandStatus on successful OpenCode sendMessage', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess({
        command: 'opencode.sendMessage',
        requestId: 'send-req-1',
        data: {
          accepted: true,
          memberName: 'bob',
          sessionId: 'session-bob',
          diagnostics: [],
        },
      })
    );
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
    });

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.sendMessage',
      expect.objectContaining({
        deliveryAttemptId: 'ledger-1:1:payload',
        payloadHash: expect.any(String),
      }),
      expect.objectContaining({
        cwd: '/repo',
        timeoutMs: 45_000,
        requestId: expect.stringMatching(/^opencode-send-/),
      })
    );
  });

  it('falls back to observed sendMessage when acceptance capability is missing', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'OpenCode delivery acceptance mode is required, but the orchestrator does not advertise contract version 1.'
        )
      )
      .mockResolvedValueOnce(
        bridgeCommandSuccess({
          command: 'opencode.sendMessage',
          requestId: 'send-req-observed',
          data: {
            accepted: true,
            memberName: 'bob',
            sessionId: 'session-bob',
            diagnostics: [],
          },
        })
      );
    const executor = {
      execute: execute as unknown as OpenCodeReadinessBridgeCommandExecutor['execute'] &
        ReturnType<typeof vi.fn>,
    };
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
      diagnostics: [
        expect.objectContaining({
          code: 'opencode_accept_fast_capability_missing',
          severity: 'warning',
        }),
      ],
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ settlementMode: 'acceptance' });
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ settlementMode: 'observed' });
    expect(execute.mock.calls[1]?.[2]).toMatchObject({
      requestId: expect.stringMatching(/-observed$/),
    });
  });

  it('does not fall back to observed mode when forced session refresh contract is missing', async () => {
    const execute = vi.fn().mockRejectedValueOnce(
      new Error(
        'OpenCode delivery acceptance mode is required, but the orchestrator does not advertise contract version 2.'
      )
    );
    const executor = {
      execute: execute as unknown as OpenCodeReadinessBridgeCommandExecutor['execute'] &
        ReturnType<typeof vi.fn>,
    };
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: false,
      memberName: 'bob',
      responseObservation: {
        state: 'session_stale',
      },
      diagnostics: [
        expect.objectContaining({
          code: 'opencode_force_session_refresh_contract_missing',
          severity: 'error',
        }),
      ],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      settlementMode: 'acceptance',
      forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
    });
  });

  it('includes forced session refresh reason in send payload hash', async () => {
    const executor = fakeSequenceExecutor([
      bridgeCommandSuccess({
        command: 'opencode.sendMessage',
        requestId: 'send-req-1',
        data: {
          accepted: true,
          memberName: 'bob',
          sessionId: 'session-bob-1',
          diagnostics: [],
        },
      }),
      bridgeCommandSuccess({
        command: 'opencode.sendMessage',
        requestId: 'send-req-2',
        data: {
          accepted: true,
          memberName: 'bob',
          sessionId: 'session-bob-2',
          diagnostics: [],
        },
      }),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);
    const base = {
      teamId: 'team-a',
      teamName: 'team-a',
      laneId: 'secondary:opencode:bob',
      projectPath: '/repo',
      memberName: 'bob',
      text: 'hello',
      messageId: 'message-1',
      deliveryAttemptId: 'ledger-1:1:payload',
    };

    await bridge.sendOpenCodeTeamMessage(base);
    await bridge.sendOpenCodeTeamMessage({
      ...base,
      forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
    });

    const firstBody = executor.execute.mock.calls[0]?.[1] as { payloadHash?: string };
    const secondBody = executor.execute.mock.calls[1]?.[1] as {
      payloadHash?: string;
      forceSessionRefreshReason?: string;
    };
    expect(secondBody.forceSessionRefreshReason).toBe(
      'opencode_app_mcp_transport_changed:old->new'
    );
    expect(firstBody.payloadHash).toEqual(expect.any(String));
    expect(secondBody.payloadHash).toEqual(expect.any(String));
    expect(secondBody.payloadHash).not.toBe(firstBody.payloadHash);
  });

  it('recovers accepted OpenCode sendMessage after bridge timeout through commandStatus by default', async () => {
    const executor = fakeSequenceExecutor([
      bridgeFailure('timeout', 'OpenCode bridge command timed out', []),
      bridgeCommandSuccess({
        command: 'opencode.commandStatus',
        requestId: 'status-req-1',
        data: {
          status: 'prompt_accepted',
          safeToRetry: false,
          accepted: true,
          sessionId: 'session-bob',
          runtimePromptMessageId: 'msg_prompt_1',
          diagnostics: ['OpenCode prompt acceptance recovered from offline_sqlite.'],
        },
      }),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'opencode_send_recovered_after_bridge_timeout',
        }),
      ]),
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute.mock.calls[1]).toEqual([
      'opencode.commandStatus',
      expect.objectContaining({
        originalCommand: 'opencode.sendMessage',
        originalRequestId: 'req-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        payloadHash: expect.any(String),
      }),
      {
        cwd: '/repo',
        timeoutMs: 5_000,
      },
    ]);
  });

  it('recovers accepted OpenCode sendMessage after empty bridge output through commandStatus', async () => {
    const executor = fakeSequenceExecutor([
      bridgeFailure('contract_violation', 'Bridge stdout was empty', [
        {
          id: 'diag-empty-output',
          type: 'opencode_bridge_contract_violation',
          providerId: 'opencode',
          severity: 'error',
          message: 'Bridge stdout was empty',
          data: {
            command: 'opencode.sendMessage',
            outputSource: 'none',
            outputReadError: 'ENOENT',
          },
          createdAt: '2026-04-21T12:00:00.000Z',
        },
      ]),
      bridgeCommandSuccess({
        command: 'opencode.commandStatus',
        requestId: 'status-req-empty-output',
        data: {
          status: 'prompt_accepted',
          safeToRetry: false,
          accepted: true,
          sessionId: 'session-bob',
          runtimePromptMessageId: 'msg_prompt_1',
          diagnostics: ['OpenCode prompt acceptance recovered from command status.'],
        },
      }),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'opencode_send_recovered_after_bridge_empty_output',
        }),
      ]),
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute.mock.calls[1]).toEqual([
      'opencode.commandStatus',
      expect.objectContaining({
        originalCommand: 'opencode.sendMessage',
        originalRequestId: 'req-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        payloadHash: expect.any(String),
      }),
      {
        cwd: '/repo',
        timeoutMs: 5_000,
      },
    ]);
  });

  it('does not query commandStatus for non-timeout OpenCode sendMessage failures', async () => {
    const executor = fakeExecutor(bridgeFailure('provider_error', 'OpenCode send failed', []));
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: false,
      memberName: 'bob',
      diagnostics: [
        expect.objectContaining({
          code: 'provider_error',
        }),
      ],
    });

    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('keeps the timeout failure path when timeout commandStatus is unknown', async () => {
    const executor = fakeSequenceExecutor([
      bridgeFailure('timeout', 'OpenCode bridge command timed out', []),
      bridgeCommandSuccess({
        command: 'opencode.commandStatus',
        requestId: 'status-req-1',
        data: {
          status: 'unknown',
          safeToRetry: false,
          accepted: false,
          diagnostics: ['No orchestrator-side command outcome record matched the requested OpenCode command.'],
        },
      }),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: false,
      memberName: 'bob',
      diagnostics: [
        expect.objectContaining({
          code: 'timeout',
        }),
      ],
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps the timeout failure path when timeout commandStatus is unavailable', async () => {
    const executor = fakeSequenceExecutor([
      bridgeFailure('timeout', 'OpenCode bridge command timed out', []),
      bridgeFailure('timeout', 'OpenCode commandStatus timed out', []),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: false,
      memberName: 'bob',
      diagnostics: [
        expect.objectContaining({
          code: 'timeout',
        }),
      ],
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps the timeout failure path when timeout commandStatus reports precondition mismatch', async () => {
    const executor = fakeSequenceExecutor([
      bridgeFailure('timeout', 'OpenCode bridge command timed out', []),
      bridgeCommandSuccess({
        command: 'opencode.commandStatus',
        requestId: 'status-req-1',
        data: {
          status: 'precondition_mismatch',
          safeToRetry: false,
          accepted: false,
          diagnostics: ['OpenCode command status payloadHash mismatch.'],
        },
      }),
    ]);
    const bridge = new OpenCodeReadinessBridge(executor);

    await expect(
      bridge.sendOpenCodeTeamMessage({
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
      })
    ).resolves.toMatchObject({
      accepted: false,
      memberName: 'bob',
      diagnostics: [
        expect.objectContaining({
          code: 'timeout',
        }),
      ],
    });

    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('routes send-message commands through the guarded command service when configured', async () => {
    const executor = fakeExecutor(
      bridgeFailure('internal_error', 'direct bridge must not run', [])
    );
    const stateChangingExecute = vi.fn();
    const stateChangingCommands = {
      async execute<TBody, TData>(input: {
        command: OpenCodeBridgeCommandName;
        body: TBody;
        teamName: string;
        laneId?: string | null;
        runId: string | null;
      }): Promise<OpenCodeBridgeResult<TData>> {
        stateChangingExecute(input);
        return bridgeCommandSuccess<OpenCodeSendMessageCommandData>({
          command: input.command,
          requestId: 'guarded-send-req-1',
          data: {
            accepted: true,
            memberName: 'bob',
            sessionId: 'session-bob',
            runtimePromptMessageId: 'msg_prompt_1',
            diagnostics: [],
          },
        }) as unknown as OpenCodeBridgeResult<TData>;
      },
    };
    const bridge = new OpenCodeReadinessBridge(executor, { stateChangingCommands });

    await expect(
      bridge.sendOpenCodeTeamMessage({
        runId: 'run-1',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: true,
      memberName: 'bob',
      sessionId: 'session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
    });

    expect(stateChangingExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'opencode.sendMessage',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        runId: 'run-1',
        cwd: '/repo',
        body: expect.objectContaining({
          settlementMode: 'acceptance',
          payloadHash: expect.any(String),
        }),
      })
    );
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('recovers duplicate completed guarded send through commandStatus without resending', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess({
        command: 'opencode.commandStatus',
        requestId: 'status-req-duplicate',
        data: {
          status: 'prompt_accepted',
          safeToRetry: false,
          accepted: true,
          deliveryAttemptId: 'ledger-1:1:payload',
          sessionId: 'session-bob',
          runtimePromptMessageId: 'msg_prompt_1',
          diagnostics: ['OpenCode prompt acceptance recovered from completed idempotent command.'],
        },
      })
    );
    const stateChangingExecute = vi.fn(async () => {
      throw new Error('OpenCode bridge command already completed; recover through commandStatus');
    });
    const bridge = new OpenCodeReadinessBridge(executor, {
      stateChangingCommands: { execute: stateChangingExecute },
    });
    const executeMock = executor.execute as unknown as ReturnType<typeof vi.fn>;

    await expect(
      bridge.sendOpenCodeTeamMessage({
        runId: 'run-1',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
      runtimePromptMessageId: 'msg_prompt_1',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'opencode_send_recovered_after_duplicate_completed_command',
        }),
      ]),
    });

    expect(stateChangingExecute).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    const [command, body, options] = executeMock.mock.calls[0] ?? [];
    expect(command).toBe('opencode.commandStatus');
    expect(body).toMatchObject({
      originalCommand: 'opencode.sendMessage',
      deliveryAttemptId: 'ledger-1:1:payload',
      payloadHash: expect.any(String),
    });
    expect(body).not.toHaveProperty('originalRequestId');
    expect(options).toMatchObject({
      cwd: '/repo',
      timeoutMs: 5_000,
    });
  });

  it('falls back to observed send mode when guarded acceptance contract validation fails', async () => {
    const executor = fakeExecutor(
      bridgeCommandSuccess<OpenCodeSendMessageCommandData>({
        command: 'opencode.sendMessage',
        requestId: 'legacy-observed-send',
        data: {
          accepted: true,
          memberName: 'bob',
          sessionId: 'session-bob',
          diagnostics: [],
        },
      })
    );
    const stateChangingExecute = vi
      .fn()
      .mockResolvedValueOnce(
        bridgeCommandFailure({
          command: 'opencode.sendMessage',
          requestId: 'guarded-send-acceptance',
          kind: 'internal_error',
          message:
            'OpenCode delivery acceptance mode is required, but the orchestrator does not advertise contract version 1.',
        })
      );
    const stateChangingCommands = {
      execute: stateChangingExecute,
    };
    const bridge = new OpenCodeReadinessBridge(executor, { stateChangingCommands });

    await expect(
      bridge.sendOpenCodeTeamMessage({
        runId: 'run-1',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: true,
      diagnostics: [
        expect.objectContaining({
          code: 'opencode_accept_fast_capability_missing',
          severity: 'warning',
        }),
      ],
    });

    expect(stateChangingExecute).toHaveBeenCalledTimes(1);
    expect(stateChangingExecute.mock.calls[0]?.[0]?.body).toMatchObject({
      settlementMode: 'acceptance',
    });
    expect(executor.execute).toHaveBeenCalledWith(
      'opencode.sendMessage',
      expect.objectContaining({ settlementMode: 'observed' }),
      expect.objectContaining({
        cwd: '/repo',
      })
    );
  });

  it('does not use observed guarded fallback when forced session refresh contract is missing', async () => {
    const executor = fakeExecutor(
      bridgeFailure('internal_error', 'direct observed bridge must not run', [])
    );
    const stateChangingExecute = vi
      .fn()
      .mockResolvedValueOnce(
        bridgeCommandFailure({
          command: 'opencode.sendMessage',
          requestId: 'guarded-send-acceptance',
          kind: 'internal_error',
          message:
            'OpenCode delivery acceptance mode is required, but the orchestrator does not advertise contract version 2.',
        })
      );
    const bridge = new OpenCodeReadinessBridge(executor, {
      stateChangingCommands: { execute: stateChangingExecute },
    });

    await expect(
      bridge.sendOpenCodeTeamMessage({
        runId: 'run-1',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        projectPath: '/repo',
        memberName: 'bob',
        text: 'hello',
        messageId: 'message-1',
        deliveryAttemptId: 'ledger-1:1:payload',
        forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
        settlementMode: 'acceptance',
      })
    ).resolves.toMatchObject({
      accepted: false,
      responseObservation: { state: 'session_stale' },
      diagnostics: [
        expect.objectContaining({
          code: 'opencode_force_session_refresh_contract_missing',
          severity: 'error',
        }),
      ],
    });

    expect(stateChangingExecute).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
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

  it('routes OpenCode permission answers through the guarded command service', async () => {
    const executor = fakeExecutor(
      bridgeFailure('internal_error', 'direct bridge must not run', [])
    );
    const stateChangingExecute = vi.fn();
    const stateChangingCommands = {
      async execute<TBody, TData>(input: {
        command: OpenCodeBridgeCommandName;
        body: TBody;
        teamName: string;
        laneId?: string | null;
        runId: string | null;
      }): Promise<OpenCodeBridgeResult<TData>> {
        stateChangingExecute(input);
        return bridgeCommandSuccess<OpenCodeLaunchTeamCommandData>({
          command: input.command,
          requestId: 'guarded-permission-req-1',
          data: {
            runId: 'run-1',
            teamLaunchState: 'ready',
            members: {},
            warnings: [],
            diagnostics: [],
          },
        }) as unknown as OpenCodeBridgeResult<TData>;
      },
    };
    const bridge = new OpenCodeReadinessBridge(executor, { stateChangingCommands });

    await expect(
      bridge.answerOpenCodeRuntimePermission({
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
      })
    ).resolves.toMatchObject({
      runId: 'run-1',
      teamLaunchState: 'ready',
    });

    expect(stateChangingExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'opencode.answerPermission',
        teamName: 'team-a',
        laneId: 'primary',
        runId: 'run-1',
        capabilitySnapshotId: null,
        cwd: '/repo',
        body: expect.objectContaining({
          requestId: 'perm-1',
          decision: 'allow',
        }),
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

function fakeSequenceExecutor(
  results: OpenCodeBridgeResult<unknown>[]
): OpenCodeReadinessBridgeCommandExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => {
    const next = results.shift();
    if (!next) {
      throw new Error('No fake bridge result queued');
    }
    return next;
  });
  return {
    execute: execute as unknown as OpenCodeReadinessBridgeCommandExecutor['execute'] &
      ReturnType<typeof vi.fn>,
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
  diagnostics: OpenCodeBridgeResult<unknown>['diagnostics'],
  details?: Record<string, unknown>
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
      ...(details ? { details } : {}),
    },
    diagnostics,
  };
}

function bridgeCommandFailure(input: {
  command: OpenCodeBridgeCommandName;
  requestId: string;
  kind: OpenCodeBridgeFailureKind;
  message: string;
}): OpenCodeBridgeResult<unknown> {
  return {
    ok: false,
    schemaVersion: 1,
    requestId: input.requestId,
    command: input.command,
    completedAt: '2026-04-21T12:00:01.000Z',
    durationMs: 1000,
    error: {
      kind: input.kind,
      message: input.message,
      retryable: false,
    },
    diagnostics: [],
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
