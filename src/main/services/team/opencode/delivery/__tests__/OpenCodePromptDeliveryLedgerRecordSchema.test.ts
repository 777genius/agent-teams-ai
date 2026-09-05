import { describe, expect, it } from 'vitest';

import { validateOpenCodePromptDeliveryLedgerRecords } from '../OpenCodePromptDeliveryLedgerRecordSchema';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';
import type { InboxMessageKind } from '@shared/types/team';

const NOW_ISO = '2026-01-01T00:00:00.000Z';

function record(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team',
    memberName: 'worker',
    laneId: 'lane-worker',
    inboxMessageId: 'message-1',
    inboxTimestamp: NOW_ISO,
    source: 'watcher',
    replyRecipient: 'user',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'hash-1',
    status: 'accepted',
    responseState: 'pending',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    observedToolCallNames: [],
    visibleReplyCorrelation: null,
    diagnostics: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

/**
 * The ledger file outlives the process that wrote it, so a record read back is
 * untrusted input until these guards have looked at it.
 */
describe('validateOpenCodePromptDeliveryLedgerRecords', () => {
  it('accepts a minimal record and returns it unchanged', () => {
    const records = [record()];

    expect(validateOpenCodePromptDeliveryLedgerRecords(records)).toEqual(records);
  });

  it('rejects a file whose top level is not an array', () => {
    for (const value of [null, undefined, {}, 'records', 3]) {
      expect(() => validateOpenCodePromptDeliveryLedgerRecords(value)).toThrow(
        'OpenCode prompt delivery ledger must be an array'
      );
    }
  });

  it('names the index of the first record that is not one', () => {
    // Each of these is the shape a hand-edited or partially written file
    // produces: a wrong enum, a wrong scalar type, a missing required field.
    for (const invalid of [
      { ...record(), status: 'done' },
      { ...record(), responseState: 'answered' },
      { ...record(), source: 'cron' },
      { ...record(), attempts: -1 },
      { ...record(), acceptanceUnknown: 'no' },
      { ...record(), observedToolCallNames: [1] },
      { ...record(), taskRefs: [{ taskId: 'task-1' }] },
      { ...record(), visibleReplyCorrelation: 'guessed' },
      { ...record(), actionMode: 'supervise' },
      { ...record(), diagnostics: null },
      // A persisted token count that is not a number normalizes to "absent",
      // so the next sample becomes a baseline instead of progress and the
      // record ages toward the stale window while its turn is still spending.
      { ...record(), observedTurnUsedTokens: '96000' },
      { ...record(), observedTurnUsedTokens: -1 },
      { ...record(), observedTurnUsedTokens: 1.5 },
      // A non-string progress stamp reaches Date.parse, which reads a bare
      // number as a year and hands the pending clock an anchor in the future.
      { ...record(), lastTurnProgressAt: 12345 },
      (() => {
        const missingPayloadHash: Record<string, unknown> = { ...record() };
        delete missingPayloadHash.payloadHash;
        return missingPayloadHash;
      })(),
      null,
      'record',
    ]) {
      expect(() => validateOpenCodePromptDeliveryLedgerRecords([record(), invalid])).toThrow(
        'Invalid OpenCode prompt delivery ledger record at index 1'
      );
    }
  });

  it('rejects a duplicate id, because the store addresses records by it', () => {
    expect(() =>
      validateOpenCodePromptDeliveryLedgerRecords([
        record(),
        record({ inboxMessageId: 'message-2' }),
      ])
    ).toThrow('Duplicate OpenCode prompt delivery ledger id: record-1');
  });

  it('accepts the optional fields a long-lived record accumulates', () => {
    const enriched = record({
      runId: 'run-1',
      runtimePromptMessageIds: ['prompt-1', 'prompt-2'],
      messageKind: 'task_comment_notification',
      sessionRefreshAttempts: 2,
      cancelledAt: NOW_ISO,
      visibleReplyCorrelation: 'relayOfMessageId',
      actionMode: 'do',
      taskRefs: [{ taskId: 'task-1', displayId: '1', teamName: 'team' }],
      lastTurnProgressAt: NOW_ISO,
      observedTurnUsedTokens: 96_000,
    });

    expect(validateOpenCodePromptDeliveryLedgerRecords([enriched])).toEqual([enriched]);
  });

  // A kind the guard does not know rejects the record, and one rejected record
  // rejects the whole array - the store then quarantines a ledger that was
  // never corrupt. The guard's allowlist is typed `Record<InboxMessageKind,
  // true>` so an added kind is a build error; this walks the union so a kind
  // dropped from the allowlist is a test failure too.
  it('accepts every inbox message kind the union declares', () => {
    const kinds: readonly InboxMessageKind[] = [
      'default',
      'slash_command',
      'slash_command_result',
      'task_comment_notification',
      'task_stall_remediation',
      'member_work_sync_nudge',
      'runtime_recovery_nudge',
      'agent_error',
    ];

    for (const messageKind of kinds) {
      const withKind = record({ messageKind });
      expect(validateOpenCodePromptDeliveryLedgerRecords([withKind])).toEqual([withKind]);
    }
  });

  it('rejects an inbox message kind outside the union', () => {
    expect(() =>
      validateOpenCodePromptDeliveryLedgerRecords([{ ...record(), messageKind: 'not_a_kind' }])
    ).toThrow();
  });

  // NEGATIVE CONTROL: the turn-progress stamps arrived after the first records
  // were written, so a ledger from before them has neither field. Requiring
  // them would quarantine every ledger an upgrade inherits.
  it('accepts a record written before the turn-progress stamps existed', () => {
    const legacy = record({ lastTurnProgressAt: null, observedTurnUsedTokens: null });
    const withoutTheFields: Record<string, unknown> = { ...record() };
    delete withoutTheFields.lastTurnProgressAt;
    delete withoutTheFields.observedTurnUsedTokens;

    expect(validateOpenCodePromptDeliveryLedgerRecords([legacy])).toEqual([legacy]);
    expect(validateOpenCodePromptDeliveryLedgerRecords([withoutTheFields])).toEqual([
      withoutTheFields,
    ]);
  });
});
