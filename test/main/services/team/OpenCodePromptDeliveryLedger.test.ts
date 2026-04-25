import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOpenCodePromptDeliveryLedgerStore,
  hashOpenCodePromptDeliveryPayload,
  isOpenCodePromptDeliveryAttemptDue,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

describe('OpenCodePromptDeliveryLedger', () => {
  let tempDir = '';
  const corruptionCases: Array<[string, (record: Record<string, unknown>) => void]> = [
    [
      'unknown delivery status',
      (record) => {
        record.status = 'quietly_broken';
      },
    ],
    [
      'unknown response state',
      (record) => {
        record.responseState = 'assistant_maybe_replied';
      },
    ],
    [
      'invalid task reference shape',
      (record) => {
        record.taskRefs = [{ taskId: 'task-1', displayId: '#1' }];
      },
    ],
    [
      'invalid diagnostic array',
      (record) => {
        record.diagnostics = ['ok', 42];
      },
    ],
    [
      'invalid visible reply correlation',
      (record) => {
        record.visibleReplyCorrelation = 'guessed_from_text';
      },
    ],
  ];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-prompt-ledger-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  function createStore() {
    return createOpenCodePromptDeliveryLedgerStore({
      filePath: path.join(tempDir, 'opencode-prompt-delivery-ledger.json'),
      clock: () => new Date('2026-04-25T10:00:00.000Z'),
    });
  }

  function ledgerPath() {
    return path.join(tempDir, 'opencode-prompt-delivery-ledger.json');
  }

  async function writeCorruptedLedgerRecord(
    mutate: (record: Record<string, unknown>) => void
  ): Promise<ReturnType<typeof createStore>> {
    const store = createStore();
    await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-corrupt',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash: 'sha256:corrupt',
      now: '2026-04-25T10:00:00.000Z',
    });

    const envelope = JSON.parse(await fs.readFile(ledgerPath(), 'utf8')) as {
      data: Record<string, unknown>[];
    };
    mutate(envelope.data[0]);
    await fs.writeFile(ledgerPath(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return store;
  }

  it('is idempotent for the same inbox message and payload hash', async () => {
    const store = createStore();
    const payloadHash = hashOpenCodePromptDeliveryPayload({
      text: 'Please answer',
      replyRecipient: 'user',
      actionMode: 'ask',
      source: 'watcher',
    });

    const first = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash,
      now: '2026-04-25T10:00:00.000Z',
    });
    const second = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash,
      now: '2026-04-25T10:00:30.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(0);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it.each(corruptionCases)('rejects corrupted persisted records with %s', async (_name, mutate) => {
    const store = await writeCorruptedLedgerRecord(mutate);

    await expect(store.list()).rejects.toMatchObject({
      reason: 'invalid_data',
    });
    await expect(fs.readdir(tempDir)).resolves.toContain(
      'opencode-prompt-delivery-ledger.json'
    );
    expect((await fs.readdir(tempDir)).some((name) => name.includes('.invalid_data.'))).toBe(true);
  });

  it('marks same logical delivery with a different payload hash terminal', async () => {
    const store = createStore();
    const original = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:first',
      now: '2026-04-25T10:00:00.000Z',
    });

    const mismatch = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:second',
      now: '2026-04-25T10:00:30.000Z',
    });

    expect(mismatch.id).toBe(original.id);
    expect(mismatch.status).toBe('failed_terminal');
    expect(mismatch.lastReason).toBe('opencode_prompt_delivery_payload_mismatch');
    expect(mismatch.diagnostics.join('\n')).toContain('payload hash does not match');
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it('keeps ack-only destination proof nonterminal and due retry checks deterministic', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:first',
      now: '2026-04-25T10:00:00.000Z',
    });

    const ackOnly = await store.applyDestinationProof({
      id: record.id,
      visibleReplyInbox: 'user',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      semanticallySufficient: false,
      observedAt: '2026-04-25T10:00:01.000Z',
    });
    expect(ackOnly.status).toBe('pending');
    expect(ackOnly.responseState).toBe('responded_visible_message');
    expect(ackOnly.lastReason).toBe('visible_reply_ack_only_still_requires_answer');

    const scheduled = await store.markNextAttemptScheduled({
      id: record.id,
      status: 'retry_scheduled',
      nextAttemptAt: '2026-04-25T10:00:30.000Z',
      reason: 'visible_reply_ack_only_still_requires_answer',
      scheduledAt: '2026-04-25T10:00:02.000Z',
    });
    expect(isOpenCodePromptDeliveryAttemptDue(scheduled, Date.parse('2026-04-25T10:00:29.000Z'))).toBe(
      false
    );
    expect(isOpenCodePromptDeliveryAttemptDue(scheduled, Date.parse('2026-04-25T10:00:30.000Z'))).toBe(
      true
    );
  });

  it('records empty assistant delivery results as unanswered and stores plain text previews', async () => {
    const store = createStore();
    const unanswered = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-empty',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:empty',
      now: '2026-04-25T10:00:00.000Z',
    });

    const emptyResult = await store.applyDeliveryResult({
      id: unanswered.id,
      accepted: true,
      attempted: true,
      responseObservation: {
        state: 'empty_assistant_turn',
        deliveredUserMessageId: 'oc-user-1',
        assistantMessageId: 'oc-assistant-1',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'empty_assistant_turn',
      },
      now: '2026-04-25T10:00:05.000Z',
    });

    expect(emptyResult.status).toBe('unanswered');
    expect(emptyResult.responseState).toBe('empty_assistant_turn');
    expect(emptyResult.attempts).toBe(1);

    const plain = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-plain',
      inboxTimestamp: '2026-04-25T09:59:10.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:plain',
      now: '2026-04-25T10:00:10.000Z',
    });
    const observed = await store.applyObservation({
      id: plain.id,
      responseObservation: {
        state: 'responded_plain_text',
        deliveredUserMessageId: 'oc-user-2',
        assistantMessageId: 'oc-assistant-2',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: 'Понял',
        reason: null,
      },
      observedAt: '2026-04-25T10:00:15.000Z',
    });

    expect(observed.status).toBe('responded');
    expect(observed.observedAssistantPreview).toBe('Понял');
  });

  it('does not keep responded live deliveries active when no inbox commit is needed', async () => {
    const store = createStore();
    const direct = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'bob',
      laneId: 'secondary:opencode:bob',
      inboxMessageId: 'direct-ui-send',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'ui-send',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash: 'sha256:direct',
      now: '2026-04-25T10:00:00.000Z',
    });

    const responded = await store.applyDeliveryResult({
      id: direct.id,
      accepted: true,
      attempted: true,
      responseObservation: {
        state: 'responded_visible_message',
        deliveredUserMessageId: 'oc-user-direct',
        assistantMessageId: 'oc-assistant-direct',
        toolCallNames: ['agent-teams_message_send'],
        visibleMessageToolCallId: 'tool-call-direct',
        visibleReplyMessageId: 'reply-direct',
        visibleReplyCorrelation: 'direct_child_message_send',
        latestAssistantPreview: 'I will send the requested update.',
        reason: null,
      },
      now: '2026-04-25T10:00:05.000Z',
    });
    expect(responded.status).toBe('responded');
    expect(responded.inboxReadCommittedAt).toBeNull();

    await expect(store.getActiveForMember({
      teamName: 'team-a',
      memberName: 'bob',
      laneId: 'secondary:opencode:bob',
    })).resolves.toBeNull();

    const peer = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'bob',
      laneId: 'secondary:opencode:bob',
      inboxMessageId: 'peer-relay',
      inboxTimestamp: '2026-04-25T10:01:00.000Z',
      source: 'manual',
      replyRecipient: 'jack',
      actionMode: 'delegate',
      taskRefs: [],
      payloadHash: 'sha256:peer',
      now: '2026-04-25T10:01:00.000Z',
    });

    await expect(store.getActiveForMember({
      teamName: 'team-a',
      memberName: 'bob',
      laneId: 'secondary:opencode:bob',
    })).resolves.toMatchObject({
      id: peer.id,
      inboxMessageId: 'peer-relay',
    });
  });

  it('lists due nonterminal records in deterministic due order', async () => {
    const store = createStore();
    const first = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:first',
      now: '2026-04-25T10:00:00.000Z',
    });
    const second = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-2',
      inboxTimestamp: '2026-04-25T09:59:10.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:second',
      now: '2026-04-25T10:00:01.000Z',
    });
    await store.markNextAttemptScheduled({
      id: first.id,
      status: 'retry_scheduled',
      nextAttemptAt: '2026-04-25T10:00:20.000Z',
      reason: 'empty_assistant_turn',
      scheduledAt: '2026-04-25T10:00:02.000Z',
    });
    await store.markNextAttemptScheduled({
      id: second.id,
      status: 'retry_scheduled',
      nextAttemptAt: '2026-04-25T10:00:10.000Z',
      reason: 'empty_assistant_turn',
      scheduledAt: '2026-04-25T10:00:02.000Z',
    });

    const dueBefore = await store.listDue({
      teamName: 'team-a',
      now: new Date('2026-04-25T10:00:15.000Z'),
      limit: 10,
    });
    expect(dueBefore.map((record) => record.inboxMessageId)).toEqual(['msg-2']);

    const dueAfter = await store.listDue({
      teamName: 'team-a',
      now: new Date('2026-04-25T10:00:21.000Z'),
      limit: 10,
    });
    expect(dueAfter.map((record) => record.inboxMessageId)).toEqual(['msg-2', 'msg-1']);
  });

  it('rebuilds missing ledger rows as acceptance-unknown retryable records', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-1',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watchdog',
      replyRecipient: 'user',
      payloadHash: 'sha256:first',
      now: '2026-04-25T10:00:00.000Z',
    });

    const rebuilt = await store.markAcceptanceUnknown({
      id: record.id,
      reason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
      nextAttemptAt: '2026-04-25T10:00:00.000Z',
      markedAt: '2026-04-25T10:00:00.000Z',
    });

    expect(rebuilt.status).toBe('failed_retryable');
    expect(rebuilt.acceptanceUnknown).toBe(true);
    expect(rebuilt.responseState).toBe('not_observed');
    expect(rebuilt.lastReason).toBe('opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox');
  });

  it('prunes only terminal records after their retention windows', async () => {
    const store = createStore();
    const responded = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'responded',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:responded',
      now: '2026-04-25T10:00:00.000Z',
    });
    await store.applyDestinationProof({
      id: responded.id,
      visibleReplyInbox: 'user',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      semanticallySufficient: true,
      observedAt: '2026-04-25T10:00:01.000Z',
    });
    await store.markInboxReadCommitted({
      id: responded.id,
      committedAt: '2026-04-25T10:00:02.000Z',
    });

    const failed = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'failed',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:failed',
      now: '2026-04-25T10:00:00.000Z',
    });
    await store.markFailedTerminal({
      id: failed.id,
      reason: 'opencode_runtime_not_active',
      failedAt: '2026-04-25T10:00:03.000Z',
    });

    const active = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'active',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:active',
      now: '2026-04-25T10:00:00.000Z',
    });

    await expect(store.pruneTerminalRecords({
      now: new Date('2026-04-25T10:00:20.000Z'),
      respondedRetentionMs: 10_000,
      failedRetentionMs: 30_000,
    })).resolves.toEqual({ pruned: 1, remaining: 2 });
    expect((await store.list()).map((record) => record.inboxMessageId).sort()).toEqual([
      active.inboxMessageId,
      failed.inboxMessageId,
    ]);

    await expect(store.pruneTerminalRecords({
      now: new Date('2026-04-25T10:00:40.000Z'),
      respondedRetentionMs: 10_000,
      failedRetentionMs: 30_000,
    })).resolves.toEqual({ pruned: 1, remaining: 1 });
    expect((await store.list()).map((record) => record.inboxMessageId)).toEqual([
      active.inboxMessageId,
    ]);
  });
});
