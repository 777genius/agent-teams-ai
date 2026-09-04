import { isOpenCodePromptDeliveryWatchdogRecordTerminal } from '../opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import { isOpenCodePromptDeliveryCancelled } from '../opencode/delivery/OpenCodePromptDeliveryLedger';

import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from '../opencode/delivery/OpenCodePromptDeliveryWatchdog';
import type { RelayInboxMessage } from './TeamProvisioningInboxRelayPolicy';
import type { AgentActionMode, TaskRef } from '@shared/types';

/**
 * Whether an unread inbox row's ledger record still owes the read-commit and
 * can potentially be settled WITHOUT another delivery attempt.
 *
 * Two shapes qualify:
 * - `failed_terminal`: the retry budget is gone, but the member may have
 *   replied anyway (the destination proof landed after the budget ran out).
 * - `responded` without `inboxReadCommittedAt`: the response was observed and
 *   the record settled, but the relay pass that owed the commit never came
 *   back - its commit failed, or the proof arrived through another channel
 *   after the pass ended. The reply exists; only the read flag is missing.
 *
 * In both cases the ONLY safe recovery is proof-first: re-run the destination
 * proof and the read-commit policy, and mark the row read only when they pass.
 * The read flag is the double-delivery guard, so it must never be set from the
 * record's status alone.
 */
export function isOpenCodeInboxReadCommitOwed(
  record: Pick<OpenCodePromptDeliveryLedgerRecord, 'status' | 'inboxReadCommittedAt'>
): boolean {
  return (
    record.status === 'failed_terminal' ||
    (record.status === 'responded' && !record.inboxReadCommittedAt)
  );
}

export interface OpenCodeInboxReadCommitRecoveryPorts {
  applyDestinationProof(input: {
    checkpoint?: () => void | Promise<void>;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    replyRecipient: string;
    memberName: string;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }>;
  isOpenCodeDeliveryResponseReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    responseState?: OpenCodePromptDeliveryLedgerRecord['responseState'];
    actionMode?: AgentActionMode;
    taskRefs: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<boolean>;
  markInboxMessagesRead(
    teamName: string,
    memberName: string,
    messages: RelayInboxMessage[]
  ): Promise<void>;
  logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  nowIso(): string;
  getErrorMessage(error: unknown): string;
}

export type OpenCodeInboxReadCommitRecoveryOutcome =
  | { outcome: 'aborted' }
  | { outcome: 'committed'; delivery: OpenCodeMemberInboxDelivery }
  | { outcome: 'commit_failed'; delivery: OpenCodeMemberInboxDelivery; diagnostic: string }
  | { outcome: 'not_recovered' };

/**
 * Try to settle an owed read-commit from existing proof, spending no delivery
 * attempt: re-run the destination proof, gate on the read-commit policy, then
 * mark the inbox row read and stamp the ledger commit.
 */
export async function recoverOpenCodeOwedInboxReadCommit(input: {
  teamName: string;
  memberName: string;
  canonicalMemberName: string;
  laneId: string;
  message: RelayInboxMessage;
  ledger: OpenCodePromptDeliveryLedgerStore;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  shouldAbort?: () => boolean;
  /** The caller's cancellation checkpoint, threaded into the proof service. */
  checkpoint?: () => void | Promise<void>;
  ports: OpenCodeInboxReadCommitRecoveryPorts;
}): Promise<OpenCodeInboxReadCommitRecoveryOutcome> {
  // A cancelled record is a tombstone: its run was stopped, so there is no
  // answer of its own to recover. Marking the row read from here would consume
  // a message the stop never delivered, and the ledger write would be refused
  // anyway - the two halves of the commit would disagree.
  if (isOpenCodePromptDeliveryCancelled(input.ledgerRecord)) {
    return { outcome: 'not_recovered' };
  }
  const wasTerminal = input.ledgerRecord.status === 'failed_terminal';
  let recoveredRecord: OpenCodePromptDeliveryLedgerRecord | null = null;
  let recoveredVisibleReply: OpenCodeVisibleReplyProof | null = null;
  if (typeof input.ledger.applyDestinationProof === 'function') {
    try {
      const proof = await input.ports.applyDestinationProof({
        checkpoint: input.checkpoint,
        ledger: input.ledger,
        ledgerRecord: input.ledgerRecord,
        teamName: input.teamName,
        replyRecipient: input.ledgerRecord.replyRecipient,
        memberName: input.canonicalMemberName,
      });
      recoveredRecord = proof.ledgerRecord;
      recoveredVisibleReply = proof.visibleReply;
    } catch {
      recoveredRecord = null;
      recoveredVisibleReply = null;
    }
  }
  if (input.shouldAbort?.()) {
    return { outcome: 'aborted' };
  }
  const recoveredReadAllowed = recoveredRecord
    ? await input.ports.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: input.teamName,
        memberName: input.canonicalMemberName,
        responseState: recoveredRecord.responseState,
        actionMode: recoveredRecord.actionMode ?? undefined,
        taskRefs: recoveredRecord.taskRefs,
        visibleReply: recoveredVisibleReply,
        ledgerRecord: recoveredRecord,
      })
    : false;
  if (input.shouldAbort?.()) {
    return { outcome: 'aborted' };
  }
  if (!recoveredRecord || !recoveredReadAllowed) {
    return { outcome: 'not_recovered' };
  }
  const failureReason = wasTerminal
    ? 'opencode_inbox_mark_read_failed_after_terminal_recovery'
    : 'opencode_inbox_mark_read_failed_after_responded_recovery';
  try {
    await input.ports.markInboxMessagesRead(input.teamName, input.memberName, [input.message]);
    const committed = await input.ledger.markInboxReadCommitted({
      id: recoveredRecord.id,
      committedAt: input.ports.nowIso(),
    });
    input.ports.logOpenCodePromptDeliveryEvent(
      'opencode_prompt_delivery_inbox_committed_read',
      committed,
      wasTerminal ? { recoveredTerminal: true } : { recoveredResponded: true }
    );
    return {
      outcome: 'committed',
      delivery: {
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: committed.responseState,
        ledgerStatus: committed.status,
        ledgerRecordId: committed.id,
        laneId: input.laneId,
        visibleReplyMessageId: committed.visibleReplyMessageId ?? undefined,
        visibleReplyCorrelation: committed.visibleReplyCorrelation ?? undefined,
        diagnostics: committed.diagnostics,
      },
    };
  } catch (error) {
    const diagnostic = `${failureReason}: ${input.ports.getErrorMessage(error)}`;
    return {
      outcome: 'commit_failed',
      diagnostic,
      delivery: {
        delivered: false,
        reason: failureReason,
        diagnostics: [diagnostic],
      },
    };
  }
}

