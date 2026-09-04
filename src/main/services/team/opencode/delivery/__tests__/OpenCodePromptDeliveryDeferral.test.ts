import { describe, expect, it, vi } from 'vitest';

import { deferOpenCodePromptDeliveryAttempt } from '../OpenCodePromptDeliveryDeferral';
import { isOpenCodePromptDeliveryAttemptDue } from '../OpenCodePromptDeliveryLedger';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';

const NOW_MS = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function record(
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
    lastReason: 'visible_reply_destination_not_found_yet',
    nextAttemptAt: null,
    inboxReadCommittedAt: null,
    diagnostics: [],
    createdAt: iso(NOW_MS - 60_000),
    updatedAt: iso(NOW_MS - 60_000),
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

describe('deferOpenCodePromptDeliveryAttempt', () => {
  it('moves the deadline and nothing else', async () => {
    const markNextAttemptDeferred = vi.fn(
      async (input: { id: string; nextAttemptAt: string; deferredAt: string }) =>
        record({ nextAttemptAt: input.nextAttemptAt, updatedAt: input.deferredAt })
    );
    const ledger = { markNextAttemptDeferred } as unknown as OpenCodePromptDeliveryLedgerStore;

    const deferred = await deferOpenCodePromptDeliveryAttempt({
      ledger,
      ledgerRecord: record(),
      delayMs: 90_000,
      nowMs: NOW_MS,
    });

    expect(markNextAttemptDeferred).toHaveBeenCalledWith({
      id: 'ledger-1',
      nextAttemptAt: iso(NOW_MS + 90_000),
      deferredAt: iso(NOW_MS),
    });
    // A postponement is not an attempt: the send never happened, so the budget,
    // the status and the last reason all have to survive it.
    expect(deferred).toMatchObject({
      status: 'responded',
      attempts: 3,
      lastReason: 'visible_reply_destination_not_found_yet',
    });
    expect(isOpenCodePromptDeliveryAttemptDue(deferred, NOW_MS + 89_999)).toBe(false);
    expect(isOpenCodePromptDeliveryAttemptDue(deferred, NOW_MS + 90_000)).toBe(true);
  });

  it('clamps a negative delay to now instead of writing a deadline in the past', async () => {
    const markNextAttemptDeferred = vi.fn(async () => record());
    const ledger = { markNextAttemptDeferred } as unknown as OpenCodePromptDeliveryLedgerStore;

    await deferOpenCodePromptDeliveryAttempt({
      ledger,
      ledgerRecord: record(),
      delayMs: -5_000,
      nowMs: NOW_MS,
    });

    expect(markNextAttemptDeferred).toHaveBeenCalledWith({
      id: 'ledger-1',
      nextAttemptAt: iso(NOW_MS),
      deferredAt: iso(NOW_MS),
    });
  });

  it('returns the record unchanged when the ledger write fails, and reports the failure', async () => {
    const original = record();
    const ledger = {
      markNextAttemptDeferred: vi.fn().mockRejectedValue(new Error('EPERM')),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // The caller decided to keep this record alive. Losing the deadline write
      // costs one extra observe pass; turning it into an error would cost the
      // record.
      await expect(
        deferOpenCodePromptDeliveryAttempt({
          ledger,
          ledgerRecord: original,
          delayMs: 90_000,
          nowMs: NOW_MS,
        })
      ).resolves.toBe(original);

      // The returned record is indistinguishable from a successful
      // postponement, so the only trace of the lost deadline is this line.
      expect(reported).toHaveBeenCalledTimes(1);
      const reportedArgs = reported.mock.calls[0] as unknown[];
      expect(String(reportedArgs[1])).toContain('opencode_prompt_delivery_defer_failed');
      expect(String(reportedArgs[1])).toContain('message-1');
      expect(reportedArgs[2]).toBeInstanceOf(Error);
    } finally {
      reported.mockRestore();
    }
  });

  // NEGATIVE CONTROL: a postponement that was written is not a failure. Logging
  // the success path too would put a line in the durable sink on every observe
  // cycle of every deferred record, which is what the level split exists to
  // avoid.
  it('reports nothing when the deadline is written', async () => {
    const ledger = {
      markNextAttemptDeferred: vi.fn(async () => record()),
    } as unknown as OpenCodePromptDeliveryLedgerStore;
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await deferOpenCodePromptDeliveryAttempt({
        ledger,
        ledgerRecord: record(),
        delayMs: 90_000,
        nowMs: NOW_MS,
      });

      expect(reported).not.toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });
});
