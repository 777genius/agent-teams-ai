import { addLogSink, type LogSinkEntry } from '@shared/utils/logger';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';
import {
  createOpenCodePromptDeliveryLedgerStore,
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import { isOpenCodeDeliveryResponseReadCommitAllowed } from '../OpenCodePromptDeliveryReadCommitPolicy';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../OpenCodePromptDeliveryStalePendingPolicy';
import { OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS } from '../OpenCodePromptDeliveryWatchdog';

import type { OpenCodeTeamRuntimeMessageResult } from '../../../runtime';
import type { OpenCodeDeliveryResponseObservation } from '../../bridge/OpenCodeBridgeCommandContract';

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const TEAM = 'reportteam';
const LEAD = 'team-lead';
const LAUNCH_PROMPT_BODY = 'Build the offline report pipeline and assign the work to the team.';
const BUSY = 'OpenCode session status busy';
const TREATED_IDLE =
  'OpenCode session status was busy but transcript has a completed assistant response for the latest user message; treating session as idle';

/** The launch prompt: from the user, no actionMode, so tool calls never read-commit it. */
const launchPrompt: OpenCodeMemberMessageDeliveryInput = {
  memberName: LEAD,
  text: LAUNCH_PROMPT_BODY,
  messageId: 'launch-1',
  replyRecipient: 'user',
  messageKind: 'default',
  source: 'watcher',
  inboxTimestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
};

function respondedToolCallObservation(input: {
  toolCallNames: string[];
  deliveredUserMessageId?: string | null;
  assistantMessageId?: string | null;
  latestAssistantPreview?: string | null;
}): OpenCodeDeliveryResponseObservation {
  return {
    state: 'responded_tool_call',
    deliveredUserMessageId: input.deliveredUserMessageId ?? null,
    assistantMessageId: input.assistantMessageId ?? 'msg_assistant',
    toolCallNames: input.toolCallNames,
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: input.latestAssistantPreview ?? null,
    reason: 'assistant_response_pending',
  };
}

function observedResult(
  observation: OpenCodeDeliveryResponseObservation,
  diagnostics: string[] = [TREATED_IDLE]
): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: LEAD,
    sessionId: 'ses_1',
    responseObservation: observation,
    diagnostics,
  };
}

function acceptedSendResult(): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: LEAD,
    sessionId: 'ses_1',
    runtimePromptMessageId: 'msg_prompt_retry',
    responseObservation: respondedToolCallObservation({
      toolCallNames: [],
      deliveredUserMessageId: 'msg_prompt_retry',
      assistantMessageId: null,
    }),
    diagnostics: [],
  };
}

/**
 * Seed the ledger row exactly as the launch-prompt watchdog leaves it minutes
 * into a tool-heavy first turn: retry due, no visible reply yet.
 */
async function seedRetryDueRecord(
  ledger: OpenCodePromptDeliveryLedgerStore,
  options: {
    toolCallNames: string[];
    accepted?: boolean;
    assistantMessageId?: string | null;
    latestAssistantPreview?: string | null;
    ageMinutes?: number;
  }
): Promise<OpenCodePromptDeliveryLedgerRecord> {
  const accepted = options.accepted !== false;
  const at = new Date(Date.now() - (options.ageMinutes ?? 3) * 60_000).toISOString();
  const created = await ledger.ensurePending({
    teamName: TEAM,
    memberName: LEAD,
    laneId: PRIMARY_LANE.laneId,
    runId: 'run-1',
    inboxMessageId: launchPrompt.messageId!,
    inboxTimestamp: at,
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    messageKind: launchPrompt.messageKind ?? null,
    taskRefs: [],
    payloadHash: hashOpenCodePromptDeliveryPayload({
      text: launchPrompt.text,
      replyRecipient: 'user',
      actionMode: null,
      taskRefs: [],
      source: launchPrompt.source,
    }),
    now: at,
  });
  const delivered = await ledger.applyDeliveryResult({
    id: created.id,
    accepted,
    attempted: true,
    responseObservation: respondedToolCallObservation({
      toolCallNames: options.toolCallNames,
      deliveredUserMessageId: accepted ? 'msg_prompt' : null,
      assistantMessageId: options.assistantMessageId,
      latestAssistantPreview: options.latestAssistantPreview,
    }),
    sessionId: 'ses_1',
    runtimePromptMessageId: accepted ? 'msg_prompt' : null,
    deliveryAttemptId: `${created.id}:1`,
    reason: 'assistant_response_pending',
    now: at,
  });
  if (!accepted) {
    // `failed_retryable` with no scheduled attempt is already retry-due.
    return delivered;
  }
  return await ledger.markNextAttemptScheduled({
    id: created.id,
    status: 'retry_scheduled',
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    reason: 'assistant_response_pending',
    scheduledAt: at,
  });
}

