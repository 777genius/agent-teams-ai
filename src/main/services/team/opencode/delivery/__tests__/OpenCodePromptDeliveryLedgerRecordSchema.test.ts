import { describe, expect, it } from 'vitest';

import { validateOpenCodePromptDeliveryLedgerRecords } from '../OpenCodePromptDeliveryLedgerRecordSchema';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';

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
    });

    expect(validateOpenCodePromptDeliveryLedgerRecords([enriched])).toEqual([enriched]);
  });
});
