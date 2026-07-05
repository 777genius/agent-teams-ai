import { describe, expect, it, vi } from 'vitest';

import {
  commitOpenCodeInboxRelayReadAfterDelivery,
  handleOpenCodeInboxAttachmentFailure,
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
