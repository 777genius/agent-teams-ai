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
import {
  OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON,
  OPENCODE_STALE_PENDING_POLICY_CONFIG,
  OPENCODE_STALE_PENDING_TERMINAL_REASON,
  type OpenCodeStalePendingPolicyConfig,
} from '../OpenCodePromptDeliveryStalePendingPolicy';

import type { OpenCodeTeamRuntimeMessageResult } from '../../../runtime';
import type { OpenCodeDeliveryResponseObservation } from '../../bridge/OpenCodeBridgeCommandContract';

/** The read-commit input the delivery service actually hands to this port. */
type ReadCommitPortInput = Parameters<
  OpenCodeMemberMessageDeliveryServiceDependencies['isOpenCodeDeliveryResponseReadCommitAllowed']
>[0];

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const TEAM = 'reportteam';
const LEAD = 'team-lead';
const BUSY = 'OpenCode session status busy';
const TREATED_IDLE =
  'OpenCode session status was busy but transcript has a completed assistant response for the latest user message; treating session as idle';

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function pendingObservation(
  overrides: Partial<OpenCodeDeliveryResponseObservation> = {}
): OpenCodeDeliveryResponseObservation {
  return {
    state: 'pending',
    deliveredUserMessageId: 'msg_prompt',
    assistantMessageId: 'msg_assistant',
    toolCallNames: ['glob'],
    visibleMessageToolCallId: null,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: null,
    reason: 'assistant_response_pending',
    ...overrides,
  };
}

function observedResult(input: {
  observation: OpenCodeDeliveryResponseObservation;
  diagnostics: string[];
}): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: LEAD,
    sessionId: 'ses_1',
    runtimePromptMessageId: 'msg_prompt',
    responseObservation: input.observation,
    diagnostics: input.diagnostics,
  };
}

function acceptedSendResult(): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName: LEAD,
    sessionId: 'ses_1',
    runtimePromptMessageId: 'msg_prompt_new',
    responseObservation: pendingObservation({
      deliveredUserMessageId: 'msg_prompt_new',
      assistantMessageId: null,
      toolCallNames: [],
    }),
    diagnostics: [BUSY],
  };
}

const taskCommentNotification: OpenCodeMemberMessageDeliveryInput = {
  memberName: LEAD,
  text: 'Task comment: Scribe finished the report section.',
  messageId: 'task-comment-forward:reportteam:1',
  replyRecipient: 'system',
  messageKind: 'task_comment_notification',
  source: 'watcher',
  inboxTimestamp: minutesAgoIso(32),
};

const userMessage: OpenCodeMemberMessageDeliveryInput = {
  memberName: LEAD,
  text: 'Please wrap up and send ALL DONE.',
  messageId: 'user-2',
  replyRecipient: 'user',
  actionMode: 'delegate',
  messageKind: 'default',
  source: 'watcher',
  inboxTimestamp: minutesAgoIso(0),
};

/** Seed an accepted/pending record exactly like the live stuck ledger row. */
async function seedAcceptedPendingRecord(
  ledger: OpenCodePromptDeliveryLedgerStore,
  input: OpenCodeMemberMessageDeliveryInput,
  options: { ageMinutes: number; assistantMessageId?: string | null }
): Promise<OpenCodePromptDeliveryLedgerRecord> {
  const at = minutesAgoIso(options.ageMinutes);
  const created = await ledger.ensurePending({
    teamName: TEAM,
    memberName: LEAD,
    laneId: PRIMARY_LANE.laneId,
    runId: 'run-1',
    inboxMessageId: input.messageId!,
    inboxTimestamp: input.inboxTimestamp ?? at,
    source: input.source ?? 'watcher',
    replyRecipient: input.replyRecipient ?? 'user',
    actionMode: input.actionMode ?? null,
    messageKind: input.messageKind ?? null,
    workSyncIntent: input.workSyncIntent,
    taskRefs: input.taskRefs ?? [],
    payloadHash: hashOpenCodePromptDeliveryPayload({
      text: input.text,
      replyRecipient: input.replyRecipient ?? 'user',
      actionMode: input.actionMode ?? null,
      taskRefs: input.taskRefs ?? [],
      attachments: input.attachments,
      source: input.source,
    }),
    now: at,
  });
  return await ledger.applyDeliveryResult({
    id: created.id,
    accepted: true,
    attempted: true,
    responseObservation: pendingObservation({
      assistantMessageId:
        options.assistantMessageId === undefined ? 'msg_assistant' : options.assistantMessageId,
    }),
    sessionId: 'ses_1',
    runtimePromptMessageId: 'msg_prompt',
    deliveryAttemptId: `${created.id}:1`,
    diagnostics: [BUSY],
    reason: 'assistant_response_pending',
    now: at,
  });
}

