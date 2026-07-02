import {
  buildOpenCodePromptDeliveryActiveBusyStatus,
  isOpenCodePromptDeliveryObserveLaterResponseState,
  isOpenCodePromptDeliveryRetryableResponseState,
  isOpenCodePromptDeliveryRetryAttemptDue,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

describe('OpenCodePromptDeliveryWatchdog retry policy', () => {
  it('treats stale OpenCode sessions as retryable after observation', () => {
    expect(isOpenCodePromptDeliveryObserveLaterResponseState('session_stale')).toBe(true);
    expect(isOpenCodePromptDeliveryRetryableResponseState('session_stale')).toBe(true);
  });

  it('does not retry prompt indexing states before OpenCode has had a chance to answer', () => {
    expect(isOpenCodePromptDeliveryObserveLaterResponseState('prompt_not_indexed')).toBe(true);
    expect(isOpenCodePromptDeliveryRetryableResponseState('prompt_not_indexed')).toBe(false);
  });

  it('lets due accepted stale-session records proceed to a fresh send attempt', () => {
    expect(
      isOpenCodePromptDeliveryRetryAttemptDue({
        attemptDue: true,
        ledgerRecord: {
          status: 'accepted',
          responseState: 'session_stale',
        },
      })
    ).toBe(true);
  });

  it('keeps non-due stale-session records in observation mode', () => {
    expect(
      isOpenCodePromptDeliveryRetryAttemptDue({
        attemptDue: false,
        ledgerRecord: {
          status: 'accepted',
          responseState: 'session_stale',
        },
      })
    ).toBe(false);
  });

  it('builds active busy status and schedules the next wake from the ledger record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    try {
      const wakeInputs: unknown[] = [];
      const activeRecord = {
        inboxMessageId: 'msg-1',
        nextAttemptAt: '2026-05-09T12:00:30.000Z',
        messageKind: 'member_work_sync_nudge',
      } as OpenCodePromptDeliveryLedgerRecord;

      const status = buildOpenCodePromptDeliveryActiveBusyStatus({
        teamName: 'team',
        memberName: 'dev',
        retryAfterIso: '2026-05-09T12:01:00.000Z',
        activeRecord,
        scheduleWake: (input) => wakeInputs.push(input),
      });

      expect(status).toMatchObject({
        busy: true,
        reason: 'opencode_prompt_delivery_active:member_work_sync_nudge',
        retryAfterIso: '2026-05-09T12:00:30.000Z',
        activeMessageId: 'msg-1',
        activeMessageKind: 'member_work_sync_nudge',
      });
      expect(wakeInputs).toHaveLength(1);
      expect(wakeInputs[0]).toMatchObject({
        teamName: 'team',
        memberName: 'dev',
        messageId: 'msg-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back when an active ledger retry timestamp is stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    try {
      const wakeInputs: { delayMs?: number }[] = [];
      const activeRecord = {
        inboxMessageId: 'msg-1',
        nextAttemptAt: '2026-05-09T11:59:30.000Z',
        messageKind: 'member_work_sync_nudge',
      } as OpenCodePromptDeliveryLedgerRecord;

      const status = buildOpenCodePromptDeliveryActiveBusyStatus({
        teamName: 'team',
        memberName: 'dev',
        retryAfterIso: '2026-05-09T12:01:00.000Z',
        activeRecord,
        scheduleWake: (input) => wakeInputs.push(input),
      });

      expect(status.retryAfterIso).toBe('2026-05-09T12:01:00.000Z');
      expect(wakeInputs).toEqual([expect.objectContaining({ delayMs: 500 })]);
    } finally {
      vi.useRealTimers();
    }
  });
});
