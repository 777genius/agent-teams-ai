import { describe, expect, it, vi } from 'vitest';

import {
  isOpenCodePromptDeliveryWatchdogRecordTerminal,
  OpenCodePromptDeliveryFollowUpPolicy,
} from '../OpenCodePromptDeliveryFollowUpPolicy';
import { OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS } from '../OpenCodePromptDeliveryStalePendingPolicy';
import { OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS } from '../OpenCodePromptDeliveryWatchdog';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';

const NOW_MS = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The shape this commit exists for: a fresh team's first message, accepted by
 * the runtime (`runtimePromptMessageId` is latched), answered by the member,
 * but the answer's destination proof never materialized before the attempt
 * budget ran out.
 */
function proofPendingRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'ledger-1',
    teamName: 'team',
    memberName: 'worker',
    laneId: 'lane-worker',
    inboxMessageId: 'message-1',
    status: 'responded',
    responseState: 'responded_visible_message',
    attempts: 3,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    runtimePromptMessageId: 'runtime-prompt-1',
    lastAttemptAt: iso(NOW_MS - 60_000),
    createdAt: iso(NOW_MS - 120_000),
    nextAttemptAt: null,
    inboxReadCommittedAt: null,
    diagnostics: [],
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

interface ProofPendingHarness {
  policy: OpenCodePromptDeliveryFollowUpPolicy;
  ledger: OpenCodePromptDeliveryLedgerStore;
  markNextAttemptDeferred: ReturnType<typeof vi.fn>;
  markNextAttemptScheduled: ReturnType<typeof vi.fn>;
  markFailedTerminal: ReturnType<typeof vi.fn>;
  scheduleWatchdog: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
}

function createPolicy(): ProofPendingHarness {
  const markNextAttemptDeferred = vi.fn(
    async (input: { id: string; nextAttemptAt: string; deferredAt: string }) =>
      proofPendingRecord({ nextAttemptAt: input.nextAttemptAt, updatedAt: input.deferredAt })
  );
  const markNextAttemptScheduled = vi.fn(
    async (input: { id: string; status: 'accepted' | 'retry_scheduled'; nextAttemptAt: string }) =>
      proofPendingRecord({ status: input.status, nextAttemptAt: input.nextAttemptAt })
  );
  const markFailedTerminal = vi.fn(async () => proofPendingRecord({ status: 'failed_terminal' }));
  const scheduleWatchdog = vi.fn();
  const logEvent = vi.fn();
  const policy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal,
    logEvent,
    scheduleWatchdog,
    nowIso: () => iso(NOW_MS),
    nowMs: () => NOW_MS,
  });
  const ledger = {
    markNextAttemptDeferred,
    markNextAttemptScheduled,
  } as unknown as OpenCodePromptDeliveryLedgerStore;
  return {
    policy,
    ledger,
    markNextAttemptDeferred,
    markNextAttemptScheduled,
    markFailedTerminal,
    scheduleWatchdog,
    logEvent,
  };
}

