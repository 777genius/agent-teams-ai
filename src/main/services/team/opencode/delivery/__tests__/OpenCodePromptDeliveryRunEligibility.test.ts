import { describe, expect, it } from 'vitest';

import { OpenCodePromptDeliveryLedgerStore } from '../OpenCodePromptDeliveryLedger';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';

function harness() {
  let records: OpenCodePromptDeliveryLedgerRecord[] = [];
  const store = {
    async updateLocked(
      update: (rows: OpenCodePromptDeliveryLedgerRecord[]) => OpenCodePromptDeliveryLedgerRecord[]
    ) {
      records = update(records);
    },
    async read() {
      return { ok: true, data: records };
    },
  };
  const ledger = new OpenCodePromptDeliveryLedgerStore(
    store as unknown as ConstructorParameters<typeof OpenCodePromptDeliveryLedgerStore>[0]
  );
  return {
    ledger,
    replace: (rows: OpenCodePromptDeliveryLedgerRecord[]) => {
      records = rows;
    },
  };
}

const input = {
  teamName: 'sandbox',
  memberName: 'lead',
  laneId: 'primary',
  runId: 'old-run',
  inboxMessageId: 'old-message',
  inboxTimestamp: '2026-09-08T03:00:00Z',
  source: 'ui-send' as const,
  replyRecipient: 'user',
  actionMode: null,
  taskRefs: [],
  payloadHash: 'same',
  now: '2026-09-08T03:00:00Z',
};

describe('OpenCode persisted delivery ownership after relaunch', () => {
  it('excludes old accepted blockers and fences replay without replacing acceptance evidence', async () => {
    const { ledger, replace } = harness();
    const old = await ledger.ensurePending(input);
    replace([
      {
        ...old,
        status: 'accepted',
        acceptedAt: old.createdAt,
        attempts: 1,
        runtimeSessionId: 'old-session',
        runtimePromptMessageIds: ['accepted-prompt'],
      },
    ]);
    expect(await ledger.getActiveForMember({ ...input, runId: 'new-run' })).toBeNull();
    expect((await ledger.getActiveForMember(input))?.id).toBe(old.id);
    const blocked = await ledger.ensurePending({ ...input, runId: 'new-run' });
    expect(blocked).toMatchObject({
      status: 'failed_terminal',
      runId: 'old-run',
      attempts: 1,
      acceptedAt: old.createdAt,
      runtimeSessionId: 'old-session',
      runtimePromptMessageIds: ['accepted-prompt'],
      cancelledAt: input.now,
    });
    const fresh = await ledger.ensurePending({
      ...input,
      runId: 'new-run',
      inboxMessageId: 'fresh',
    });
    expect(fresh).toMatchObject({ status: 'pending', runId: 'new-run', attempts: 0 });
  });

  it('Stop cancels recoverable terminal rows and rejects late retry while preserving successor work', async () => {
    const { ledger, replace } = harness();
    const old = await ledger.ensurePending(input);
    const fresh = await ledger.ensurePending({
      ...input,
      runId: 'new-run',
      inboxMessageId: 'fresh',
      now: '2026-09-08T03:02:00Z',
    });
    replace([{ ...old, status: 'failed_terminal', acceptedAt: old.createdAt, attempts: 1 }, fresh]);
    expect(
      await ledger.cancelNonTerminalRecords({
        now: '2026-09-08T03:03:00Z',
        reason: 'stop',
        ownedRunIds: ['old-run'],
        createdAtOrBeforeMs: Date.parse('2026-09-08T03:01:00Z'),
        includeRecoverableTerminal: true,
      })
    ).toMatchObject({ cancelled: 1, keptForLaterRun: 1 });
    const late = await ledger.markNextAttemptScheduled({
      id: old.id,
      status: 'retry_scheduled',
      reason: 'late retry',
      scheduledAt: '2026-09-08T03:04:00Z',
      nextAttemptAt: '2026-09-08T03:04:00Z',
    });
    expect(late.status).toBe('failed_terminal');
    expect(late.cancelledAt).toBeTruthy();
    expect((await ledger.getByInboxMessage(fresh))?.status).toBe('pending');
  });
});