type ReadCommitPortInput = Parameters<
  OpenCodeMemberMessageDeliveryServiceDependencies['isOpenCodeDeliveryResponseReadCommitAllowed']
>[0];

interface Harness {
  service: OpenCodeMemberMessageDeliveryService;
  ledger: OpenCodePromptDeliveryLedgerStore;
  observe: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
}

function createHarness(input: {
  ledgerDir: string;
  observe?: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  send?: () => Promise<OpenCodeTeamRuntimeMessageResult>;
}): Harness {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(input.ledgerDir, 'primary.json'),
  });
  const observe = vi.fn(async () => {
    if (!input.observe) throw new Error('observe not expected');
    return await input.observe();
  });
  const send = vi.fn(async () => {
    if (!input.send) throw new Error('send not expected');
    return await input.send();
  });
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  const logEvent = vi.fn();
  const deps: OpenCodeMemberMessageDeliveryServiceDependencies = {
    getOpenCodeRuntimeMessageAdapter: vi.fn(
      () => ({ sendMessageToMember: send, observeMessageDelivery: observe }) as never
    ),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: TEAM, projectPath: '/repo', members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: LEAD, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: LEAD,
      laneId: PRIMARY_LANE.laneId,
      laneIdentity: PRIMARY_LANE,
      metaMember: { name: LEAD, providerId: 'opencode' as const },
      memberRuntimeCwd: '/repo',
    })),
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => '/repo'),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => ({ mixedSecondaryLanes: [] })) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'run-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () => false),
    deleteSecondaryRuntimeRun: vi.fn(),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(
      async () => ({ appMcpTransportHash: 'hash' }) as never
    ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () => undefined),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(
      async ({ send: run }: { send: () => Promise<OpenCodeTeamRuntimeMessageResult> }) =>
        await run()
    ),
    rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => undefined),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => true),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
    openCodeVisibleReplyProofService: {
      applyDestinationProof: passthroughProof as never,
      materializePlainTextReplyIfNeeded: passthroughProof as never,
      findByRelayOfMessageId: vi.fn(async () => null),
    },
    openCodePromptDeliveryWatchdogScheduler: { isEnabled: () => true },
    openCodePromptDeliveryFollowUpPolicy: {
      schedule: vi.fn(
        async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) =>
          ledgerRecord
      ),
    },
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(async (readInput: ReadCommitPortInput) =>
      isOpenCodeDeliveryResponseReadCommitAllowed({
        ...readInput,
        hasAcceptedMemberWorkSyncReport: async () => false,
        taskRefsIncludeAll: () => true,
      })
    ),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'assistant_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    logOpenCodePromptDeliveryEvent: logEvent,
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    notifyOpenCodeLeadTurnActivity: vi.fn() as never,
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })
    ),
  };
  return {
    service: new OpenCodeMemberMessageDeliveryService(deps),
    ledger,
    observe,
    send,
    logEvent,
  };
}

