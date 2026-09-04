import { describe, expect, it, vi } from 'vitest';

import { getTrackedOpenCodeBootstrapWakeRunId } from '../../../provisioning/TeamProvisioningSecondaryRuntimeRuns';
import { createOpenCodePromptDeliveryWatchdogCoordinator } from '../OpenCodePromptDeliveryWatchdogCoordinator';
import { OpenCodePromptDeliveryWatchdogScheduler } from '../OpenCodePromptDeliveryWatchdogScheduler';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
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
    canDeliverToTeamRuntime?: () => boolean;
    resolveCurrentRuntimeRunId?: (teamName: string, laneId: string) => Promise<string | null>;
    resolveMembersForRuntimeLane?: (teamName: string, laneId: string) => Promise<string[]>;
    hasCommittedBootstrapSession?: (input: { memberName: string }) => Promise<boolean>;
    resolveTrackedBootstrapRunId?: (input: {
      teamName: string;
      laneId: string;
      runId: string;
    }) => string | null;
    getInboxMessages?: () => Promise<InboxMessage[]>;
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
    canDeliverToTeamRuntime: overrides.canDeliverToTeamRuntime ?? vi.fn(() => true),
    recoverRuntimeLanesForWatchdog: vi.fn(async () => []),
    stopRuntimeLanesForStoppedTeam: vi.fn(async () => undefined),
    readActiveRuntimeLaneIds: vi.fn(async () => overrides.activeLaneIds ?? ['lane-1']),
    createLedger: vi.fn(() => overrides.ledger ?? ({} as OpenCodePromptDeliveryLedgerStore)),
    resolveMembersForRuntimeLane:
      overrides.resolveMembersForRuntimeLane ?? vi.fn(async () => overrides.members ?? ['alice']),
    getInboxMessages:
      overrides.getInboxMessages ?? vi.fn(async () => overrides.inboxMessages ?? []),
    resolveCurrentRuntimeRunId: overrides.resolveCurrentRuntimeRunId ?? vi.fn(async () => 'run-1'),
    hasCommittedBootstrapSession: overrides.hasCommittedBootstrapSession ?? vi.fn(async () => true),
    resolveTrackedBootstrapRunId:
      overrides.resolveTrackedBootstrapRunId ??
      ((input) => (input.laneId === 'primary' ? input.runId : 'root-run-1')),
    hasStableInboxMessageId: (message): message is InboxMessage & { messageId: string } =>
      typeof message.messageId === 'string' && message.messageId.trim().length > 0,
    logPromptDeliveryEvent: overrides.logPromptDeliveryEvent ?? vi.fn(),
    notifyLeadTurnActivity: overrides.notifyLeadTurnActivity,
    nowIso: () => ISO,
    sleep: vi.fn(async () => undefined),
  });
}

