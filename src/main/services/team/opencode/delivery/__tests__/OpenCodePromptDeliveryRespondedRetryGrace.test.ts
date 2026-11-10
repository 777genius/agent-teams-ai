import { describe, expect, it, vi } from 'vitest';

import {
  getOpenCodeDeliveryNextDelayMs,
  OpenCodePromptDeliveryFollowUpPolicy,
} from '../OpenCodePromptDeliveryFollowUpPolicy';
import { isOpenCodePromptDeliveryAttemptDue } from '../OpenCodePromptDeliveryLedger';
import {
  OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS,
  OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS,
} from '../OpenCodePromptDeliveryWatchdog';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';

const NOW_MS = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A record the runtime answered, whose answer still lacks its reply proof. */
function respondedRecord(
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
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
    lastAttemptAt: iso(NOW_MS - 30_000),
    diagnostics: [],
    createdAt: iso(NOW_MS - 60_000),
    updatedAt: iso(NOW_MS - 30_000),
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

describe('OpenCode prompt delivery retry grace after a responded turn', () => {
  it('gives every responded state the grace instead of the default retry delay', () => {
    for (const responseState of [
      'responded_visible_message',
      'responded_plain_text',
      'responded_tool_call',
      'responded_non_visible_tool',
    ] as const) {
      expect(getOpenCodeDeliveryNextDelayMs({ responseState, retry: true })).toBe(
        OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS
      );
    }
  });

  it('leaves an unanswered retry on the default delay', () => {
    // The grace exists because a turn is running. A lane that produced nothing
    // has no turn to protect, and slowing its retry only slows the delivery.
    for (const responseState of [
      'empty_assistant_turn',
      'prompt_delivered_no_assistant_message',
      'not_observed',
      'reconcile_failed',
    ] as const) {
      expect(getOpenCodeDeliveryNextDelayMs({ responseState, retry: true })).toBe(
        OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS
      );
    }
  });

  it('keeps the observe delay for a tool_error retry that already sent the reply', () => {
    expect(
      getOpenCodeDeliveryNextDelayMs({
        responseState: 'tool_error',
        retry: true,
        ledgerRecord: respondedRecord({
          responseState: 'tool_error',
          observedToolCallNames: ['message_send'],
        }),
      })
    ).toBe(3_000);
  });

  it('does not re-attempt a responded delivery inside the grace, and does after it', async () => {
    const markNextAttemptScheduled = vi.fn(
      async (input: {
        id: string;
        status: 'accepted' | 'retry_scheduled';
        nextAttemptAt: string;
      }) => respondedRecord({ status: input.status, nextAttemptAt: input.nextAttemptAt })
    );
    const scheduleWatchdog = vi.fn();
    const policy = new OpenCodePromptDeliveryFollowUpPolicy({
      markFailedTerminal: vi.fn(async () => respondedRecord({ status: 'failed_terminal' })),
      logEvent: vi.fn(),
      scheduleWatchdog,
      nowIso: () => iso(NOW_MS),
      nowMs: () => NOW_MS,
    });
    const ledger = { markNextAttemptScheduled } as unknown as OpenCodePromptDeliveryLedgerStore;

    const scheduled = await policy.schedule({
      ledger,
      ledgerRecord: respondedRecord(),
      teamName: 'team',
      memberName: 'worker',
      retry: true,
      reason: 'visible_reply_destination_not_found_yet',
    });

    expect(markNextAttemptScheduled).toHaveBeenCalledWith({
      id: 'ledger-1',
      status: 'retry_scheduled',
      nextAttemptAt: iso(NOW_MS + OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS),
      reason: 'visible_reply_destination_not_found_yet',
      scheduledAt: iso(NOW_MS),
    });
    expect(scheduleWatchdog).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'worker',
      messageId: 'message-1',
      delayMs: OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS,
    });
    // The grace is only worth having if the wake it schedules is also the
    // earliest moment the record can be attempted again.
    expect(
      isOpenCodePromptDeliveryAttemptDue(
        scheduled,
        NOW_MS + OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS - 1
      )
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryAttemptDue(
        scheduled,
        NOW_MS + OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS
      )
    ).toBe(true);
    // The old delay is inside the grace: without it the same record was due
    // while the answering turn was still running.
    expect(
      isOpenCodePromptDeliveryAttemptDue(
        scheduled,
        NOW_MS + OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS
      )
    ).toBe(false);
  });
});
