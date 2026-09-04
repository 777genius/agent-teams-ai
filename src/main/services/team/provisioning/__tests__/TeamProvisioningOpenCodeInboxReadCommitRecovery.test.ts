import { describe, expect, it, vi } from 'vitest';

import {
  commitOpenCodeAlreadyReadInboxRow,
  isOpenCodeInboxReadCommitOwed,
  type OpenCodeInboxReadCommitRecoveryPorts,
  recoverOpenCodeOwedInboxReadCommit,
} from '../TeamProvisioningOpenCodeInboxReadCommitRecovery';

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
    inboxMessageId: 'message-1',
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    taskRefs: [],
    status: 'responded',
    responseState: 'responded_visible_message',
    attempts: 3,
    maxAttempts: 3,
    inboxReadCommittedAt: null,
    diagnostics: [],
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

/**
 * The ports plus a handle on each mock. Behaviour is chosen by option, not by
 * substituting a whole port, so a returned handle is always the function the
 * subject actually called - and an assertion reads the handle rather than the
 * port, which would be an unbound method reference.
 */
function createPorts(
  options: {
    readCommitAllowed?: boolean;
    readCommitPolicyError?: Error;
    markInboxMessagesReadError?: Error;
  } = {}
): {
  ports: OpenCodeInboxReadCommitRecoveryPorts;
  applyDestinationProof: ReturnType<typeof vi.fn>;
  markInboxMessagesRead: ReturnType<typeof vi.fn>;
  logOpenCodePromptDeliveryEvent: ReturnType<typeof vi.fn>;
} {
  const applyDestinationProof = vi.fn().mockResolvedValue({
    ledgerRecord: ledgerRecord(),
    visibleReply: { inboxName: 'user', message: message({ messageId: 'reply-1' }) },
  });
  const markInboxMessagesRead = options.markInboxMessagesReadError
    ? vi.fn().mockRejectedValue(options.markInboxMessagesReadError)
    : vi.fn().mockResolvedValue(undefined);
  const logOpenCodePromptDeliveryEvent = vi.fn();
  return {
    ports: {
      applyDestinationProof,
      isOpenCodeDeliveryResponseReadCommitAllowed: options.readCommitPolicyError
        ? vi.fn().mockRejectedValue(options.readCommitPolicyError)
        : vi.fn().mockResolvedValue(options.readCommitAllowed ?? true),
      markInboxMessagesRead,
      logOpenCodePromptDeliveryEvent,
      nowIso: () => NOW_ISO,
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    },
    applyDestinationProof,
    markInboxMessagesRead,
    logOpenCodePromptDeliveryEvent,
  };
}

function createLedger(
  options: { withoutDestinationProof?: boolean; markInboxReadCommittedError?: Error } = {}
): { ledger: OpenCodePromptDeliveryLedgerStore; markInboxReadCommitted: ReturnType<typeof vi.fn> } {
  const markInboxReadCommitted = options.markInboxReadCommittedError
    ? vi.fn().mockRejectedValue(options.markInboxReadCommittedError)
    : vi.fn().mockResolvedValue(ledgerRecord({ inboxReadCommittedAt: NOW_ISO }));
  return {
    ledger: {
      applyDestinationProof: options.withoutDestinationProof ? undefined : vi.fn(),
      markInboxReadCommitted,
    } as unknown as OpenCodePromptDeliveryLedgerStore,
    markInboxReadCommitted,
  };
}

describe('isOpenCodeInboxReadCommitOwed', () => {
  it('owes the commit for failed_terminal and responded-without-commit records only', () => {
    expect(isOpenCodeInboxReadCommitOwed(ledgerRecord({ status: 'failed_terminal' }))).toBe(true);
    expect(isOpenCodeInboxReadCommitOwed(ledgerRecord())).toBe(true);
    // A responded record whose read is already committed is finished work: it
    // must not be picked up again by a later relay pass.
    expect(isOpenCodeInboxReadCommitOwed(ledgerRecord({ inboxReadCommittedAt: NOW_ISO }))).toBe(
      false
    );
    expect(isOpenCodeInboxReadCommitOwed(ledgerRecord({ status: 'accepted' }))).toBe(false);
    expect(isOpenCodeInboxReadCommitOwed(ledgerRecord({ status: 'retry_scheduled' }))).toBe(false);
  });
});

