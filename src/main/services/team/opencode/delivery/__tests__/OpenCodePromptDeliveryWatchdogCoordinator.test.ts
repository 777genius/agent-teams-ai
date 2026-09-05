import { describe, expect, it, vi } from 'vitest';

import { createOpenCodePromptDeliveryWatchdogCoordinator } from '../OpenCodePromptDeliveryWatchdogCoordinator';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import type { OpenCodePromptDeliveryWatchdogScheduler } from '../OpenCodePromptDeliveryWatchdogScheduler';
import type { OpenCodeVisibleReplyProofService } from '../OpenCodeVisibleReplyProofService';
import type { InboxMessage, TaskRef } from '@shared/types/team';

const ISO = '2026-01-01T00:00:00.000Z';
const TASK_REF: TaskRef = { taskId: 'task-1', displayId: 'T-1', teamName: 'team' };

function record(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team',
    memberName: 'alice',
    laneId: 'lane-1',
    runId: 'run-1',
    runtimeSessionId: 'session-1',
    runtimePromptMessageId: null,
    runtimePromptMessageIds: [],
    lastRuntimePromptMessageId: null,
    lastDeliveryAttemptIdWithAcceptedPrompt: null,
    inboxMessageId: 'msg-1',
    inboxTimestamp: ISO,
    source: 'watcher',
    messageKind: null,
    workSyncIntent: null,
    replyRecipient: 'user',
    actionMode: 'ask',
    taskRefs: [],
    payloadHash: 'hash',
    status: 'accepted',
    responseState: 'pending',
    attempts: 1,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    maxSessionRefreshAttempts: 5,
    lastSessionRefreshReason: null,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastObservedAt: null,
    acceptedAt: ISO,
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: null,
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function taskRefsIncludeAll(
  actual: readonly TaskRef[] | undefined,
  expected: readonly TaskRef[] | undefined
): boolean {
  return (expected ?? []).every((expectedRef) =>
    (actual ?? []).some(
      (actualRef) =>
        actualRef.taskId === expectedRef.taskId &&
        actualRef.displayId === expectedRef.displayId &&
        actualRef.teamName === expectedRef.teamName
    )
  );
}

function makeCoordinator(
  overrides: {
    scheduler?: Pick<
      OpenCodePromptDeliveryWatchdogScheduler,
      'isEnabled' | 'schedule' | 'isStaleError'
    >;
    ledger?: OpenCodePromptDeliveryLedgerStore;
    inboxMessages?: InboxMessage[];
    activeLaneIds?: string[] | null;
    members?: string[];
    logPromptDeliveryEvent?: ReturnType<typeof vi.fn>;
    notifyLeadTurnActivity?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const scheduler =
    overrides.scheduler ??
    ({
      isEnabled: vi.fn(() => true),
      schedule: vi.fn(),
      isStaleError: vi.fn(async () => false),
    } satisfies Pick<
      OpenCodePromptDeliveryWatchdogScheduler,
      'isEnabled' | 'schedule' | 'isStaleError'
    >);
  const visibleReplyProofService = {
    applyDestinationProof: vi.fn(),
    materializePlainTextReplyIfNeeded: vi.fn(),
  } as unknown as Pick<
    OpenCodeVisibleReplyProofService,
    'applyDestinationProof' | 'materializePlainTextReplyIfNeeded'
  >;

  return createOpenCodePromptDeliveryWatchdogCoordinator({
    hasAcceptedMemberWorkSyncReport: vi.fn(async () => true),
    taskRefsIncludeAll,
    visibleReplyProofService,
    maybeSyncRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    rememberRuntimePidFromBridge: vi.fn(async () => undefined),
    watchdogScheduler: scheduler,
    canDeliverToTeamRuntime: vi.fn(() => true),
    recoverRuntimeLanesForWatchdog: vi.fn(async () => []),
    stopRuntimeLanesForStoppedTeam: vi.fn(async () => undefined),
    readActiveRuntimeLaneIds: vi.fn(async () => overrides.activeLaneIds ?? ['lane-1']),
    createLedger: vi.fn(() => overrides.ledger ?? ({} as OpenCodePromptDeliveryLedgerStore)),
    resolveMembersForRuntimeLane: vi.fn(async () => overrides.members ?? ['alice']),
    getInboxMessages: vi.fn(async () => overrides.inboxMessages ?? []),
    resolveCurrentRuntimeRunId: vi.fn(async () => 'run-1'),
    hasStableInboxMessageId: (message): message is InboxMessage & { messageId: string } =>
      typeof message.messageId === 'string' && message.messageId.trim().length > 0,
    logPromptDeliveryEvent: overrides.logPromptDeliveryEvent ?? vi.fn(),
    notifyLeadTurnActivity: overrides.notifyLeadTurnActivity,
    nowIso: () => ISO,
    sleep: vi.fn(async () => undefined),
  });
}

describe('OpenCodePromptDeliveryWatchdogCoordinator', () => {
  it('keeps read commits pending when visible replies miss required task refs', async () => {
    const coordinator = makeCoordinator();

    await expect(
      coordinator.isDeliveryResponseReadCommitAllowed({
        responseState: 'responded_visible_message',
        taskRefs: [TASK_REF],
        visibleReply: {
          inboxName: 'user',
          message: {
            from: 'alice',
            to: 'user',
            text: 'Done.',
            timestamp: ISO,
            read: false,
            messageId: 'reply-1',
            taskRefs: [],
          },
        },
      })
    ).resolves.toBe(false);
    expect(
      coordinator.getDeliveryPendingReason({
        responseState: 'responded_visible_message',
        taskRefs: [TASK_REF],
        visibleReply: {
          inboxName: 'user',
          message: {
            from: 'alice',
            to: 'user',
            text: 'Done.',
            timestamp: ISO,
            read: false,
            messageId: 'reply-1',
            taskRefs: [],
          },
        },
      })
    ).toBe('visible_reply_missing_task_refs');
  });

  it('requeues terminal no-assistant failures through the ledger port', async () => {
    const ledgerRecord = record({
      status: 'failed_terminal',
      responseState: 'prompt_delivered_no_assistant_message',
      attempts: 3,
      maxAttempts: 3,
    });
    const requeued = record({
      ...ledgerRecord,
      status: 'retry_scheduled',
      nextAttemptAt: ISO,
    });
    const markNextAttemptScheduled = vi.fn(async () => requeued);
    const coordinator = makeCoordinator();

    await expect(
      coordinator.requeueNoAssistantTerminalDeliveryIfNeeded({
        ledger: { markNextAttemptScheduled } as unknown as OpenCodePromptDeliveryLedgerStore,
        ledgerRecord,
      })
    ).resolves.toBe(requeued);
    expect(markNextAttemptScheduled).toHaveBeenCalledWith({
      id: 'record-1',
      status: 'retry_scheduled',
      nextAttemptAt: ISO,
      reason: 'opencode_prompt_delivery_requeued_after_terminal_no_assistant_response',
      scheduledAt: ISO,
    });
  });

  it("reports the lead turn as 'idle' when a primary-lane delivery is marked terminal", async () => {
    const notifyLeadTurnActivity = vi.fn();
    const coordinator = makeCoordinator({ notifyLeadTurnActivity });
    const markFailedTerminal = vi.fn(async (input: { id: string }) =>
      record({
        id: input.id,
        laneId: 'primary',
        memberName: 'team-lead',
        status: 'failed_terminal',
      })
    );

    await coordinator.markLedgerFailedTerminal({
      ledger: { markFailedTerminal } as unknown as OpenCodePromptDeliveryLedgerStore,
      id: 'record-1',
      reason: 'opencode_prompt_delivery_failed_terminal',
      failedAt: ISO,
    });

    expect(notifyLeadTurnActivity).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'idle',
    });
  });

  it('does not report lead turn activity for secondary-lane terminal marks', async () => {
    const notifyLeadTurnActivity = vi.fn();
    const coordinator = makeCoordinator({ notifyLeadTurnActivity });
    const markFailedTerminal = vi.fn(async () => record({ status: 'failed_terminal' }));

    await coordinator.markLedgerFailedTerminal({
      ledger: { markFailedTerminal } as unknown as OpenCodePromptDeliveryLedgerStore,
      id: 'record-1',
      reason: 'opencode_prompt_delivery_failed_terminal',
      failedAt: ISO,
    });

    expect(notifyLeadTurnActivity).not.toHaveBeenCalled();
  });

  it('re-arms a responded record that still owes its read-commit, at its own deadline', async () => {
    // A responded record used to be terminal for the watchdog, so nothing ever
    // came back for the read-commit it still owed and the inbox row stayed
    // unread. The committed one next to it is the control: it is done, and
    // re-arming it would be a wake that can change nothing.
    const deferredDeadlineMs = Date.now() + 90_000;
    const owingReadCommit = record({
      id: 'record-owing-commit',
      inboxMessageId: 'msg-owing-commit',
      status: 'responded',
      responseState: 'responded_visible_message',
      respondedAt: ISO,
      inboxReadCommittedAt: null,
      nextAttemptAt: new Date(deferredDeadlineMs).toISOString(),
    });
    const readCommitted = record({
      id: 'record-committed',
      inboxMessageId: 'msg-committed',
      status: 'responded',
      responseState: 'responded_visible_message',
      respondedAt: ISO,
      inboxReadCommittedAt: ISO,
    });
    const ledger = {
      pruneTerminalRecords: vi.fn(async () => undefined),
      list: vi.fn(async () => [owingReadCommit, readCommitted]),
      getByInboxMessage: vi.fn(async () => null),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const scheduled: { messageId?: string | null; delayMs: number }[] = [];
    const scheduler = {
      isEnabled: vi.fn(() => true),
      schedule: vi.fn((input: { messageId?: string | null; delayMs: number }) => {
        scheduled.push(input);
      }),
      isStaleError: vi.fn(async () => false),
    } satisfies Pick<
      OpenCodePromptDeliveryWatchdogScheduler,
      'isEnabled' | 'schedule' | 'isStaleError'
    >;
    const coordinator = makeCoordinator({ scheduler, ledger, members: [] });

    await expect(coordinator.scanActiveLanes('team', ['lane-1'])).resolves.toBe(1);

    expect(scheduled.map((input) => input.messageId)).toEqual(['msg-owing-commit']);
    // The deferred deadline survives the scan: a record postponed to a future
    // time is re-armed for that time, not woken immediately.
    expect(scheduled[0]?.delayMs).toBeGreaterThan(60_000);
  });

  it('rebuilds missing watchdog ledger records from unread inbox messages', async () => {
    const pending = record({ status: 'pending', source: 'watchdog' });
    const recovered = record({
      ...pending,
      status: 'retry_scheduled',
      acceptanceUnknown: true,
      lastReason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
    });
    const ledger = {
      pruneTerminalRecords: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      getByInboxMessage: vi.fn(async () => null),
      ensurePending: vi.fn(async () => pending),
      markAcceptanceUnknown: vi.fn(async () => recovered),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const scheduler = {
      isEnabled: vi.fn(() => true),
      schedule: vi.fn(),
      isStaleError: vi.fn(async () => false),
    } satisfies Pick<
      OpenCodePromptDeliveryWatchdogScheduler,
      'isEnabled' | 'schedule' | 'isStaleError'
    >;
    const logPromptDeliveryEvent = vi.fn();
    const coordinator = makeCoordinator({
      scheduler,
      ledger,
      logPromptDeliveryEvent,
      inboxMessages: [
        {
          from: 'user',
          to: 'alice',
          text: 'Please check this.',
          timestamp: ISO,
          read: false,
          messageId: 'msg-1',
          taskRefs: [TASK_REF],
        },
      ],
    });

    await expect(coordinator.scanActiveLanes('team', ['lane-1'])).resolves.toBe(1);
    expect(ledger.ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team',
        memberName: 'alice',
        laneId: 'lane-1',
        inboxMessageId: 'msg-1',
        source: 'watchdog',
        taskRefs: [TASK_REF],
      })
    );
    expect(ledger.markAcceptanceUnknown).toHaveBeenCalledWith({
      id: 'record-1',
      reason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
      nextAttemptAt: ISO,
      markedAt: ISO,
    });
    expect(scheduler.schedule).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'alice',
      messageId: 'msg-1',
      delayMs: 500,
    });
    expect(logPromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_retry_scheduled',
      recovered,
      {
        acceptanceUnknown: true,
        reason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
      }
    );
  });
});