function sentText(send: ReturnType<typeof vi.fn>): string {
  return String((send.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? '');
}

function sinkMessages(entries: readonly LogSinkEntry[]): string[] {
  return entries.map((entry) => entry.args.map((arg) => String(arg)).join(' '));
}

describe('OpenCodeMemberMessageDeliveryService launch-prompt turn activity', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-turn-activity-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('defers the due retry while a bridged turn keeps adding tool calls to one assistant message', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult(
          respondedToolCallObservation({
            toolCallNames: ['task_create', 'task_create', 'task_create'],
            deliveredUserMessageId: 'msg_prompt',
          })
        ),
    });
    await seedRetryDueRecord(harness.ledger, { toolCallNames: ['task_create'] });

    const delivery = await harness.service.deliver(TEAM, launchPrompt);

    expect(harness.observe).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({ accepted: true, responsePending: true });
    expect(harness.logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_retry_deferred_turn_active',
      expect.anything(),
      expect.objectContaining({
        turnActivityReason: 'tool_calls_progressed',
        previousToolCallCount: 1,
      })
    );
  });

  it('defers the due retry for a lane whose only activity proof is a changing assistant message id', async () => {
    // Negative control: a runtime that opens a new assistant message per step
    // reports no tool growth and no text growth. It must stay active on the
    // message-id signal rather than being treated as an idle turn and
    // re-prompted mid-turn.
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult(
          respondedToolCallObservation({
            toolCallNames: ['glob'],
            deliveredUserMessageId: 'msg_prompt',
            assistantMessageId: 'msg_assistant_2',
            latestAssistantPreview: 'Working.',
          })
        ),
    });
    await seedRetryDueRecord(harness.ledger, {
      toolCallNames: ['glob', 'read', 'task_create'],
      assistantMessageId: 'msg_assistant_1',
      latestAssistantPreview: 'Working.',
    });

    const delivery = await harness.service.deliver(TEAM, launchPrompt);

    expect(harness.send).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({ accepted: true, responsePending: true });
    expect(harness.logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_retry_deferred_turn_active',
      expect.anything(),
      expect.objectContaining({
        turnActivityReason: 'assistant_message_progressed',
        previousAssistantMessageId: 'msg_assistant_1',
      })
    );
  });

  it('honours a raw busy session status past the turn-activity cap', async () => {
    // Negative control for the cap: the cap bounds the inferred signals only.
    // A session the bridge still reports busy is a live turn, and re-prompting
    // into it is exactly the double answer.
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult(
          respondedToolCallObservation({
            toolCallNames: ['task_create'],
            deliveredUserMessageId: 'msg_prompt',
          }),
          [BUSY, TREATED_IDLE]
        ),
    });
    await seedRetryDueRecord(harness.ledger, {
      toolCallNames: ['task_create'],
      ageMinutes: Math.ceil(OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS / 60_000) + 5,
    });

    await harness.service.deliver(TEAM, launchPrompt);

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_retry_deferred_turn_active',
      expect.anything(),
      expect.objectContaining({ turnActivityReason: 'session_status_busy' })
    );
  });

  it('re-sends only the redelivery marker, never the launch prompt body, once the turn is idle', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult(
          respondedToolCallObservation({
            toolCallNames: ['task_create'],
            deliveredUserMessageId: 'msg_prompt',
          })
        ),
      send: async () => acceptedSendResult(),
    });
    await seedRetryDueRecord(harness.ledger, { toolCallNames: ['task_create'] });

    await harness.service.deliver(TEAM, launchPrompt);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(sentText(harness.send)).toContain('<opencode_delivery_redelivery>');
    expect(sentText(harness.send)).toContain('launch-1');
    expect(sentText(harness.send)).not.toContain(LAUNCH_PROMPT_BODY);
  });

  it('still redelivers the prompt body when the runtime never proved it accepted it', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult(
          respondedToolCallObservation({ toolCallNames: ['task_create'], assistantMessageId: null })
        ),
      send: async () => acceptedSendResult(),
    });
    await seedRetryDueRecord(harness.ledger, {
      toolCallNames: ['task_create'],
      accepted: false,
    });

    await harness.service.deliver(TEAM, launchPrompt);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(sentText(harness.send)).toContain(LAUNCH_PROMPT_BODY);
    expect(sentText(harness.send)).not.toContain('<opencode_delivery_redelivery>');
  });

  it('writes both retry diagnostics to the log sink and nothing to the console', async () => {
    // Negative control for the durable diagnostic level: these two events are
    // the ones the delivery pipeline needs in the persisted log, and neither
    // may cost a console line - otherwise the suite-wide "no unexpected console
    // output" invariant would need a per-event allowlist.
    const entries: LogSinkEntry[] = [];
    const removeSink = addLogSink((entry) => entries.push(entry));
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    try {
      const harness = createHarness({
        ledgerDir,
        observe: async () =>
          observedResult(
            respondedToolCallObservation({
              toolCallNames: ['task_create'],
              deliveredUserMessageId: 'msg_prompt',
            })
          ),
        send: async () => acceptedSendResult(),
      });
      await seedRetryDueRecord(harness.ledger, { toolCallNames: ['task_create'] });

      await harness.service.deliver(TEAM, launchPrompt);

      const messages = sinkMessages(entries);
      expect(
        messages.some((message) => message.includes('opencode_prompt_delivery_turn_activity'))
      ).toBe(true);
      expect(
        messages.some((message) => message.includes('opencode_prompt_delivery_body_suppressed'))
      ).toBe(true);
      expect(entries.every((entry) => entry.level === 'diagnostic')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(0);
      expect(error).toHaveBeenCalledTimes(0);
      expect(log).toHaveBeenCalledTimes(0);
    } finally {
      removeSink();
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});