describe('recoverOpenCodeOwedInboxReadCommit', () => {
  it('commits the read from recovered proof without a delivery attempt', async () => {
    const { ports, markInboxMessagesRead, logOpenCodePromptDeliveryEvent } = createPorts();
    const { ledger, markInboxReadCommitted } = createLedger();

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger,
      ledgerRecord: ledgerRecord(),
      ports,
    });

    expect(markInboxMessagesRead).toHaveBeenCalledWith('team', 'worker', [message()]);
    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'record-1',
      committedAt: NOW_ISO,
    });
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      expect.objectContaining({ inboxReadCommittedAt: NOW_ISO }),
      { recoveredResponded: true }
    );
    expect(outcome).toMatchObject({
      outcome: 'committed',
      delivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
        ledgerRecordId: 'record-1',
        laneId: 'lane-worker',
      },
    });
  });

  it('never recovers a cancelled tombstone, on either qualifying shape', async () => {
    // A stopped run's record stays in the ledger as a tombstone. Its inbox row
    // is not this record's to consume: the ledger write would be refused, so
    // the row would be marked read against a record that never committed it.
    for (const cancelled of [
      ledgerRecord({ cancelledAt: NOW_ISO }),
      ledgerRecord({
        status: 'failed_terminal',
        lastReason: 'force_stop_requested: run-1',
      }),
    ]) {
      const { ports, applyDestinationProof, markInboxMessagesRead } = createPorts();
      const { ledger, markInboxReadCommitted } = createLedger();

      const outcome = await recoverOpenCodeOwedInboxReadCommit({
        teamName: 'team',
        memberName: 'worker',
        canonicalMemberName: 'worker',
        laneId: 'lane-worker',
        message: message(),
        ledger,
        ledgerRecord: cancelled,
        ports,
      });

      expect(outcome).toEqual({ outcome: 'not_recovered' });
      expect(applyDestinationProof).not.toHaveBeenCalled();
      expect(markInboxMessagesRead).not.toHaveBeenCalled();
      expect(markInboxReadCommitted).not.toHaveBeenCalled();
    }
  });

  it('keeps the terminal-recovery marker for a record whose budget ran out', async () => {
    const { ports, logOpenCodePromptDeliveryEvent } = createPorts();

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger: createLedger().ledger,
      ledgerRecord: ledgerRecord({ status: 'failed_terminal' }),
      ports,
    });

    expect(outcome.outcome).toBe('committed');
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      expect.anything(),
      { recoveredTerminal: true }
    );
  });

  it('never marks the row read before the read-commit policy passes', async () => {
    // The read flag is the double-delivery guard. Recovery may only ever be
    // proof-first: the record's status alone proves nothing about the answer.
    const { ports, markInboxMessagesRead } = createPorts({ readCommitAllowed: false });
    const { ledger, markInboxReadCommitted } = createLedger();

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger,
      ledgerRecord: ledgerRecord(),
      ports,
    });

    expect(outcome).toEqual({ outcome: 'not_recovered' });
    expect(markInboxMessagesRead).not.toHaveBeenCalled();
    expect(markInboxReadCommitted).not.toHaveBeenCalled();
  });

  it('reports not_recovered when the read-commit policy itself fails', async () => {
    // The caller awaits this recovery with no catch of its own, so a rejection
    // here would end the relay pass before the ordinary delivery path that
    // handles a message this recovery declined.
    const { ports, markInboxMessagesRead, logOpenCodePromptDeliveryEvent } = createPorts({
      readCommitPolicyError: new Error('work sync store unavailable'),
    });
    const { ledger, markInboxReadCommitted } = createLedger();

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger,
      ledgerRecord: ledgerRecord(),
      ports,
    });

    expect(outcome).toEqual({ outcome: 'not_recovered' });
    expect(markInboxMessagesRead).not.toHaveBeenCalled();
    expect(markInboxReadCommitted).not.toHaveBeenCalled();
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_read_commit_recovery_policy_failed',
      expect.objectContaining({ id: 'record-1' }),
      { error: 'work sync store unavailable' }
    );
  });

  it('reports not_recovered when the ledger cannot re-run the destination proof', async () => {
    const { ports, applyDestinationProof } = createPorts();
    const { ledger } = createLedger({ withoutDestinationProof: true });

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger,
      ledgerRecord: ledgerRecord(),
      ports,
    });

    expect(outcome).toEqual({ outcome: 'not_recovered' });
    expect(applyDestinationProof).not.toHaveBeenCalled();
  });

  it('aborts without committing when the relay generation moved on', async () => {
    const { ports, markInboxMessagesRead } = createPorts();

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger: createLedger().ledger,
      ledgerRecord: ledgerRecord(),
      shouldAbort: () => true,
      ports,
    });

    expect(outcome).toEqual({ outcome: 'aborted' });
    expect(markInboxMessagesRead).not.toHaveBeenCalled();
  });

  it('surfaces a responded-recovery commit failure with its own reason', async () => {
    const { ports } = createPorts({ markInboxMessagesReadError: new Error('EPERM') });

    const outcome = await recoverOpenCodeOwedInboxReadCommit({
      teamName: 'team',
      memberName: 'worker',
      canonicalMemberName: 'worker',
      laneId: 'lane-worker',
      message: message(),
      ledger: createLedger().ledger,
      ledgerRecord: ledgerRecord(),
      ports,
    });

    expect(outcome).toMatchObject({
      outcome: 'commit_failed',
      diagnostic: 'opencode_inbox_mark_read_failed_after_responded_recovery: EPERM',
      delivery: {
        delivered: false,
        reason: 'opencode_inbox_mark_read_failed_after_responded_recovery',
      },
    });
  });
});