interface Harness {
  service: OpenCodeMemberMessageDeliveryService;
  ledger: OpenCodePromptDeliveryLedgerStore;
  observe: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  followUpSchedule: ReturnType<typeof vi.fn>;
  scheduleWatchdog: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
}

function createHarness(input: {
  ledgerDir: string;
  observe?: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  send?: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  /** Defaults to the windows the production composition wires in. */
  stalePendingConfig?: OpenCodeStalePendingPolicyConfig;
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
  const followUpSchedule = vi.fn(
    async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
  );
  const scheduleWatchdog = vi.fn();
  const notify = vi.fn();
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
    openCodePromptDeliveryFollowUpPolicy: { schedule: followUpSchedule },
    openCodeStalePendingPolicyConfig:
      input.stalePendingConfig ?? OPENCODE_STALE_PENDING_POLICY_CONFIG,
    // Real read-commit semantics: plain-text settles non-user messages only.
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
    scheduleOpenCodePromptDeliveryWatchdog: scheduleWatchdog,
    logOpenCodePromptDeliveryEvent: logEvent,
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    notifyOpenCodeLeadTurnActivity: notify as never,
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
    followUpSchedule,
    scheduleWatchdog,
    notify,
    logEvent,
  };
}

describe('OpenCodeMemberMessageDeliveryService stale-pending guard', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-stale-pending-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('settles a lead non-user delivery as a plain-text turn end when the bridge keeps answering pending but idle', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult({ observation: pendingObservation(), diagnostics: [BUSY, TREATED_IDLE] }),
    });
    // Fresh record: the plain-text turn-end rule does not need the stale window.
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, { ageMinutes: 1 });

    const delivery = await harness.service.deliver(TEAM, taskCommentNotification);

    expect(harness.observe).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      delivered: true,
      accepted: true,
      responsePending: false,
      ledgerStatus: 'responded',
      responseState: 'responded_plain_text',
    });
    const [record] = await harness.ledger.list();
    expect(record).toMatchObject({
      status: 'responded',
      responseState: 'responded_plain_text',
      lastReason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON,
      observedAssistantMessageId: 'msg_assistant',
    });
    expect(harness.followUpSchedule).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    expect(harness.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }));
  });

  it('keeps a fresh busy non-user delivery pending (normal observe follow-up)', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult({ observation: pendingObservation(), diagnostics: [BUSY] }),
    });
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, { ageMinutes: 1 });

    const delivery = await harness.service.deliver(TEAM, taskCommentNotification);

    expect(delivery).toMatchObject({ accepted: true, responsePending: true });
    expect(harness.followUpSchedule).toHaveBeenCalledTimes(1);
    expect(harness.followUpSchedule.mock.calls[0]?.[0]).toMatchObject({ retry: false });
    const [record] = await harness.ledger.list();
    expect(record?.status).toBe('accepted');
  });

  it('keeps a fresh non-user delivery pending when the bridge reports no session activity', async () => {
    // The observation says `pending` with an assistant message - the state of a
    // turn whose tool calls are still running - and the bridge said nothing
    // about the session. That is not a turn end, so nothing is settled.
    const harness = createHarness({
      ledgerDir,
      observe: async () => observedResult({ observation: pendingObservation(), diagnostics: [] }),
    });
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, { ageMinutes: 1 });

    const delivery = await harness.service.deliver(TEAM, taskCommentNotification);

    expect(delivery).toMatchObject({ accepted: true, responsePending: true });
    expect(harness.followUpSchedule).toHaveBeenCalledTimes(1);
    const [record] = await harness.ledger.list();
    expect(record).toMatchObject({ status: 'accepted', responseState: 'pending' });
    expect(harness.logEvent).not.toHaveBeenCalledWith(
      'opencode_prompt_delivery_response_observed',
      expect.anything(),
      expect.objectContaining({ stalePendingSettledAsPlainText: true })
    );
  });

  it('keeps observing a stale non-user delivery while the session is still busy', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult({
          observation: pendingObservation({ assistantMessageId: null, toolCallNames: [] }),
          diagnostics: [BUSY],
        }),
    });
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, {
      ageMinutes: 10,
      assistantMessageId: null,
    });

    const delivery = await harness.service.deliver(TEAM, taskCommentNotification);

    expect(delivery).toMatchObject({ accepted: true, responsePending: true });
    expect(harness.followUpSchedule).toHaveBeenCalledTimes(1);
    expect(harness.followUpSchedule.mock.calls[0]?.[0]).toMatchObject({ retry: false });
    expect(harness.logEvent).not.toHaveBeenCalledWith(
      'opencode_prompt_delivery_terminal_failure',
      expect.anything(),
      expect.anything()
    );
    const [record] = await harness.ledger.list();
    expect(record?.status).toBe('accepted');
  });

  it('marks a stale idle user prompt terminal instead of leaving it pending forever', async () => {
    const harness = createHarness({
      ledgerDir,
      observe: async () =>
        observedResult({ observation: pendingObservation(), diagnostics: [BUSY, TREATED_IDLE] }),
    });
    const staleUserPrompt: OpenCodeMemberMessageDeliveryInput = {
      ...userMessage,
      messageId: 'user-1',
      inboxTimestamp: minutesAgoIso(20),
    };
    await seedAcceptedPendingRecord(harness.ledger, staleUserPrompt, { ageMinutes: 20 });

    const delivery = await harness.service.deliver(TEAM, staleUserPrompt);

    expect(delivery).toMatchObject({
      delivered: false,
      accepted: true,
      responsePending: false,
      ledgerStatus: 'failed_terminal',
      reason: OPENCODE_STALE_PENDING_TERMINAL_REASON,
    });
    expect(harness.send).not.toHaveBeenCalled();
    const [record] = await harness.ledger.list();
    expect(record).toMatchObject({
      status: 'failed_terminal',
      lastReason: OPENCODE_STALE_PENDING_TERMINAL_REASON,
    });
    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    expect(
      await harness.ledger.getActiveForMember({
        teamName: TEAM,
        memberName: LEAD,
        laneId: 'primary',
      })
    ).toBeNull();
  });

  it.each([
    userMessage,
    taskCommentNotification,
    {
      ...taskCommentNotification,
      messageId: 'task-start',
      messageKind: 'default' as const,
      text: 'Start working on task now. Use task_get and task_complete.',
      taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: TEAM }],
    },
    {
      ...taskCommentNotification,
      messageId: 'work-sync',
      messageKind: 'member_work_sync_nudge' as const,
      workSyncIntent: 'agenda_sync' as const,
    },
  ])('preserves stale busy or unknown accepted work: $messageId', async (message) => {
    for (const diagnostics of [[BUSY], []]) {
      const harness = createHarness({
        ledgerDir,
        observe: async () => observedResult({ observation: pendingObservation(), diagnostics }),
      });
      await seedAcceptedPendingRecord(harness.ledger, message, { ageMinutes: 90 });
      const delivery = await harness.service.deliver(TEAM, message);
      expect(delivery).toMatchObject({ accepted: true, responsePending: true });
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
    }
  });

  it('queues a new user behind stale busy non-user work until a fresh idle observation', async () => {
    const harness = createHarness({
      ledgerDir,
      send: async () => acceptedSendResult(),
      observe: async () =>
        observedResult({ observation: pendingObservation(), diagnostics: [TREATED_IDLE] }),
    });
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, { ageMinutes: 90 });
    expect(await harness.service.deliver(TEAM, userMessage)).toMatchObject({
      queuedBehindMessageId: taskCommentNotification.messageId,
    });
    expect(harness.send).not.toHaveBeenCalled();
    expect(await harness.service.deliver(TEAM, taskCommentNotification)).toMatchObject({
      delivered: true,
      responsePending: false,
    });
    expect(await harness.service.deliver(TEAM, userMessage)).toMatchObject({ accepted: true });
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it('still queues a user message behind a non-stale non-user record', async () => {
    const harness = createHarness({ ledgerDir, send: async () => acceptedSendResult() });
    await seedAcceptedPendingRecord(harness.ledger, taskCommentNotification, { ageMinutes: 2 });

    const delivery = await harness.service.deliver(TEAM, userMessage);

    expect(harness.send).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      responsePending: true,
      queuedBehindMessageId: taskCommentNotification.messageId,
      reason: 'opencode_delivery_response_pending',
    });
    expect(await harness.ledger.list()).toHaveLength(1);
  });

  it('never preempts a stale user prompt with another user message', async () => {
    const harness = createHarness({ ledgerDir, send: async () => acceptedSendResult() });
    const staleUserPrompt: OpenCodeMemberMessageDeliveryInput = {
      ...userMessage,
      messageId: 'user-1',
      inboxTimestamp: minutesAgoIso(40),
    };
    await seedAcceptedPendingRecord(harness.ledger, staleUserPrompt, { ageMinutes: 40 });

    const delivery = await harness.service.deliver(TEAM, userMessage);

    expect(harness.send).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      responsePending: true,
      queuedBehindMessageId: 'user-1',
    });
  });
  it.each(['pending', 'prompt_not_indexed'] as const)(
    'marks the lead active when unknown acceptance is proven busy by observe (%s)',
    async (state) => {
      const ledgerDir = await mkdtemp(join(tmpdir(), 'review565-acceptance-recovery-'));
      try {
        const harness = createHarness({
          ledgerDir,
          observe: async () =>
            observedResult({
              observation: pendingObservation({ state }),
              diagnostics: [BUSY],
            }),
        });
        const seeded = await harness.ledger.ensurePending({
          teamName: TEAM,
          memberName: LEAD,
          laneId: 'primary',
          runId: 'run-1',
          inboxMessageId: userMessage.messageId!,
          inboxTimestamp: userMessage.inboxTimestamp!,
          source: userMessage.source!,
          replyRecipient: userMessage.replyRecipient!,
          actionMode: userMessage.actionMode,
          messageKind: userMessage.messageKind,
          taskRefs: [],
          now: minutesAgoIso(1),
          payloadHash: hashOpenCodePromptDeliveryPayload({
            text: userMessage.text,
            replyRecipient: userMessage.replyRecipient!,
            actionMode: userMessage.actionMode,
            taskRefs: [],
            source: userMessage.source,
          }),
        });
        await harness.ledger.markAcceptanceUnknown({
          id: seeded.id,
          nextAttemptAt: minutesAgoIso(0),
          reason: 'opencode_prompt_acceptance_missing_runtime_prompt_id',
          diagnostics: ['send timeout; acceptance unknown'],
          markedAt: minutesAgoIso(1),
        });
        const before = (await harness.ledger.list())[0];
        expect(before.status).toBe('failed_retryable');
        expect(before.acceptanceUnknown).toBe(true);
        expect(before.acceptedAt).toBeNull();
        expect(before.runtimePromptMessageId).toBeNull();
        const delivered = await harness.service.deliver(TEAM, userMessage);
        expect(delivered).toMatchObject({ accepted: true, responsePending: true });
        expect(harness.observe).toHaveBeenCalledOnce();
        expect(harness.send).not.toHaveBeenCalled();
        expect(harness.notify).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'idle' }));
        expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({ state: 'active' }));
      } finally {
        await rm(ledgerDir, { recursive: true, force: true });
      }
    }
  );
});
