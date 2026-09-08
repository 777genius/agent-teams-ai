import { describe, expect, it, vi } from 'vitest';

import { isOpenCodePromptDeliveryWatchdogRecordTerminal } from '../../opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import {
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '../TeamProvisioningOpenCodeMemberInboxRelay';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '../TeamProvisioningInboxRelayPolicy';

const NOW_ISO = '2026-01-01T00:00:00.000Z';

function message(overrides: Partial<RelayInboxMessage> = {}): RelayInboxMessage {
  return {
    from: 'user',
    to: 'worker',
    text: 'please check this',
    timestamp: NOW_ISO,
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
    inboxTimestamp: NOW_ISO,
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    messageKind: null,
    workSyncIntent: null,
    taskRefs: [],
    payloadHash: 'sha256:payload',
    status: 'responded',
    responseState: 'responded_visible_message',
    attempts: 3,
    inboxReadCommittedAt: null,
    diagnostics: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
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
      .mockImplementation(({ ledgerRecord: record }) => Promise.resolve(record)),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: vi
      .fn()
      .mockImplementation(({ ledgerRecord: record }) => Promise.resolve(record)),
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
    nowIso: () => NOW_ISO,
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeMemberInboxRelay read-commit recovery', () => {
  it('commits an owed read for a responded record from proof, without a delivery attempt', async () => {
    const responded = ledgerRecord();
    const committed = ledgerRecord({
      inboxReadCommittedAt: NOW_ISO,
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
    });
    const markInboxReadCommitted = vi.fn().mockResolvedValue(committed);
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
      markInboxReadCommitted,
      applyDestinationProof: vi.fn(),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const deliverOpenCodeMemberMessage = vi.fn();
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);
    const logOpenCodePromptDeliveryEvent = vi.fn();

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        applyDestinationProof: vi.fn().mockResolvedValue({
          ledgerRecord: responded,
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

    // The answer already exists. Sending the prompt again would spend a runtime
    // turn to obtain what the lane has already produced.
    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [message()]);
    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'record-1',
      committedAt: NOW_ISO,
    });
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      committed,
      { recoveredResponded: true }
    );
    expect(result).toMatchObject({
      delivered: 1,
      relayed: 1,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
        ledgerStatus: 'responded',
        visibleReplyMessageId: 'reply-1',
      },
    });
  });

  it('falls through to normal delivery when the responded record has no recoverable proof', async () => {
    const responded = ledgerRecord();
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
      applyDestinationProof: vi.fn(),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const deliverOpenCodeMemberMessage = vi
      .fn()
      .mockResolvedValue({ delivered: true, accepted: true, responsePending: false });

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        applyDestinationProof: vi.fn().mockResolvedValue({
          ledgerRecord: responded,
          visibleReply: null,
        }),
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(false),
        deliverOpenCodeMemberMessage,
      })
    );

    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, delivered: 1 });
  });

  it('never marks the row read while the delivery response is still pending', async () => {
    const responded = ledgerRecord();
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
      applyDestinationProof: vi.fn(),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const markInboxMessagesRead = vi.fn().mockResolvedValue(undefined);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        applyDestinationProof: vi.fn().mockResolvedValue({
          ledgerRecord: responded,
          visibleReply: null,
        }),
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(false),
        markInboxMessagesRead,
        deliverOpenCodeMemberMessage: vi.fn().mockResolvedValue({
          delivered: true,
          accepted: true,
          responsePending: true,
          reason: 'opencode_delivery_response_pending',
        }),
      })
    );

    expect(markInboxMessagesRead).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: 1,
      delivered: 0,
      lastDelivery: { responsePending: true },
    });
  });

  it('surfaces a responded-recovery commit failure without spending a delivery attempt', async () => {
    const responded = ledgerRecord();
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
      markInboxReadCommitted: vi.fn(),
      applyDestinationProof: vi.fn(),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const deliverOpenCodeMemberMessage = vi.fn();

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      { teamName: 'team', memberName: 'worker', relayKey: 'team/worker' },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message()]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        applyDestinationProof: vi.fn().mockResolvedValue({
          ledgerRecord: responded,
          visibleReply: {
            inboxName: 'user',
            message: message({ messageId: 'reply-1' }),
          },
        }),
        isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn().mockResolvedValue(true),
        markInboxMessagesRead: vi.fn().mockRejectedValue(new Error('EPERM')),
        deliverOpenCodeMemberMessage,
      })
    );

    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      failed: 1,
      lastDelivery: {
        delivered: false,
        reason: 'opencode_inbox_mark_read_failed_after_responded_recovery',
      },
    });
  });

  it('heals the missing ledger commit stamp when the targeted row is already read', async () => {
    const responded = ledgerRecord();
    const committed = ledgerRecord({ inboxReadCommittedAt: NOW_ISO });
    const markInboxReadCommitted = vi.fn().mockResolvedValue(committed);
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
      markInboxReadCommitted,
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const logOpenCodePromptDeliveryEvent = vi.fn();
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
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        logOpenCodePromptDeliveryEvent,
        deliverOpenCodeMemberMessage,
      })
    );

    expect(markInboxReadCommitted).toHaveBeenCalledTimes(1);
    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'record-1',
      committedAt: NOW_ISO,
    });
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      committed,
      { healedAlreadyReadInboxRow: true }
    );
    // Healing bookkeeping must never look like new work for the member.
    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delivered: 1,
      lastDelivery: {
        delivered: true,
        accepted: true,
        reason: 'opencode_inbox_read_already_committed',
      },
    });
  });

  it('writes nothing when a replayed read row is already committed in the ledger', async () => {
    // Startup inbox backfill replays every scoped row through the relay
    // (issue #534). A row that is read, with a record that already carries the
    // stamp, is finished work: it must produce no ledger write and no delivery.
    const markInboxReadCommitted = vi.fn();
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(ledgerRecord({ inboxReadCommittedAt: NOW_ISO })),
      markInboxReadCommitted,
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const deliverOpenCodeMemberMessage = vi.fn();
    const markInboxMessagesRead = vi.fn();

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      {
        teamName: 'team',
        memberName: 'worker',
        relayKey: 'team/worker',
        options: { onlyMessageId: 'message-1' },
      },
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([message({ read: true })]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        deliverOpenCodeMemberMessage,
        markInboxMessagesRead,
      })
    );

    expect(markInboxReadCommitted).not.toHaveBeenCalled();
    expect(markInboxMessagesRead).not.toHaveBeenCalled();
    expect(deliverOpenCodeMemberMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      lastDelivery: { reason: 'opencode_inbox_read_already_committed' },
    });
  });
});

