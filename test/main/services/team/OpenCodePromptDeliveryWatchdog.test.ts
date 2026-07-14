import {
  buildOpenCodePromptDeliveryActiveBusyStatus,
  isOpenCodePromptDeliveryObserveLaterResponseState,
  isOpenCodePromptDeliveryRetryableResponseState,
  isOpenCodePromptDeliveryRetryAttemptDue,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('OpenCodePromptDeliveryWatchdogScheduler isolation', () => {
  function createScheduler(relay: (memberName: string, messageId: string) => Promise<void>) {
    return new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: () => true,
      recoverBeforeDelivery: vi.fn(async () => false),
      relay: ({ memberName, messageId }) => relay(memberName, messageId),
      getInboxMessages: vi.fn(async () => []),
      resolveIdentity: vi.fn(async () => null),
      isLaneActive: vi.fn(async () => false),
      isRecordNotFoundError: () => false,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      getErrorMessage: (error) => String(error),
    });
  }

  it('does not let a stuck Cursor member block a healthy teammate in the same team', async () => {
    vi.useFakeTimers();
    const aliceGate = createDeferred<void>();
    const relay = vi.fn(async (memberName: string) => {
      if (memberName === 'alice') {
        await aliceGate.promise;
      }
    });
    const scheduler = createScheduler(relay);

    scheduler.schedule({ teamName: 'team', memberName: 'alice', messageId: 'a-1', delayMs: 500 });
    scheduler.schedule({ teamName: 'team', memberName: 'bob', messageId: 'b-1', delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    expect(relay.mock.calls.map(([memberName]) => memberName)).toEqual(['alice', 'bob']);
    aliceGate.resolve();
    await aliceGate.promise;
    vi.useRealTimers();
  });

  it('keeps deliveries serialized within one member lane', async () => {
    vi.useFakeTimers();
    const firstGate = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const relay = vi.fn(async (_memberName: string, messageId: string) => {
      if (messageId === 'a-1') {
        await firstGate.promise;
      } else {
        secondStarted.resolve();
      }
    });
    const scheduler = createScheduler(relay);

    scheduler.schedule({ teamName: 'team', memberName: 'alice', messageId: 'a-1', delayMs: 500 });
    scheduler.schedule({ teamName: 'team', memberName: 'alice', messageId: 'a-2', delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(relay).toHaveBeenCalledTimes(1);

    firstGate.resolve();
    await secondStarted.promise;
    expect(relay).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
