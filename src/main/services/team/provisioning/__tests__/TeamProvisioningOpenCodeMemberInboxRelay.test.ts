import { describe, expect, it, vi } from 'vitest';

import { isOpenCodeReplyOptionalDeliveryContract } from '../../opencode/delivery/OpenCodeDeliveryReplyContract';
import {
  INBOX_RELAY_IN_FLIGHT_LEASE_MS,
  INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS,
} from '../TeamProvisioningInboxRelayCandidates';
import {
  commitOpenCodeInboxRelayReadAfterDelivery,
  handleOpenCodeInboxAttachmentFailure,
  type OpenCodeMemberInboxRelayResult,
  projectOpenCodeInboxDeliveryFailure,
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
  resolveOpenCodeMemberInboxDeliveryDecision,
  scheduleOpenCodeMemberInboxDeliveryWakeWithPorts,
  selectOpenCodeMemberInboxRelayUnreadMessages,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodePromptDeliveryLedgerStore } from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'user',
    to: 'worker',
    text: 'please check this',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'message-1',
    ...overrides,
  };
}

function ledgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team',
    memberName: 'worker',
    laneId: 'lane-worker',
    runId: null,
    inboxMessageId: 'message-1',
    inboxTimestamp: '2026-01-01T00:00:00.000Z',
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    messageKind: null,
    workSyncIntent: null,
    taskRefs: [],
    payloadHash: 'sha256:payload',
    status: 'pending',
    attempts: 0,
    diagnostics: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as OpenCodePromptDeliveryLedgerRecord;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRelayPorts(
  overrides: Partial<RelayOpenCodeMemberInboxMessagesPorts> = {}
): RelayOpenCodeMemberInboxMessagesPorts {
  return {
    inFlight: new Map(),
    readInboxMessages: vi.fn().mockResolvedValue([]),
    scheduleOpenCodeMemberInboxDeliveryWake: vi.fn(),
    isOpenCodeRuntimeRecipient: vi.fn().mockResolvedValue(true),
    resolveOpenCodeMemberDeliveryIdentity: vi.fn().mockResolvedValue({
      ok: true,
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      laneIdentity: { laneId: 'lane-worker', laneKind: 'secondary' },
    }),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ({
      getByInboxMessage: vi.fn().mockResolvedValue(null),
    })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi
      .fn()
      .mockImplementation(({ ledgerRecord }) => Promise.resolve(ledgerRecord)),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: vi
      .fn()
      .mockImplementation(({ ledgerRecord }) => Promise.resolve(ledgerRecord)),
    applyDestinationProof: vi.fn().mockRejectedValue(new Error('unused')),
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(false),
    markInboxMessagesRead: vi.fn().mockResolvedValue(undefined),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    readTaskRefInferenceTasks: vi.fn().mockResolvedValue([]),
    resolveOpenCodeInboxAttachmentPayloads: vi.fn().mockResolvedValue({
      ok: true,
      attachments: [],
    }),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn().mockResolvedValue('run-1'),
    markOpenCodePromptLedgerFailedTerminal: vi.fn(),
    deliverOpenCodeMemberMessage: vi.fn().mockResolvedValue({ delivered: true }),
    suppressRuntimeInactiveWarning: vi.fn().mockReturnValue(false),
    logWarning: vi.fn(),
    nowIso: () => '2026-01-01T00:00:00.000Z',
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeMemberInboxRelay', () => {
  it('sanitizes and schedules OpenCode member inbox delivery wakes', () => {
    const scheduleWake = vi.fn();

    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: ' team ',
          memberName: ' worker ',
          messageId: ' message-1 ',
        },
        {
          watchdogScheduler: { isEnabled: () => true },
          scheduleWake,
        }
      )
    ).toBe(true);

    expect(scheduleWake).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      messageId: 'message-1',
      delayMs: 500,
    });
  });

  it('clamps negative OpenCode member inbox delivery wake delays', () => {
    const scheduleWake = vi.fn();

    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: 'team',
          memberName: 'worker',
          messageId: 'message-1',
          delayMs: -25,
        },
        {
          watchdogScheduler: { isEnabled: () => true },
          scheduleWake,
        }
      )
    ).toBe(true);

    expect(scheduleWake).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      messageId: 'message-1',
      delayMs: 0,
    });
  });

  it('skips OpenCode member inbox delivery wakes for empty fields or disabled scheduler', () => {
    const scheduleWake = vi.fn();
    const enabledPorts = {
      watchdogScheduler: { isEnabled: () => true },
      scheduleWake,
    };

    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: '',
          memberName: 'worker',
          messageId: 'message-1',
        },
        enabledPorts
      )
    ).toBe(false);
    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: 'team',
          memberName: ' ',
          messageId: 'message-1',
        },
        enabledPorts
      )
    ).toBe(false);
    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: 'team',
          memberName: 'worker',
          messageId: ' ',
        },
        enabledPorts
      )
    ).toBe(false);
    expect(
      scheduleOpenCodeMemberInboxDeliveryWakeWithPorts(
        {
          teamName: 'team',
          memberName: 'worker',
          messageId: 'message-1',
        },
        {
          watchdogScheduler: { isEnabled: () => false },
          scheduleWake,
        }
      )
    ).toBe(false);

    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it('retains newly started work after caller timeout and coalesces an immediate retry', async () => {
    vi.useFakeTimers();
    try {
      const runtimeCheck = deferred<boolean>();
      const isOpenCodeRuntimeRecipient = vi.fn(() => runtimeCheck.promise);
      const ports = createRelayPorts({ isOpenCodeRuntimeRecipient });
      const input = {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      };

      const first = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      const work = ports.inFlight.get(input.relayKey);
      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);

      await expect(first).resolves.toMatchObject({
        failed: 1,
        lastDelivery: { reason: 'opencode_member_inbox_relay_timed_out' },
      });
      expect(ports.inFlight.get(input.relayKey)).toBe(work);

      const retry = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      expect(isOpenCodeRuntimeRecipient).toHaveBeenCalledTimes(1);
      runtimeCheck.resolve(false);

      await expect(retry).resolves.toMatchObject({
        lastDelivery: { reason: 'recipient_is_not_opencode' },
      });
      expect(ports.inFlight.has(input.relayKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains existing work after caller timeout and cleans it when the work resolves', async () => {
    vi.useFakeTimers();
    try {
      const existing = deferred<OpenCodeMemberInboxRelayResult>();
      const ports = createRelayPorts();
      ports.inFlight.set('team/worker', existing.promise);

      const relay = relayOpenCodeMemberInboxMessagesWithPorts(
        { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
        ports
      );
      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);

      await expect(relay).resolves.toMatchObject({
        failed: 1,
        lastDelivery: { reason: 'opencode_member_inbox_relay_timed_out' },
      });
      expect(ports.inFlight.get('team/worker')).toBe(existing.promise);

      existing.resolve({ relayed: 0, attempted: 0, delivered: 0, failed: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(ports.inFlight.has('team/worker')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces never-settling relay work after its bounded lease', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = deferred<boolean>();
      const isOpenCodeRuntimeRecipient = vi
        .fn<RelayOpenCodeMemberInboxMessagesPorts['isOpenCodeRuntimeRecipient']>()
        .mockImplementationOnce(() => neverSettles.promise)
        .mockResolvedValueOnce(false);
      const ports = createRelayPorts({ isOpenCodeRuntimeRecipient });
      const input = {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      };

      const first = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      const staleWork = ports.inFlight.get(input.relayKey);
      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);
      await first;
      await vi.advanceTimersByTimeAsync(
        INBOX_RELAY_IN_FLIGHT_LEASE_MS - INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS
      );

      await expect(relayOpenCodeMemberInboxMessagesWithPorts(input, ports)).resolves.toMatchObject({
        lastDelivery: { reason: 'recipient_is_not_opencode' },
      });
      expect(isOpenCodeRuntimeRecipient).toHaveBeenCalledTimes(2);
      expect(ports.inFlight.get(input.relayKey)).not.toBe(staleWork);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let stale settlement clear replacement relay work', async () => {
    vi.useFakeTimers();
    try {
      const staleRuntimeCheck = deferred<boolean>();
      const replacementRuntimeCheck = deferred<boolean>();
      const isOpenCodeRuntimeRecipient = vi
        .fn<RelayOpenCodeMemberInboxMessagesPorts['isOpenCodeRuntimeRecipient']>()
        .mockImplementationOnce(() => staleRuntimeCheck.promise)
        .mockImplementationOnce(() => replacementRuntimeCheck.promise);
      const ports = createRelayPorts({ isOpenCodeRuntimeRecipient });
      const input = {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      };

      const staleCall = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);
      await staleCall;
      await vi.advanceTimersByTimeAsync(
        INBOX_RELAY_IN_FLIGHT_LEASE_MS - INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS
      );

      const replacementCall = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      const replacementWork = ports.inFlight.get(input.relayKey);
      staleRuntimeCheck.resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(ports.inFlight.get(input.relayKey)).toBe(replacementWork);

      replacementRuntimeCheck.resolve(false);
      await expect(replacementCall).resolves.toMatchObject({
        lastDelivery: { reason: 'recipient_is_not_opencode' },
      });
      expect(ports.inFlight.has(input.relayKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences stale relay work before it can deliver after lease replacement', async () => {
    vi.useFakeTimers();
    try {
      const staleRuntimeCheck = deferred<boolean>();
      const replacementInboxRead = deferred<readonly RelayInboxMessage[]>();
      const isOpenCodeRuntimeRecipient = vi
        .fn<RelayOpenCodeMemberInboxMessagesPorts['isOpenCodeRuntimeRecipient']>()
        .mockImplementationOnce(() => staleRuntimeCheck.promise)
        .mockResolvedValueOnce(true);
      const readInboxMessages = vi
        .fn<RelayOpenCodeMemberInboxMessagesPorts['readInboxMessages']>()
        .mockImplementationOnce(() => replacementInboxRead.promise);
      const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({ delivered: true });
      const ports = createRelayPorts({
        isOpenCodeRuntimeRecipient,
        readInboxMessages,
        deliverOpenCodeMemberMessage,
      });
      const input = {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      };

      const staleCall = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      const staleWork = ports.inFlight.get(input.relayKey);
      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);
      await staleCall;
      await vi.advanceTimersByTimeAsync(
        INBOX_RELAY_IN_FLIGHT_LEASE_MS - INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS
      );

      const replacementCall = relayOpenCodeMemberInboxMessagesWithPorts(input, ports);
      await vi.advanceTimersByTimeAsync(0);
      staleRuntimeCheck.resolve(true);
      await vi.advanceTimersByTimeAsync(0);

      await expect(staleWork).resolves.toMatchObject({
        attempted: 0,
        delivered: 0,
        lastDelivery: { reason: 'opencode_member_inbox_relay_superseded' },
      });
      expect(readInboxMessages).toHaveBeenCalledTimes(1);
      expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();

      replacementInboxRead.resolve([message()]);
      await expect(replacementCall).resolves.toMatchObject({
        attempted: 1,
        delivered: 1,
      });
      expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans relay ownership when work rejects', async () => {
    const ports = createRelayPorts({
      isOpenCodeRuntimeRecipient: vi.fn().mockRejectedValue(new Error('runtime check failed')),
    });

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
        ports
      )
    ).rejects.toThrow('runtime check failed');
    expect(ports.inFlight.has('team/worker')).toBe(false);
  });

  it('isolates only-message requests behind active work but recovers them after lease expiry', async () => {
    vi.useFakeTimers();
    try {
      const staleWork = new Promise<OpenCodeMemberInboxRelayResult>(() => undefined);
      const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({
        delivered: true,
        responsePending: true,
        reason: 'opencode_delivery_response_pending',
      });
      const ports = createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        deliverOpenCodeMemberMessage,
      });
      ports.inFlight.set('team/worker', staleWork);
      const input = {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { onlyMessageId: 'message-1' },
      };

      await expect(relayOpenCodeMemberInboxMessagesWithPorts(input, ports)).resolves.toMatchObject({
        lastDelivery: { reason: 'opencode_inbox_relay_queued_behind_active_relay' },
      });
      expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
      expect(ports.inFlight.get(input.relayKey)).toBe(staleWork);

      await vi.advanceTimersByTimeAsync(INBOX_RELAY_IN_FLIGHT_LEASE_MS);
      await expect(relayOpenCodeMemberInboxMessagesWithPorts(input, ports)).resolves.toMatchObject({
        attempted: 1,
        lastDelivery: { reason: 'opencode_delivery_response_pending' },
      });
      expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
      expect(ports.inFlight.has(input.relayKey)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects only-message delivery while another member relay is active', async () => {
    const inFlight = new Map<string, Promise<never>>();
    inFlight.set('team/worker', new Promise(() => {}));
    const scheduleOpenCodeMemberInboxDeliveryWake = vi.fn();

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        {
          teamName: 'team',
          memberName: 'worker',
          relayKey: 'team/worker',
          options: { onlyMessageId: 'work-sync' },
        },
        createRelayPorts({
          inFlight,
          readInboxMessages: vi.fn().mockResolvedValue([
            message({
              messageId: 'work-sync',
              read: true,
              messageKind: 'member_work_sync_nudge',
            }),
          ]),
          scheduleOpenCodeMemberInboxDeliveryWake,
        })
      )
    ).resolves.toMatchObject({
      attempted: 1,
      lastDelivery: {
        delivered: true,
        responsePending: true,
        reason: 'opencode_work_sync_read_commit_waiting_for_active_relay',
      },
    });
    expect(scheduleOpenCodeMemberInboxDeliveryWake).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      messageId: 'work-sync',
      delayMs: 500,
    });
  });

  it('recovers terminal ledger records and commits the inbox read before delivery retry', async () => {
    const terminal = ledgerRecord({
      status: 'failed_terminal',
      lastReason: 'opencode_prompt_delivery_failed_terminal',
      diagnostics: ['terminal'],
    });
    const recovered = ledgerRecord({
      id: 'recovered-record',
      status: 'responded',
      responseState: 'responded_visible_message',
    });
    const committed = ledgerRecord({
      ...recovered,
      status: 'responded',
      inboxReadCommittedAt: '2026-01-01T00:00:00.000Z',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      diagnostics: ['committed'],
    });
    const getByInboxMessage = vi.fn().mockResolvedValue(terminal);
    const markInboxReadCommitted = vi.fn().mockResolvedValue(committed);
    const applyDestinationProof = vi.fn();
    const ledger = {
      getByInboxMessage,
      markInboxReadCommitted,
      applyDestinationProof,
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const deliverOpenCodeMemberMessage = vi.fn();
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);
    const logOpenCodePromptDeliveryEvent = vi.fn();

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { onlyMessageId: 'message-1' },
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        applyDestinationProof: vi.fn().mockResolvedValue({
          ledgerRecord: recovered,
          visibleReply: {
            inboxName: 'user',
            message: message({ messageId: 'reply-1' }),
          },
        }),
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(true),
        markInboxMessagesRead,
        logOpenCodePromptDeliveryEvent,
        deliverOpenCodeMemberMessage,
      })
    );

    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [message()]);
    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'recovered-record',
      committedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      committed,
      { recoveredTerminal: true }
    );
    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      relayed: 1,
      delivered: 1,
      lastDelivery: {
        delivered: true,
        accepted: true,
        ledgerStatus: 'responded',
        ledgerRecordId: 'recovered-record',
        visibleReplyMessageId: 'reply-1',
      },
    });
  });

  it('does not let a batch-sized prefix of terminal rows starve later delivery', async () => {
    const terminalMessages = Array.from({ length: 10 }, (_, index) =>
      message({ messageId: `terminal-${String(index).padStart(2, '0')}` })
    );
    const deliverableMessage = message({ messageId: 'zz-deliverable' });
    const getByInboxMessage = vi.fn(({ inboxMessageId }: { inboxMessageId: string }) =>
      Promise.resolve(
        inboxMessageId.startsWith('terminal-')
          ? ledgerRecord({
              id: `record-${inboxMessageId}`,
              inboxMessageId,
              status: 'failed_terminal',
              lastReason: 'opencode_prompt_delivery_failed_terminal',
              diagnostics: ['terminal'],
            })
          : null
      )
    );
    const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({ delivered: true });
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([...terminalMessages, deliverableMessage]),
        createOpenCodePromptDeliveryLedger: vi.fn(
          () => ({ getByInboxMessage }) as unknown as OpenCodePromptDeliveryLedgerStore
        ),
        deliverOpenCodeMemberMessage,
        markInboxMessagesRead,
      })
    );

    expect(getByInboxMessage).toHaveBeenCalledTimes(11);
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledOnce();
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ messageId: 'zz-deliverable' })
    );
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [deliverableMessage]);
    expect(result).toMatchObject({
      attempted: 1,
      delivered: 1,
      relayed: 1,
      failed: 0,
    });
  });

  it('hands a newer user message to the delivery service when a non-user delivery stays pending', async () => {
    const pendingNotification = message({
      messageId: 'task-comment-forward:1',
      from: 'system',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      text: 'Task comment: section done.',
    });
    const teammateReport = message({
      messageId: 'teammate-report',
      from: 'Scribe',
      text: 'done with section 2',
    });
    const userFollowUp = message({ messageId: 'user-2', from: 'user', text: 'wrap up please' });
    const deliverOpenCodeMemberMessage = vi.fn(
      (_teamName: string, input: { messageId?: string; replyRecipient?: string }) =>
        Promise.resolve(
          input.replyRecipient === 'user'
            ? { delivered: true, accepted: true, responsePending: false, laneId: 'primary' }
            : {
                delivered: true,
                accepted: true,
                responsePending: true,
                reason: 'opencode_delivery_response_pending',
              }
        )
    );
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead' },
      createRelayPorts({
        readInboxMessages: vi
          .fn()
          .mockResolvedValue([pendingNotification, teammateReport, userFollowUp]),
        deliverOpenCodeMemberMessage: deliverOpenCodeMemberMessage as never,
        markInboxMessagesRead,
      })
    );

    // The pending notification is attempted with the teammate report coalesced
    // into the same prompt (both reply-optional), and the user message reaches
    // deliver() on its own.
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(2);
    expect(deliverOpenCodeMemberMessage.mock.calls.map(([, input]) => input.messageId)).toEqual([
      'task-comment-forward:1',
      'user-2',
    ]);
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'team-lead', [teammateReport]);
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'team-lead', [userFollowUp]);
    expect(result).toMatchObject({ attempted: 2, delivered: 1, relayed: 2, failed: 0 });
  });

  it('coalesces queued reply-optional notices into one delivery and stops at the first reply-required message', async () => {
    const comment = message({
      messageId: 'task-comment-forward:1',
      from: 'Scribe',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      text: 'Top 3 risks posted.',
    });
    const dependencyResolved = message({
      messageId: 'task-comment-forward:2',
      from: 'system',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      text: 'Dependency resolved for #a36889d4.',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const drafterStarted = message({
      messageId: 'drafter-started',
      from: 'Drafter',
      source: 'system_notification',
      text: '@Drafter started task #a36889d4',
      timestamp: '2026-01-01T00:00:02.000Z',
    });
    const scribeDone = message({
      messageId: 'scribe-done',
      from: 'Scribe',
      text: '#de5126de done. Risks are on the board.',
      timestamp: '2026-01-01T00:00:03.000Z',
    });
    const userFollowUp = message({
      messageId: 'user-2',
      from: 'user',
      text: 'status?',
      timestamp: '2026-01-01T00:00:04.000Z',
    });
    const trailingNotice = message({
      messageId: 'drafter-done',
      from: 'Drafter',
      text: '#a36889d4 done.',
      timestamp: '2026-01-01T00:00:05.000Z',
    });
    const deliverOpenCodeMemberMessage = vi.fn(
      (_teamName: string, input: { messageId?: string; replyRecipient?: string; text: string }) =>
        Promise.resolve(
          input.replyRecipient === 'user'
            ? { delivered: true, accepted: true, responsePending: false, laneId: 'primary' }
            : {
                delivered: true,
                accepted: true,
                responsePending: true,
                reason: 'opencode_delivery_response_pending',
              }
        )
    );
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead' },
      createRelayPorts({
        readInboxMessages: vi
          .fn()
          .mockResolvedValue([
            comment,
            dependencyResolved,
            scribeDone,
            drafterStarted,
            userFollowUp,
            trailingNotice,
          ]),
        deliverOpenCodeMemberMessage: deliverOpenCodeMemberMessage as never,
        markInboxMessagesRead,
      })
    );

    // Relay order: system notifications first (priority), then the rest by
    // time. The first notice carries the next three reply-optional rows; the
    // user message is delivered alone; the trailing notice waits for the next
    // relay run (one committed delivery per run).
    expect(deliverOpenCodeMemberMessage.mock.calls.map(([, input]) => input.messageId)).toEqual([
      'task-comment-forward:1',
      'user-2',
    ]);
    const coalescedText = deliverOpenCodeMemberMessage.mock.calls[0]?.[1]?.text ?? '';
    expect(coalescedText).toContain('Top 3 risks posted.');
    expect(coalescedText).toContain('<opencode_coalesced_notices count="3">');
    expect(coalescedText).toContain('notice 1 (from system, messageId task-comment-forward:2');
    expect(coalescedText).toContain('#de5126de done. Risks are on the board.');
    expect(coalescedText).toContain('@Drafter started task #a36889d4');
    // The user prompt ends the run, so neither it nor the notice behind it is
    // folded into the notice prompt.
    expect(coalescedText).not.toContain('status?');
    expect(coalescedText).not.toContain('#a36889d4 done.');
    expect(deliverOpenCodeMemberMessage.mock.calls[1]?.[1]?.text).toBe('status?');
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'team-lead', [
      dependencyResolved,
      drafterStarted,
      scribeDone,
    ]);
    expect(result).toMatchObject({ attempted: 2, delivered: 1, relayed: 4, failed: 0 });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('opencode_inbox_relay_coalesced_notices')])
    );
  });

  it('does not coalesce a reply-required message and does not coalesce through nudges', async () => {
    const notice = message({
      messageId: 'notice-1',
      from: 'system',
      source: 'system_notification',
      text: 'Dependency resolved.',
    });
    const userPrompt = message({
      messageId: 'user-1',
      from: 'user',
      text: 'plan it',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    const deliverOpenCodeMemberMessage = vi.fn(
      (_teamName: string, input: { replyRecipient?: string; text: string }) =>
        Promise.resolve(
          input.replyRecipient === 'user'
            ? { delivered: true, accepted: true, responsePending: false, laneId: 'primary' }
            : {
                delivered: true,
                accepted: true,
                responsePending: true,
                reason: 'opencode_delivery_response_pending',
              }
        )
    );
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);
    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([notice, userPrompt]),
        deliverOpenCodeMemberMessage: deliverOpenCodeMemberMessage as never,
        markInboxMessagesRead,
      })
    );
    // The notice is delivered alone (the user prompt is never coalesced) and
    // the user prompt follows on its own.
    expect(deliverOpenCodeMemberMessage.mock.calls.map(([, input]) => input.text)).toEqual([
      'Dependency resolved.',
      'plan it',
    ]);
    // The only read commit is the user prompt's own: the notice stayed pending
    // and the user prompt was never carried by it.
    expect(
      markInboxMessagesRead.mock.calls.map((call) =>
        (call[2] as RelayInboxMessage[]).map((entry) => entry.messageId)
      )
    ).toEqual([['user-1']]);

    const nudge = message({
      messageId: 'member-work-sync:1',
      from: 'system',
      source: 'system_notification',
      messageKind: 'member_work_sync_nudge',
      text: 'Work sync check',
    });
    const laterNotice = message({
      messageId: 'notice-2',
      from: 'Scribe',
      text: '#1 done.',
      timestamp: '2026-01-01T00:00:02.000Z',
    });
    const deliverAgain = vi.fn((_teamName: string, _input: { text: string }) =>
      Promise.resolve({
        delivered: true,
        accepted: true,
        responsePending: true,
        reason: 'opencode_delivery_response_pending',
      })
    );
    const markAgain = vi.fn().mockResolvedValue(undefined);
    await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead-2' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([nudge, notice, laterNotice]),
        deliverOpenCodeMemberMessage: deliverAgain as never,
        markInboxMessagesRead: markAgain,
      })
    );
    // Nudges are never coalesced (they carry their own contract) and nothing
    // is coalesced into them.
    expect(deliverAgain).toHaveBeenCalledTimes(1);
    expect(deliverAgain.mock.calls[0]?.[1]?.text).toBe('Work sync check');
    expect(markAgain).not.toHaveBeenCalled();
  });

  it('stops at a pending non-user delivery when no unread user message follows', async () => {
    const pendingNotification = message({
      messageId: 'task-comment-forward:1',
      from: 'system',
      source: 'system_notification',
      messageKind: 'task_comment_notification',
      text: 'Task comment: section done.',
    });
    const teammateReport = message({
      messageId: 'teammate-report',
      from: 'Scribe',
      text: 'done with section 2',
    });
    const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({
      delivered: true,
      accepted: true,
      responsePending: true,
      reason: 'opencode_delivery_response_pending',
    });

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([pendingNotification, teammateReport]),
        deliverOpenCodeMemberMessage,
      })
    );

    // Only a user message earns the skip; another non-user notice would just
    // queue behind the same blocker, so the walk stops instead of looping.
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ attempted: 1, delivered: 0 });
  });

  it('keeps inbox order when the pending delivery is itself a user prompt', async () => {
    const firstUserPrompt = message({ messageId: 'user-1', from: 'user', text: 'plan it' });
    const secondUserPrompt = message({ messageId: 'user-2', from: 'user', text: 'and ship it' });
    const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({
      delivered: true,
      accepted: true,
      responsePending: true,
      reason: 'opencode_delivery_response_pending',
    });

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'team-lead', relayKey: 'team/team-lead' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([firstUserPrompt, secondUserPrompt]),
        deliverOpenCodeMemberMessage,
      })
    );

    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledOnce();
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ messageId: 'user-1' })
    );
    expect(result).toMatchObject({ attempted: 1, delivered: 0 });
  });

  it('projects already-read rows with committed ledger proof as explicit accepted delivery', async () => {
    const committed = ledgerRecord({
      id: 'committed-record',
      status: 'responded',
      responseState: 'responded_visible_message',
      inboxReadCommittedAt: '2026-01-01T00:00:01.000Z',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
    });
    const getByInboxMessage = vi.fn().mockResolvedValue(committed);
    const deliverOpenCodeMemberMessage = vi.fn();

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { onlyMessageId: 'message-1' },
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message({ read: true })]),
        createOpenCodePromptDeliveryLedger: vi.fn(
          () =>
            ({
              getByInboxMessage,
            }) as unknown as OpenCodePromptDeliveryLedgerStore
        ),
        deliverOpenCodeMemberMessage,
      })
    );

    expect(getByInboxMessage).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      laneId: 'lane-worker',
      inboxMessageId: 'message-1',
    });
    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'responded',
        ledgerRecordId: 'committed-record',
        laneId: 'lane-worker',
        visibleReplyMessageId: 'reply-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        reason: 'opencode_inbox_read_already_committed',
      },
    });
  });

  it('selects deliverable unread rows while preserving work-sync read retry semantics', () => {
    const rows = [
      message({ messageId: 'read-normal', read: true }),
      message({
        messageId: 'read-work-sync',
        read: true,
        messageKind: 'member_work_sync_nudge',
      }),
      message({ messageId: 'blank', text: '  ' }),
      message({ messageId: '', text: 'missing stable id' }),
      message({ messageId: 'unread', timestamp: '2026-01-01T00:00:01.000Z' }),
    ];

    expect(selectOpenCodeMemberInboxRelayUnreadMessages({ inboxMessages: rows })).toEqual([
      rows[4],
    ]);
    expect(
      selectOpenCodeMemberInboxRelayUnreadMessages({
        inboxMessages: rows,
        onlyMessageId: 'read-work-sync',
      })
    ).toEqual([rows[1]]);
  });

  it('shapes delivery decisions from existing ledger, metadata, message, and inferred fallback', () => {
    const taskRef = { teamName: 'team', taskId: 'task-1', displayId: '7' };
    const existing = ledgerRecord({
      replyRecipient: 'lead',
      actionMode: 'ask',
      source: 'manual',
      taskRefs: [taskRef],
    });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({
          from: 'worker',
          taskRefs: [{ teamName: 'team', taskId: 'message', displayId: 'message' }],
        }),
        existingRecord: existing,
        deliveryMetadata: {
          replyRecipient: 'metadata',
          actionMode: 'do',
          taskRefs: [{ teamName: 'team', taskId: 'metadata', displayId: 'metadata' }],
        },
        inferredTaskRefs: [{ teamName: 'team', taskId: 'inferred', displayId: 'inferred' }],
        source: 'ui-send',
      })
    ).toEqual({
      replyRecipient: 'lead',
      actionMode: 'ask',
      taskRefs: [taskRef],
      source: 'manual',
    });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'worker' }),
        deliveryMetadata: {
          replyRecipient: 'metadata',
          actionMode: 'do',
        },
        inferredTaskRefs: [],
      })
    ).toMatchObject({
      replyRecipient: 'metadata',
      actionMode: 'do',
      source: 'watcher',
    });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'reviewer' }),
        inferredTaskRefs: [taskRef],
        source: 'watchdog',
      })
    ).toEqual({
      replyRecipient: 'reviewer',
      actionMode: null,
      taskRefs: [taskRef],
      source: 'watchdog',
    });
  });

  it('never turns an unaddressable sender into a reply contract', () => {
    const taskRef = { teamName: 'team', taskId: 'task-1', displayId: '7' };

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system', taskRefs: [taskRef] }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'system' });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system' }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'user' });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: '' }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'user' });
  });

  // A task notice from an unaddressable sender that names its task only in the
  // message text carries inferred references instead of structured taskRefs. It
  // is the same notice, so it must be delivered as informational: classifying it
  // as a user reply contract made the runtime demand a visible message_send to
  // the human user for an automated notice nobody could answer.
  it('classifies an inferred task-reference notice from an unaddressable sender as informational', () => {
    const inferred = { teamName: 'team', taskId: 'task-1', displayId: '7' };

    const emptySender = resolveOpenCodeMemberInboxDeliveryDecision({
      memberName: 'worker',
      message: message({ from: '', text: 'Dependency resolved for #7.' }),
      inferredTaskRefs: [inferred],
    });
    expect(emptySender).toEqual({
      replyRecipient: 'system',
      actionMode: null,
      taskRefs: [inferred],
      source: 'watcher',
    });
    expect(isOpenCodeReplyOptionalDeliveryContract(emptySender.replyRecipient)).toBe(true);

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system', text: 'Dependency resolved for #7.' }),
        inferredTaskRefs: [inferred],
      })
    ).toMatchObject({ replyRecipient: 'system', taskRefs: [inferred] });

    // Negative controls: inferred references alone never make a delivery
    // informational. An addressable sender stays the reply recipient — a lead
    // question about a task is still owed a visible answer — and an
    // unaddressable sender without any task reference still falls back to
    // "user" so the message stays answerable.
    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'alice', text: 'Can you take #7?' }),
        inferredTaskRefs: [inferred],
      })
    ).toMatchObject({ replyRecipient: 'alice', taskRefs: [inferred] });

    const leadSender = resolveOpenCodeMemberInboxDeliveryDecision({
      memberName: 'worker',
      message: message({ from: 'team-lead', text: 'What is the state of #7?' }),
      inferredTaskRefs: [inferred],
    });
    expect(leadSender).toMatchObject({ replyRecipient: 'team-lead', taskRefs: [inferred] });
    expect(isOpenCodeReplyOptionalDeliveryContract(leadSender.replyRecipient)).toBe(false);

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system' }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'user' });
  });

  it('marks system notifications as informational deliveries regardless of sender', () => {
    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'lead', source: 'system_notification' }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'system' });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system', source: 'system_notification' }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'system' });

    const existing = ledgerRecord({ replyRecipient: 'lead' });
    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'system', source: 'system_notification' }),
        existingRecord: existing,
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'lead' });
  });

  // Negative control: the taskRefs rule only makes a notice informational when
  // the sender is unaddressable. A real teammate that happens to attach task
  // references is still owed an answer, and its name must stay the recipient.
  it('keeps an addressable teammate with taskRefs on a reply contract', () => {
    const taskRef = { teamName: 'team', taskId: 'task-1', displayId: '7' };

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'alice', taskRefs: [taskRef] }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'alice' });

    expect(
      resolveOpenCodeMemberInboxDeliveryDecision({
        memberName: 'worker',
        message: message({ from: 'user', taskRefs: [taskRef] }),
        inferredTaskRefs: [],
      })
    ).toMatchObject({ replyRecipient: 'user' });
  });

  // Startup inbox backfill (#534): the task watch registry replays every scoped
  // inbox file when the app starts. A row that was already read in an earlier
  // run has been answered; re-delivering it spends a full model turn on a
  // message the member has already handled.
  it('never re-delivers an already-read row replayed by the startup inbox backfill', async () => {
    const backfilled = [message({ messageId: 'backfilled-read', read: true })];
    const deliverOpenCodeMemberMessage = vi.fn();

    expect(selectOpenCodeMemberInboxRelayUnreadMessages({ inboxMessages: backfilled })).toEqual([]);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue(backfilled),
        deliverOpenCodeMemberMessage,
      })
    );

    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, delivered: 0, relayed: 0, failed: 0 });
  });

  it('delivers an unread backfilled row exactly once and not again on the next startup', async () => {
    const unread = message({ messageId: 'backfilled-unread' });
    const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({ delivered: true });
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);

    const firstStartup = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([unread]),
        deliverOpenCodeMemberMessage,
        markInboxMessagesRead,
      })
    );

    expect(firstStartup).toMatchObject({ attempted: 1, delivered: 1, relayed: 1 });
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [unread]);

    const secondStartup = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([{ ...unread, read: true }]),
        deliverOpenCodeMemberMessage,
        markInboxMessagesRead,
      })
    );

    expect(secondStartup).toMatchObject({ attempted: 0, delivered: 0, relayed: 0 });
    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
  });

  it('turns attachment payload failures into terminal ledger records and relay results', async () => {
    const markedAt = '2026-01-01T00:00:00.000Z';
    const pending = ledgerRecord({ id: 'pending-record', createdAt: markedAt });
    const failed = ledgerRecord({ id: 'failed-record', status: 'failed_terminal' });
    const ensurePending = vi.fn().mockResolvedValue(pending);
    const markFailedTerminal = vi.fn().mockResolvedValue(failed);
    const logPromptDeliveryEvent = vi.fn();

    const result = await handleOpenCodeInboxAttachmentFailure({
      teamName: 'team',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message({
        attachments: [
          { id: 'attachment-1', filename: 'screen.png', mimeType: 'image/png', size: 128 },
        ],
      }),
      decision: {
        replyRecipient: 'user',
        actionMode: null,
        taskRefs: [{ teamName: 'team', taskId: 'task-1', displayId: '7' }],
        source: 'watcher',
      },
      attachmentPayloads: {
        ok: false,
        reason: 'opencode_inbox_attachment_payload_unavailable: attachment-1',
        diagnostics: ['opencode_inbox_attachment_payload_unavailable: attachment-1'],
      },
      ports: {
        ledger: { ensurePending } as unknown as OpenCodePromptDeliveryLedgerStore,
        resolveCurrentOpenCodeRuntimeRunId: vi.fn().mockResolvedValue('run-1'),
        markFailedTerminal,
        logPromptDeliveryEvent,
        nowIso: () => markedAt,
        getErrorMessage: (error) => String(error),
      },
    });

    expect(ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team',
        memberName: 'worker',
        laneId: 'lane-worker',
        runId: 'run-1',
        inboxMessageId: 'message-1',
        payloadHash: expect.stringMatching(/^sha256:/),
      })
    );
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pending-record',
        reason: 'opencode_inbox_attachment_payload_unavailable: attachment-1',
        eventContext: { attachmentPayloadUnavailable: true },
      })
    );
    expect(logPromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_ledger_created',
      pending
    );
    expect(result).toMatchObject({
      failed: 1,
      lastDelivery: {
        delivered: false,
        accepted: false,
        ledgerStatus: 'failed_terminal',
        ledgerRecordId: 'failed-record',
      },
      diagnostics: ['opencode_inbox_attachment_payload_unavailable: attachment-1'],
    });
  });

  it('surfaces accepted terminal failures instead of projecting them as pending', () => {
    expect(
      projectOpenCodeInboxDeliveryFailure({
        delivery: {
          delivered: false,
          accepted: true,
          ledgerStatus: 'failed_terminal',
          reason: 'idle_without_required_reply',
        },
        suppressRuntimeInactiveWarning: false,
      })
    ).toMatchObject({ result: { failed: 1 }, shouldLogWarning: true });
  });

  it('projects delivery failures without warning for pending acceptance or suppressed runtime inactive', () => {
    expect(
      projectOpenCodeInboxDeliveryFailure({
        delivery: {
          delivered: false,
          accepted: true,
          reason: 'opencode_delivery_response_pending',
        },
        suppressRuntimeInactiveWarning: false,
      })
    ).toMatchObject({
      result: {
        failed: 0,
        diagnostics: ['opencode_delivery_response_pending'],
      },
      shouldLogWarning: false,
    });

    expect(
      projectOpenCodeInboxDeliveryFailure({
        delivery: {
          delivered: false,
          reason: 'opencode_runtime_not_active',
        },
        suppressRuntimeInactiveWarning: true,
      })
    ).toMatchObject({
      result: {
        failed: 1,
        diagnostics: ['opencode_runtime_not_active'],
      },
      shouldLogWarning: false,
    });

    expect(
      projectOpenCodeInboxDeliveryFailure({
        delivery: {
          delivered: false,
          reason: 'opencode_runtime_not_active',
        },
        suppressRuntimeInactiveWarning: false,
      }).shouldLogWarning
    ).toBe(true);
  });

  it('commits inbox reads and marks ledger commit failures when read persistence fails', async () => {
    const committed = ledgerRecord({ id: 'record-1', inboxReadCommittedAt: 'committed' });
    const failedCommit = ledgerRecord({
      id: 'record-1',
      inboxReadCommitError: 'opencode_inbox_mark_read_failed_after_delivery: disk failed',
    });
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);
    const markInboxReadCommitted = vi.fn().mockResolvedValue(committed);
    const markInboxReadCommitFailed = vi.fn().mockResolvedValue(failedCommit);
    const logPromptDeliveryEvent = vi.fn();
    const ledger = {
      markInboxReadCommitted,
      markInboxReadCommitFailed,
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const createOpenCodePromptDeliveryLedger = vi.fn(() => ledger);

    await expect(
      commitOpenCodeInboxRelayReadAfterDelivery({
        teamName: 'team',
        memberName: 'worker',
        message: message(),
        delivery: { delivered: true, ledgerRecordId: 'record-1', laneId: 'lane-worker' },
        ports: {
          markInboxMessagesRead,
          createOpenCodePromptDeliveryLedger,
          logPromptDeliveryEvent,
          nowIso: () => '2026-01-01T00:00:01.000Z',
          getErrorMessage: (error) => String(error),
        },
      })
    ).resolves.toEqual({ ok: true });
    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'record-1',
      committedAt: '2026-01-01T00:00:01.000Z',
    });

    markInboxMessagesRead.mockRejectedValueOnce(new Error('disk failed'));
    await expect(
      commitOpenCodeInboxRelayReadAfterDelivery({
        teamName: 'team',
        memberName: 'worker',
        message: message(),
        delivery: { delivered: true, ledgerRecordId: 'record-1', laneId: 'lane-worker' },
        ports: {
          markInboxMessagesRead,
          createOpenCodePromptDeliveryLedger,
          logPromptDeliveryEvent,
          nowIso: () => '2026-01-01T00:00:02.000Z',
          getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      diagnostic: 'opencode_inbox_mark_read_failed_after_delivery: disk failed',
      result: {
        failed: 1,
        lastDelivery: {
          delivered: false,
          reason: 'opencode_inbox_mark_read_failed_after_delivery',
        },
      },
    });
    expect(markInboxReadCommitFailed).toHaveBeenCalledWith({
      id: 'record-1',
      error: 'opencode_inbox_mark_read_failed_after_delivery: disk failed',
      failedAt: '2026-01-01T00:00:02.000Z',
    });
  });
});