const OPENCODE_INBOX_MESSAGE_MISSING_TERMINAL_REASON = 'opencode_inbox_message_missing';

/**
 * The relay read the inbox successfully and the target row is not in it: the
 * row was DELETED, not momentarily unreadable - a failed inbox read surfaces as
 * `opencode_inbox_read_failed` before the missing check and never reaches this
 * path, and the in-flight fast path, which cannot tell the two apart, reports
 * its own reason instead.
 *
 * With the row gone there is nothing left to deliver and nothing to
 * read-commit, so a non-terminal record - typically 'responded' still owing
 * `inboxReadCommittedAt` - would be re-armed by every pass that looks for
 * unfinished work, for the life of the team, and each wake would find the same
 * nothing. Settle the record instead; the reason records why.
 *
 * Best-effort: a failed lookup or write leaves the record for the next wake.
 */
export async function terminalizeOpenCodeMissingInboxRowRecord(input: {
  teamName: string;
  canonicalMemberName: string;
  laneId: string;
  inboxMessageId: string;
  ledger: OpenCodePromptDeliveryLedgerStore;
  ports: {
    markOpenCodePromptLedgerFailedTerminal(input: {
      ledger: OpenCodePromptDeliveryLedgerStore;
      id: string;
      reason: string;
      diagnostics?: string[];
      failedAt: string;
      eventContext?: Record<string, unknown>;
    }): Promise<OpenCodePromptDeliveryLedgerRecord>;
    nowIso(): string;
  };
}): Promise<void> {
  const record = await input.ledger
    .getByInboxMessage({
      teamName: input.teamName,
      memberName: input.canonicalMemberName,
      laneId: input.laneId,
      inboxMessageId: input.inboxMessageId,
    })
    .catch(() => null);
  // A cancelled record is already settled for good: the ledger refuses every
  // write to it, so terminalizing here would only pretend to have changed it.
  if (
    !record ||
    isOpenCodePromptDeliveryCancelled(record) ||
    isOpenCodePromptDeliveryWatchdogRecordTerminal(record)
  ) {
    return;
  }
  try {
    await input.ports.markOpenCodePromptLedgerFailedTerminal({
      ledger: input.ledger,
      id: record.id,
      reason: OPENCODE_INBOX_MESSAGE_MISSING_TERMINAL_REASON,
      diagnostics: [`${OPENCODE_INBOX_MESSAGE_MISSING_TERMINAL_REASON}: ${input.inboxMessageId}`],
      failedAt: input.ports.nowIso(),
      eventContext: { inboxRowMissing: true },
    });
  } catch {
    // Left non-terminal: the next wake re-runs this settlement.
  }
}

/**
 * The inbox row is already read - the double-delivery guard is engaged - but
 * the ledger record never got its `inboxReadCommittedAt` stamp (the commit
 * crashed between the two writes, or another path marked the row). Stamp the
 * ledger to match, so nothing keeps re-arming a record whose work is done.
 * Best-effort: a failed heal returns the record unchanged.
 */
export async function commitOpenCodeAlreadyReadInboxRow(input: {
  ledger: OpenCodePromptDeliveryLedgerStore;
  record: OpenCodePromptDeliveryLedgerRecord;
  ports: Pick<OpenCodeInboxReadCommitRecoveryPorts, 'logOpenCodePromptDeliveryEvent' | 'nowIso'>;
}): Promise<OpenCodePromptDeliveryLedgerRecord> {
  if (input.record.inboxReadCommittedAt) {
    return input.record;
  }
  try {
    const committed = await input.ledger.markInboxReadCommitted({
      id: input.record.id,
      committedAt: input.ports.nowIso(),
    });
    input.ports.logOpenCodePromptDeliveryEvent(
      'opencode_prompt_delivery_inbox_committed_read',
      committed,
      { healedAlreadyReadInboxRow: true }
    );
    return committed;
  } catch {
    return input.record;
  }
}