describe('OpenCodePromptDeliveryWatchdogCoordinator', () => {
  describe('committed bootstrap inbox wake', () => {
    const input = { teamName: 'team', laneId: 'lane-1', runId: 'run-1', memberName: 'alice' };
    const unread: InboxMessage = {
      from: 'team-lead',
      to: 'alice',
      text: 'Assigned task',
      timestamp: ISO,
      read: false,
      messageId: 'msg-1',
    };
    const makeScheduler = () => ({
      isEnabled: vi.fn(() => true),
      schedule: vi.fn(),
      isStaleError: vi.fn(async () => false),
    });

    it.each(['bootstrap commit', 'runtime registration'])(
      'does not wake an orphan active secondary lane from %s while the current primary is ready',
      async (entryPoint) => {
        const scheduler = makeScheduler();
        const secondary = { ...input, laneId: 'secondary:opencode:alice', runId: 'orphan-run' };
        const coordinator = makeCoordinator({
          scheduler,
          inboxMessages: [unread],
          activeLaneIds: ['primary', secondary.laneId],
          resolveCurrentRuntimeRunId: async (_team, lane) =>
            lane === 'primary' ? 'current-root' : secondary.runId,
          resolveMembersForRuntimeLane: async (_team, lane) =>
            lane === 'primary' ? ['team-lead'] : ['alice'],
          resolveTrackedBootstrapRunId: (member) =>
            getTrackedOpenCodeBootstrapWakeRunId(member, {
              runTracking: { resolveDeliverableTrackedRuntimeRunId: () => 'current-root' },
              runs: new Map([['current-root', { mixedSecondaryLanes: [] }]]),
            }),
        });
        if (entryPoint === 'bootstrap commit') {
          await expect(coordinator.wakeAfterBootstrapCommit(secondary)).resolves.toBe(0);
          expect(scheduler.schedule).not.toHaveBeenCalled();
        } else {
          await coordinator.wakeAfterRuntimeRegistration({
            teamName: 'team',
            runId: 'current-root',
          });
          expect(scheduler.schedule).toHaveBeenCalledExactlyOnceWith({
            teamName: 'team',
            memberName: 'team-lead',
            messageId: 'msg-1',
            delayMs: 500,
          });
        }
      }
    );

    it.each([true, false])('revalidates owned secondary lanes with ready=%s', async (ready) => {
      const scheduler = makeScheduler();
      const lane = { laneId: input.laneId, runId: input.runId };
      const root = { mixedSecondaryLanes: [lane] };
      let removeOwnerDuringRead = false;
      const coordinator = makeCoordinator({
        scheduler,
        canDeliverToTeamRuntime: () => ready,
        resolveTrackedBootstrapRunId: (member) =>
          getTrackedOpenCodeBootstrapWakeRunId(member, {
            runTracking: { resolveDeliverableTrackedRuntimeRunId: () => 'root-run-1' },
            runs: new Map([['root-run-1', root]]),
          }),
        getInboxMessages: async () => {
          if (removeOwnerDuringRead) root.mixedSecondaryLanes = [];
          return [unread];
        },
      });
      await expect(coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(1);
      scheduler.schedule.mockClear();
      removeOwnerDuringRead = true;
      await expect(coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('preserves a ready standalone primary without an aggregate owner and rechecks its runtime ID', async () => {
      const scheduler = makeScheduler();
      let currentRun = input.runId;
      let replaceDuringRead = false;
      const coordinator = makeCoordinator({
        scheduler,
        resolveTrackedBootstrapRunId: () => null,
        resolveCurrentRuntimeRunId: async () => currentRun,
        getInboxMessages: async () => {
          if (replaceDuringRead) currentRun = 'new-primary-run';
          return [unread];
        },
      });
      await expect(
        coordinator.wakeAfterBootstrapCommit({ ...input, laneId: 'primary' })
      ).resolves.toBe(1);
      scheduler.schedule.mockClear();
      replaceDuringRead = true;
      await expect(
        coordinator.wakeAfterBootstrapCommit({ ...input, laneId: 'primary' })
      ).resolves.toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('replays verified primary and secondary bootstrap wakes after fresh runtime registration', async () => {
      const scheduler = makeScheduler();
      let registered = false;
      const coordinator = makeCoordinator({
        scheduler,
        inboxMessages: [unread],
        activeLaneIds: ['primary', 'secondary'],
        canDeliverToTeamRuntime: () => registered,
        resolveTrackedBootstrapRunId: () => (registered ? 'run-1' : null),
        resolveCurrentRuntimeRunId: async (_team, lane) =>
          lane === 'primary' ? 'run-1' : 'lane-run-1',
        resolveMembersForRuntimeLane: async (_team, lane) =>
          lane === 'primary' ? ['alice', 'not-confirmed'] : ['bob'],
        hasCommittedBootstrapSession: async ({ memberName }) => memberName !== 'not-confirmed',
      });
      await coordinator.wakeAfterBootstrapCommit({ ...input, laneId: 'primary' });
      expect(scheduler.schedule).not.toHaveBeenCalled();
      registered = true;
      await coordinator.wakeAfterRuntimeRegistration({ teamName: 'team', runId: 'run-1' });
      expect(scheduler.schedule.mock.calls.map(([wake]) => wake.memberName)).toEqual([
        'alice',
        'bob',
      ]);
    });

    it.each(['stopped', 'stale primary', 'replacement during proof'])(
      'suppresses registration wake after %s',
      async (scenario) => {
        const scheduler = makeScheduler();
        let primaryRun = scenario === 'stale primary' ? 'run-2' : 'run-1';
        const coordinator = makeCoordinator({
          scheduler,
          inboxMessages: [unread],
          activeLaneIds: ['primary'],
          canDeliverToTeamRuntime: () => scenario !== 'stopped',
          resolveTrackedBootstrapRunId: () => (scenario === 'stopped' ? null : 'root-run-1'),
          resolveCurrentRuntimeRunId: async () => primaryRun,
          hasCommittedBootstrapSession: async () => {
            if (scenario === 'replacement during proof') primaryRun = 'run-2';
            return true;
          },
        });
        await coordinator.wakeAfterRuntimeRegistration({ teamName: 'team', runId: 'run-1' });
        expect(scheduler.schedule).not.toHaveBeenCalled();
      }
    );

    it('wakes only substantive unread stable messages without waiting for team ready or delivery', async () => {
      const scheduler = makeScheduler();
      const coordinator = makeCoordinator({
        scheduler,
        inboxMessages: [
          unread,
          { ...unread, messageId: 'read', read: true },
          { ...unread, messageId: 'empty', text: ' ' },
          { ...unread, messageId: undefined },
        ],
      });
      await expect(coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(1);
      expect(scheduler.schedule).toHaveBeenCalledExactlyOnceWith({
        teamName: 'team',
        memberName: 'alice',
        messageId: 'msg-1',
        delayMs: 500,
      });
    });

    it.each(['empty inbox', 'disabled', 'stopped', 'stale run'])(
      'does not wake for %s',
      async (scenario) => {
        const scheduler = makeScheduler();
        scheduler.isEnabled.mockReturnValue(scenario !== 'disabled');
        const coordinator = makeCoordinator({
          scheduler,
          inboxMessages: scenario === 'empty inbox' ? [] : [unread],
          canDeliverToTeamRuntime: () => scenario !== 'stopped',
          resolveTrackedBootstrapRunId: () => (scenario === 'stopped' ? null : 'root-run-1'),
          resolveCurrentRuntimeRunId: async () => (scenario === 'stale run' ? 'run-2' : 'run-1'),
        });
        await expect(coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(0);
        expect(scheduler.schedule).not.toHaveBeenCalled();
      }
    );

    it.each(['stop', 'relaunch'])('rechecks %s after reading the inbox', async (transition) => {
      const scheduler = makeScheduler();
      let currentRun = 'run-1';
      let active = true;
      const coordinator = makeCoordinator({
        scheduler,
        canDeliverToTeamRuntime: () => active,
        resolveTrackedBootstrapRunId: () => (active ? 'root-run-1' : null),
        resolveCurrentRuntimeRunId: async () => currentRun,
        getInboxMessages: async () => {
          if (transition === 'stop') active = false;
          else currentRun = 'run-2';
          return [unread];
        },
      });
      await expect(coordinator.wakeAfterBootstrapCommit(input)).resolves.toBe(0);
      expect(scheduler.schedule).not.toHaveBeenCalled();
    });

    it('coalesces repeated commits through the existing scheduler and cancels on Stop', async () => {
      vi.useFakeTimers();
      const relay = vi.fn(async () => undefined);
      const scheduler = new OpenCodePromptDeliveryWatchdogScheduler({
        canDeliverToTeamRuntime: () => true,
        recoverBeforeDelivery: async () => false,
        relay,
        getInboxMessages: async () => [unread],
        resolveIdentity: async () => ({ ok: true, laneId: 'lane-1' }),
        isLaneActive: async () => true,
        isRecordNotFoundError: () => false,
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        getErrorMessage: String,
      });
      try {
        const coordinator = makeCoordinator({ scheduler, inboxMessages: [unread] });
        await coordinator.wakeAfterBootstrapCommit(input);
        await coordinator.wakeAfterBootstrapCommit(input);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(relay).toHaveBeenCalledTimes(1);
        await coordinator.wakeAfterBootstrapCommit(input);
        scheduler.cancelTeam('team');
        await vi.advanceTimersByTimeAsync(500);
        expect(relay).toHaveBeenCalledTimes(1);
      } finally {
        scheduler.cancelTeam('team');
        vi.useRealTimers();
      }
    });
  });

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