describe('TeamProvisioningOpenCodeMemberInboxRelay missing inbox row terminalization', () => {
  const missingRowInput = {
    teamName: 'team',
    memberName: 'worker',
    relayKey: 'team/worker',
    options: { onlyMessageId: 'message-1' },
  };

  it('terminalizes a responded-without-commit record whose inbox row was deleted', async () => {
    const responded = ledgerRecord();
    const terminalized = ledgerRecord({
      status: 'failed_terminal',
      lastReason: 'opencode_inbox_message_missing',
      failedAt: NOW_ISO,
    });
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(responded),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const markOpenCodePromptLedgerFailedTerminal = vi.fn().mockResolvedValue(terminalized);

    const result = await relayOpenCodeMemberInboxMessagesWithPorts(
      missingRowInput,
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
        markOpenCodePromptLedgerFailedTerminal,
      })
    );

    expect(markOpenCodePromptLedgerFailedTerminal).toHaveBeenCalledTimes(1);
    expect(markOpenCodePromptLedgerFailedTerminal).toHaveBeenCalledWith({
      ledger,
      id: 'record-1',
      reason: 'opencode_inbox_message_missing',
      diagnostics: ['opencode_inbox_message_missing: message-1'],
      failedAt: NOW_ISO,
      eventContext: { inboxRowMissing: true },
    });
    expect(result).toMatchObject({
      failed: 1,
      lastDelivery: { delivered: false, reason: 'opencode_inbox_message_missing' },
    });
    // The stamp is what stops the re-arming: before it, this record still reads
    // as unfinished work to every pass that looks for some.
    expect(isOpenCodePromptDeliveryWatchdogRecordTerminal(responded)).toBe(false);
    expect(isOpenCodePromptDeliveryWatchdogRecordTerminal(terminalized)).toBe(true);
  });

  it('leaves absent and already-terminal ledger records alone on a missing row', async () => {
    const markOpenCodePromptLedgerFailedTerminal = vi.fn();
    const makePorts = (
      existing: OpenCodePromptDeliveryLedgerRecord | null
    ): RelayOpenCodeMemberInboxMessagesPorts =>
      createRelayPorts({
        readInboxMessages: vi.fn().mockResolvedValue([]),
        createOpenCodePromptDeliveryLedger: vi.fn(() => ({
          getByInboxMessage: vi.fn().mockResolvedValue(existing),
        })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
        markOpenCodePromptLedgerFailedTerminal,
      });

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(missingRowInput, makePorts(null))
    ).resolves.toMatchObject({
      lastDelivery: { reason: 'opencode_inbox_message_missing' },
    });
    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        missingRowInput,
        makePorts(ledgerRecord({ status: 'failed_terminal' }))
      )
    ).resolves.toMatchObject({
      lastDelivery: { reason: 'opencode_inbox_message_missing' },
    });

    expect(markOpenCodePromptLedgerFailedTerminal).not.toHaveBeenCalled();
  });

  it('never terminalizes a cancelled record, on either qualifying shape', async () => {
    // A stopped run's tombstone is settled for good and the ledger refuses
    // every write to it, so a terminal write from here would only pretend to
    // have changed something. Without the cancellation branch the first of
    // these two records is written exactly like a live one.
    const markOpenCodePromptLedgerFailedTerminal = vi.fn();
    for (const cancelled of [
      ledgerRecord({ cancelledAt: NOW_ISO }),
      ledgerRecord({ status: 'failed_terminal', lastReason: 'force_stop_requested: run-1' }),
    ]) {
      await expect(
        relayOpenCodeMemberInboxMessagesWithPorts(
          missingRowInput,
          createRelayPorts({
            readInboxMessages: vi.fn().mockResolvedValue([]),
            createOpenCodePromptDeliveryLedger: vi.fn(() => ({
              getByInboxMessage: vi.fn().mockResolvedValue(cancelled),
            })) as unknown as RelayOpenCodeMemberInboxMessagesPorts['createOpenCodePromptDeliveryLedger'],
            markOpenCodePromptLedgerFailedTerminal,
          })
        )
      ).resolves.toMatchObject({
        lastDelivery: { reason: 'opencode_inbox_message_missing' },
      });
    }

    expect(markOpenCodePromptLedgerFailedTerminal).not.toHaveBeenCalled();
  });

  it('does not treat a transiently unreadable inbox as a deleted row', async () => {
    const markOpenCodePromptLedgerFailedTerminal = vi.fn();

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        missingRowInput,
        createRelayPorts({
          readInboxMessages: vi.fn().mockRejectedValue(new Error('EBUSY: file locked')),
          markOpenCodePromptLedgerFailedTerminal,
        })
      )
    ).resolves.toMatchObject({
      lastDelivery: { delivered: false, reason: 'opencode_inbox_read_failed' },
    });

    expect(markOpenCodePromptLedgerFailedTerminal).not.toHaveBeenCalled();
  });

  it('does not terminalize from the in-flight path, which cannot prove deletion', async () => {
    // That path reads the inbox with a swallowed error, so an unreadable file
    // and a deleted row are indistinguishable there - and it says so with its
    // own reason.
    const markOpenCodePromptLedgerFailedTerminal = vi.fn();
    const inFlight = new Map<string, Promise<never>>();
    inFlight.set('team/worker', new Promise(() => {}));
    // The same record the definitive path does settle, so the only difference
    // between the two cases is which path saw the row go missing.
    const ledger = {
      getByInboxMessage: vi.fn().mockResolvedValue(ledgerRecord()),
    } as unknown as OpenCodePromptDeliveryLedgerStore;

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        missingRowInput,
        createRelayPorts({
          inFlight: inFlight as unknown as RelayOpenCodeMemberInboxMessagesPorts['inFlight'],
          readInboxMessages: vi.fn().mockResolvedValue([]),
          createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
          markOpenCodePromptLedgerFailedTerminal,
        })
      )
    ).resolves.toMatchObject({
      lastDelivery: { reason: 'opencode_inbox_message_missing_after_inflight_relay' },
    });

    expect(markOpenCodePromptLedgerFailedTerminal).not.toHaveBeenCalled();
  });

  it('still relays a live unread row without terminalizing its ledger record', async () => {
    const markOpenCodePromptLedgerFailedTerminal = vi.fn();
    const deliverOpenCodeMemberMessage = vi.fn().mockResolvedValue({
      delivered: true,
      responsePending: true,
      reason: 'opencode_delivery_response_pending',
    });

    await expect(
      relayOpenCodeMemberInboxMessagesWithPorts(
        missingRowInput,
        createRelayPorts({
          readInboxMessages: vi.fn().mockResolvedValue([message()]),
          deliverOpenCodeMemberMessage,
          markOpenCodePromptLedgerFailedTerminal,
        })
      )
    ).resolves.toMatchObject({
      attempted: 1,
      lastDelivery: { reason: 'opencode_delivery_response_pending' },
    });

    expect(deliverOpenCodeMemberMessage).toHaveBeenCalledTimes(1);
    expect(markOpenCodePromptLedgerFailedTerminal).not.toHaveBeenCalled();
  });
});