describe('OpenCodePromptDeliveryFollowUpPolicy proof-pending observe re-arm', () => {
  it('re-arms instead of terminalling when only the destination proof is missing', async () => {
    const {
      policy,
      ledger,
      markNextAttemptDeferred,
      markNextAttemptScheduled,
      markFailedTerminal,
      scheduleWatchdog,
      logEvent,
    } = createPolicy();

    const rearmed = await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord(),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_destination_not_found_yet',
    });

    expect(markFailedTerminal).not.toHaveBeenCalled();
    // A responded record keeps its status: only the durable deadline moves.
    expect(markNextAttemptDeferred).toHaveBeenCalledWith({
      id: 'ledger-1',
      nextAttemptAt: iso(NOW_MS + OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS),
      deferredAt: iso(NOW_MS),
    });
    // The re-arm is observe-only: it spends no attempt and never schedules a
    // send, which is the whole reason it is allowed past the attempt cap.
    expect(markNextAttemptScheduled).not.toHaveBeenCalled();
    expect(rearmed).toMatchObject({ status: 'responded', attempts: 3 });
    expect(logEvent).toHaveBeenCalledWith(
      'opencode_prompt_delivery_proof_pending_observe_rearmed',
      expect.objectContaining({ id: 'ledger-1' }),
      expect.objectContaining({
        reason: 'visible_reply_destination_not_found_yet',
        attempts: 3,
        maxAttempts: 3,
      })
    );
    expect(scheduleWatchdog).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      messageId: 'message-1',
      delayMs: OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS,
    });
  });

  it('never re-arms or logs a cancelled record, whatever it still owes', async () => {
    // Every ledger write refuses a cancelled record, so the write returns it
    // unchanged; without the guard the policy would still log the re-arm and
    // schedule a wake for a run that no longer exists.
    const { policy, ledger, markNextAttemptDeferred, scheduleWatchdog, logEvent } = createPolicy();
    markNextAttemptDeferred.mockImplementation(async () =>
      proofPendingRecord({ cancelledAt: iso(NOW_MS) })
    );

    const result = await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord(),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_destination_not_found_yet',
    });

    expect(result).toMatchObject({ cancelledAt: iso(NOW_MS) });
    expect(logEvent).not.toHaveBeenCalled();
    expect(scheduleWatchdog).not.toHaveBeenCalled();
  });

  it('parks a non-responded status as accepted so the next wake observes instead of sending', async () => {
    const { policy, ledger, markNextAttemptScheduled, markFailedTerminal } = createPolicy();

    const rearmed = await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord({ status: 'retry_scheduled' }),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'plain_text_visible_reply_not_materialized_yet',
    });

    expect(markFailedTerminal).not.toHaveBeenCalled();
    expect(markNextAttemptScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ledger-1', status: 'accepted' })
    );
    expect(rearmed.status).toBe('accepted');
    expect(rearmed.status).not.toBe('retry_scheduled');
    expect(rearmed.attempts).toBe(3);
  });

  it('still terminals once the proof has been missing past the stale-pending hard cap', async () => {
    const { policy, ledger, markFailedTerminal, markNextAttemptDeferred } = createPolicy();
    const staleMs = NOW_MS - OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS - 1_000;

    await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord({
        lastAttemptAt: iso(staleMs),
        createdAt: iso(staleMs),
      }),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_destination_not_found_yet',
    });

    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'visible_reply_destination_not_found_yet' })
    );
  });

  it('terminals when the runtime never provably accepted the prompt', async () => {
    const { policy, ledger, markFailedTerminal, markNextAttemptDeferred } = createPolicy();

    await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord({ runtimePromptMessageId: null }),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_destination_not_found_yet',
    });

    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).toHaveBeenCalledTimes(1);
  });

  it('leaves a behavioral pending reason terminalling at the attempt cap', async () => {
    const { policy, ledger, markFailedTerminal, markNextAttemptDeferred } = createPolicy();

    // The member answered, but the answer was an acknowledgement. That is
    // behavior, not a delivery race, so more observation cannot change it.
    await policy.schedule({
      ledger,
      ledgerRecord: proofPendingRecord(),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_ack_only_still_requires_answer',
    });

    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'visible_reply_ack_only_still_requires_answer' })
    );
  });
});

describe('isOpenCodePromptDeliveryWatchdogRecordTerminal', () => {
  it('keeps a responded record non-terminal until the inbox read is committed', () => {
    expect(
      isOpenCodePromptDeliveryWatchdogRecordTerminal(
        proofPendingRecord({ inboxReadCommittedAt: null })
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryWatchdogRecordTerminal(
        proofPendingRecord({ inboxReadCommittedAt: iso(NOW_MS) })
      )
    ).toBe(true);
  });

  it('keeps the plain-text-without-materialized-reply case non-terminal', () => {
    expect(
      isOpenCodePromptDeliveryWatchdogRecordTerminal(
        proofPendingRecord({
          responseState: 'responded_plain_text',
          visibleReplyMessageId: null,
          inboxReadCommittedAt: null,
        })
      )
    ).toBe(false);
  });

  it('treats failed_terminal records as terminal regardless of the commit stamp', () => {
    expect(
      isOpenCodePromptDeliveryWatchdogRecordTerminal(
        proofPendingRecord({ status: 'failed_terminal', inboxReadCommittedAt: null })
      )
    ).toBe(true);
  });

  it('treats a cancelled responded record as terminal even though it owes its commit', () => {
    // Widening the predicate must not reach a record whose run was cancelled:
    // re-arming its wake would ask a runtime that is gone. Without the
    // cancellation branch this record is re-armed exactly like a live one.
    expect(
      isOpenCodePromptDeliveryWatchdogRecordTerminal(
        proofPendingRecord({ inboxReadCommittedAt: null, cancelledAt: iso(NOW_MS) })
      )
    ).toBe(true);
  });
});