describe('commitOpenCodeAlreadyReadInboxRow', () => {
  it('stamps the ledger commit for an already-read row', async () => {
    const { ledger, markInboxReadCommitted } = createLedger();
    const logOpenCodePromptDeliveryEvent = vi.fn();

    const committed = await commitOpenCodeAlreadyReadInboxRow({
      ledger,
      record: ledgerRecord(),
      ports: { logOpenCodePromptDeliveryEvent, nowIso: () => NOW_ISO },
    });

    expect(markInboxReadCommitted).toHaveBeenCalledWith({
      id: 'record-1',
      committedAt: NOW_ISO,
    });
    expect(committed.inboxReadCommittedAt).toBe(NOW_ISO);
    expect(logOpenCodePromptDeliveryEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_inbox_committed_read',
      expect.anything(),
      { healedAlreadyReadInboxRow: true }
    );
  });

  it('leaves an already-committed record untouched', async () => {
    // Every pass over a read row reaches this heal. Without the early return it
    // would rewrite the same stamp on every pass, for the life of the team.
    const { ledger, markInboxReadCommitted } = createLedger();
    const record = ledgerRecord({ inboxReadCommittedAt: NOW_ISO });
    const logOpenCodePromptDeliveryEvent = vi.fn();

    await expect(
      commitOpenCodeAlreadyReadInboxRow({
        ledger,
        record,
        ports: { logOpenCodePromptDeliveryEvent, nowIso: () => NOW_ISO },
      })
    ).resolves.toBe(record);
    expect(markInboxReadCommitted).not.toHaveBeenCalled();
    expect(logOpenCodePromptDeliveryEvent).not.toHaveBeenCalled();
  });

  it('returns the record unchanged when the heal write fails', async () => {
    const { ledger } = createLedger({ markInboxReadCommittedError: new Error('locked') });
    const record = ledgerRecord();

    await expect(
      commitOpenCodeAlreadyReadInboxRow({
        ledger,
        record,
        ports: { logOpenCodePromptDeliveryEvent: vi.fn(), nowIso: () => NOW_ISO },
      })
    ).resolves.toBe(record);
  });
});
