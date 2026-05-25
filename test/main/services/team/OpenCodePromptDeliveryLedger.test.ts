import {
  buildOpenCodePromptDeliveryAttemptId,
  createOpenCodePromptDeliveryLedgerStore,
  hashOpenCodePromptDeliveryPayload,
  isOpenCodePromptDeliveryAttemptDue,
  isOpenCodeSessionRefreshResponseState,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('upgrades legacy pending records with message kind without changing payload identity', async () => {
    const store = createStore();
    const payloadHash = hashOpenCodePromptDeliveryPayload({
      text: 'Work sync check',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      source: 'watcher',
    });

    const legacy = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-work-sync',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      taskRefs: [],
      payloadHash,
      now: '2026-04-25T10:00:00.000Z',
    });
    const envelope = JSON.parse(await fs.readFile(ledgerPath(), 'utf8')) as {
      data: Record<string, unknown>[];
    };
    delete envelope.data[0].messageKind;
    await fs.writeFile(ledgerPath(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

    const upgraded = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-work-sync',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      messageKind: 'member_work_sync_nudge',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      taskRefs: [],
      payloadHash,
      now: '2026-04-25T10:00:30.000Z',
    });

    expect(upgraded.id).toBe(legacy.id);
    expect(upgraded.messageKind).toBe('member_work_sync_nudge');
    expect(upgraded.payloadHash).toBe(payloadHash);
    expect(upgraded.attempts).toBe(0);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it.each(corruptionCases)('rejects corrupted persisted records with %s', async (_name, mutate) => {
    const store = await writeCorruptedLedgerRecord(mutate);

    await expect(store.list()).rejects.toMatchObject({
      reason: 'invalid_data',
    });
    await expect(fs.readdir(tempDir)).resolves.toContain('opencode-prompt-delivery-ledger.json');
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
    expect(
      isOpenCodePromptDeliveryAttemptDue(scheduled, Date.parse('2026-04-25T10:00:29.000Z'))
    ).toBe(false);
    expect(
      isOpenCodePromptDeliveryAttemptDue(scheduled, Date.parse('2026-04-25T10:00:30.000Z'))
    ).toBe(true);
  });

  it('preserves missing taskRefs as the pending reason for insufficient destination proof', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-taskrefs',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:taskrefs',
      now: '2026-04-25T10:00:00.000Z',
    });

    const missingTaskRefs = await store.applyDestinationProof({
      id: record.id,
      visibleReplyInbox: 'user',
      visibleReplyMessageId: 'reply-taskrefs',
      visibleReplyCorrelation: 'relayOfMessageId',
      semanticallySufficient: false,
      diagnostics: ['visible_reply_missing_task_refs_after_merge'],
      observedAt: '2026-04-25T10:00:01.000Z',
    });

    expect(missingTaskRefs.status).toBe('pending');
    expect(missingTaskRefs.responseState).toBe('responded_visible_message');
    expect(missingTaskRefs.lastReason).toBe('visible_reply_missing_task_refs');
    expect(missingTaskRefs.diagnostics).toContain('visible_reply_missing_task_refs_after_merge');
  });

  it('clears stale terminal failure state after sufficient destination proof', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-recovered',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'team-lead',
      payloadHash: 'sha256:recovered',
      now: '2026-04-25T10:00:00.000Z',
    });
    const acceptanceUnknown = await store.markAcceptanceUnknown({
      id: record.id,
      reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
      nextAttemptAt: '2026-04-25T10:00:30.000Z',
      markedAt: '2026-04-25T10:00:01.000Z',
    });
    const failed = await store.markFailedTerminal({
      id: acceptanceUnknown.id,
      reason: 'opencode_session_stale_observe_loop_after_accepted_prompt',
      diagnostics: ['OpenCode session stayed stale while observing an accepted prompt after 5 attempt(s).'],
      failedAt: '2026-04-25T10:00:05.000Z',
    });

    const recovered = await store.applyDestinationProof({
      id: failed.id,
      visibleReplyInbox: 'team-lead',
      visibleReplyMessageId: 'reply-recovered',
      visibleReplyCorrelation: 'relayOfMessageId',
      semanticallySufficient: true,
      diagnostics: ['opencode_visible_reply_recovered_by_task_refs'],
      observedAt: '2026-04-25T10:01:00.000Z',
    });

    expect(recovered.status).toBe('responded');
    expect(recovered.responseState).toBe('responded_visible_message');
    expect(recovered.failedAt).toBeNull();
    expect(recovered.lastReason).toBeNull();
    expect(recovered.nextAttemptAt).toBeNull();
    expect(recovered.acceptanceUnknown).toBe(false);
    expect(recovered.visibleReplyMessageId).toBe('reply-recovered');
    expect(recovered.diagnostics).toContain('opencode_session_stale_observe_loop_after_accepted_prompt');
    expect(recovered.diagnostics).toContain('opencode_visible_reply_recovered_by_task_refs');
  });

  it('keeps terminal failure active when destination proof is not semantically sufficient', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-insufficient-proof',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'team-lead',
      payloadHash: 'sha256:insufficient-proof',
      now: '2026-04-25T10:00:00.000Z',
    });
    const failed = await store.markFailedTerminal({
      id: record.id,
      reason: 'visible_reply_still_required',
      diagnostics: ['OpenCode responded, but did not create a visible message_send reply.'],
      failedAt: '2026-04-25T10:00:05.000Z',
    });

    const stillFailed = await store.applyDestinationProof({
      id: failed.id,
      visibleReplyInbox: 'team-lead',
      visibleReplyMessageId: 'reply-ack-only',
      visibleReplyCorrelation: 'relayOfMessageId',
      semanticallySufficient: false,
      diagnostics: ['visible_reply_ack_only_still_requires_answer'],
      observedAt: '2026-04-25T10:01:00.000Z',
    });

    expect(stillFailed.status).toBe('failed_terminal');
    expect(stillFailed.responseState).toBe('responded_visible_message');
    expect(stillFailed.failedAt).toBe('2026-04-25T10:00:05.000Z');
    expect(stillFailed.lastReason).toBe('visible_reply_ack_only_still_requires_answer');
    expect(stillFailed.visibleReplyMessageId).toBe('reply-ack-only');
    expect(stillFailed.diagnostics).toContain('visible_reply_ack_only_still_requires_answer');
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
      sessionId: 'oc-session-1',
      runtimePromptMessageId: 'msg_prompt_1',
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
    expect(emptyResult.runtimeSessionId).toBe('oc-session-1');
    expect(emptyResult.runtimePromptMessageId).toBe('msg_prompt_1');

    const noAssistant = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-no-assistant',
      inboxTimestamp: '2026-04-25T09:59:05.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:no-assistant',
      now: '2026-04-25T10:00:06.000Z',
    });
    const noAssistantResult = await store.applyDeliveryResult({
      id: noAssistant.id,
      accepted: true,
      attempted: true,
      responseObservation: {
        state: 'prompt_delivered_no_assistant_message',
        deliveredUserMessageId: 'oc-user-no-assistant',
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'prompt_delivered_no_assistant_message',
      },
      now: '2026-04-25T10:00:07.000Z',
    });

    expect(noAssistantResult.status).toBe('unanswered');
    expect(noAssistantResult.responseState).toBe('prompt_delivered_no_assistant_message');

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

  it('tracks accepted runtime prompt ids without double-counting recovered command status', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-accepted',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:accepted',
      now: '2026-04-25T10:00:00.000Z',
    });

    const firstAccepted = await store.applyDeliveryResult({
      id: record.id,
      accepted: true,
      attempted: true,
      sessionId: 'oc-session-1',
      runtimePromptMessageId: 'msg_prompt_1',
      deliveryAttemptId: 'attempt-1',
      now: '2026-04-25T10:00:05.000Z',
    });
    expect(firstAccepted).toMatchObject({
      status: 'accepted',
      attempts: 1,
      runtimePromptMessageId: 'msg_prompt_1',
      lastRuntimePromptMessageId: 'msg_prompt_1',
      lastDeliveryAttemptIdWithAcceptedPrompt: 'attempt-1',
    });
    expect(firstAccepted.runtimePromptMessageIds).toEqual(['msg_prompt_1']);

    const recoveredSamePrompt = await store.applyDeliveryResult({
      id: record.id,
      accepted: true,
      attempted: true,
      sessionId: 'oc-session-1',
      runtimePromptMessageId: 'msg_prompt_1',
      deliveryAttemptId: 'attempt-1',
      now: '2026-04-25T10:00:06.000Z',
    });
    expect(recoveredSamePrompt.attempts).toBe(1);
    expect(recoveredSamePrompt.runtimePromptMessageIds).toEqual(['msg_prompt_1']);

    const retryAccepted = await store.applyDeliveryResult({
      id: record.id,
      accepted: true,
      attempted: true,
      sessionId: 'oc-session-2',
      runtimePromptMessageId: 'msg_prompt_2',
      deliveryAttemptId: 'attempt-2',
      now: '2026-04-25T10:01:00.000Z',
    });
    expect(retryAccepted.attempts).toBe(2);
    expect(retryAccepted.runtimePromptMessageIds).toEqual(['msg_prompt_1', 'msg_prompt_2']);
    expect(retryAccepted.lastRuntimePromptMessageId).toBe('msg_prompt_2');
  });

  it('tracks session refresh retries without consuming normal delivery attempts', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-session-stale',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:session-stale',
      now: '2026-04-25T10:00:00.000Z',
    });

    expect(buildOpenCodePromptDeliveryAttemptId(record)).toBe(
      `${record.id}:1:${record.payloadHash.slice(0, 12)}`
    );

    const stale = await store.applyDeliveryResult({
      id: record.id,
      accepted: false,
      attempted: true,
      responseObservation: {
        state: 'session_stale',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'resolved_behavior_changed:old->new',
      },
      diagnostics: ['OpenCode session reconcile skipped because the stored session is stale'],
      now: '2026-04-25T10:00:05.000Z',
    });

    expect(stale.attempts).toBe(0);
    expect(stale.responseState).toBe('session_stale');
    expect(stale.lastSessionRefreshReason).toBe('resolved_behavior_changed:old->new');

    const scheduled = await store.markSessionRefreshScheduled({
      id: record.id,
      nextAttemptAt: '2026-04-25T10:00:10.000Z',
      reason: 'resolved_behavior_changed:old->new',
      scheduledAt: '2026-04-25T10:00:06.000Z',
    });

    expect(scheduled.status).toBe('retry_scheduled');
    expect(scheduled.attempts).toBe(0);
    expect(scheduled.sessionRefreshAttempts).toBe(1);
    expect(buildOpenCodePromptDeliveryAttemptId(scheduled)).toBe(
      `${record.id}:1:${record.payloadHash.slice(0, 12)}:refresh1`
    );
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'opencode_app_mcp_transport_changed:old->new',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: '(resolved_behavior_changed:old->new)',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:old.hash/1=abc->new.hash/2=def.',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:tool_error->session_error',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:responded_non_visible_tool->pending',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:permission_blocked->pending',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason:
          'resolved_behavior_changed:old->new opencode_app_mcp_transport_changed:a->b',
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); reading historical messages for log projection only',
        ],
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new unexpected detail'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['OpenCode API error', 'resolved_behavior_changed:old->new'],
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['OpenCode API error:', 'resolved_behavior_changed:old->new'],
      })
    ).toBe(true);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['OpenCode API errorresolved_behavior_changed:old->new'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['OpenCode API error.', 'opencode_app_mcp_transport_changed:old->new'],
      })
    ).toBe(true);
    for (const reason of [
      'opencode_prompt_delivery_session_refresh_scheduled',
      'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled',
      'opencode_session_refresh_scheduled_after_resolved_behavior_changed',
      'OpenCode API error: opencode_session_refresh_scheduled_after_resolved_behavior_changed',
      'OpenCode session refresh scheduled after resolved behavior changed',
      'OpenCode session changed; refreshing the session before retry.',
    ]) {
      expect(
        isOpenCodeSessionRefreshResponseState({
          responseState: 'pending',
          reason,
        })
      ).toBe(true);
    }
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'pending',
        reason: 'OpenCode API erroropencode_prompt_delivery_session_refresh_scheduled',
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); permission denied',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); network timeout',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_task_refs',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new', 'unable to connect to provider'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'OpenCode API error',
          'resolved_behavior_changed:old->new',
          'permission denied',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new', 'auth_unavailable'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: [
          'resolved_behavior_changed:old->new',
          'Key limit exceeded (total limit). Manage it using OpenRouter settings.',
        ],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new', '429 too many requests'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:old->new permission denied',
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:old->new;permission_denied',
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:old->new:permission_denied',
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'resolved_behavior_changed:old->new_permission_denied',
      })
    ).toBe(false);
    for (const suffix of ['error', 'failed', 'failure', 'aborted', 'canceled', 'cancelled', 'interrupted', 'enospc']) {
      expect(
        isOpenCodeSessionRefreshResponseState({
          reason: `resolved_behavior_changed:old->new_${suffix}`,
        })
      ).toBe(false);
    }
    for (const reason of [
      'resolved_behavior_changed:old->new/auth_unavailable',
      'resolved_behavior_changed:old->new permission denied',
      'resolved_behavior_changed:old->new permission_blocked',
      'resolved_behavior_changed:old->new login required',
      'resolved_behavior_changed:old->new not logged in',
      'resolved_behavior_changed:old->new missing credentials',
      'resolved_behavior_changed:old->new access denied',
      'resolved_behavior_changed:old->new 401',
      'resolved_behavior_changed:old->new;key limit exceeded',
      'resolved_behavior_changed:old->new-network_timeout',
      'resolved_behavior_changed:old->new(non_visible_tool_without_task_progress)',
      'resolved_behavior_changed:old->new interrupted',
      'opencode_app_mcp_transport_changed:old->new/permission_denied',
      'opencode_app_mcp_transport_changed:old->new;visible_reply_missing_task_refs',
    ]) {
      expect(
        isOpenCodeSessionRefreshResponseState({
          reason,
        })
      ).toBe(false);
    }
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new', 'cancelled'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['resolved_behavior_changed:old->new', 'login required'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        reason: 'opencode_app_mcp_transport_changed:old->new/permission_denied',
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        diagnostics: ['opencode_app_mcp_transport_changed:old->new:permission_denied'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['permission denied'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['permission_blocked'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['authentication_failed'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['Free usage exceeded, subscribe to Go'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['visible_reply_missing_task_refs'],
      })
    ).toBe(false);
    expect(
      isOpenCodeSessionRefreshResponseState({
        responseState: 'session_stale',
        diagnostics: ['OpenCode session reconcile skipped because the stored session is stale'],
      })
    ).toBe(true);
  });

  it('tracks observe-only stale sessions without scheduling another prompt send', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-session-stale-observe-only',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:session-stale-observe-only',
      now: '2026-04-25T10:00:00.000Z',
    });
    const accepted = await store.applyDeliveryResult({
      id: record.id,
      accepted: true,
      attempted: true,
      sessionId: 'oc-session-1',
      runtimePromptMessageId: 'msg_prompt_1',
      deliveryAttemptId: 'attempt-1',
      responseObservation: {
        state: 'pending',
        deliveredUserMessageId: 'msg_prompt_1',
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'assistant_response_pending',
      },
      now: '2026-04-25T10:00:01.000Z',
    });

    const scheduled = await store.markSessionStaleObservationScheduled({
      id: accepted.id,
      nextAttemptAt: '2026-04-25T10:00:10.000Z',
      reason: 'resolved_behavior_changed:old->new',
      scheduledAt: '2026-04-25T10:00:06.000Z',
      diagnostics: ['opencode_session_stale_observe_scheduled_after_accepted_prompt'],
    });

    expect(scheduled.status).toBe('accepted');
    expect(scheduled.attempts).toBe(1);
    expect(scheduled.sessionRefreshAttempts).toBe(1);
    expect(scheduled.runtimePromptMessageIds).toEqual(['msg_prompt_1']);
    expect(buildOpenCodePromptDeliveryAttemptId(scheduled)).toBe(
      `${record.id}:2:${record.payloadHash.slice(0, 12)}:refresh1`
    );
  });

  it('does not treat session_stale with action-required diagnostics as a refresh retry', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-session-stale-auth-error',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:session-stale-auth-error',
      now: '2026-04-25T10:00:00.000Z',
    });

    const staleWithAuthFailure = await store.applyDeliveryResult({
      id: record.id,
      accepted: false,
      attempted: true,
      responseObservation: {
        state: 'session_stale',
        deliveredUserMessageId: null,
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'permission denied',
      },
      diagnostics: ['permission denied'],
      now: '2026-04-25T10:00:05.000Z',
    });

    expect(staleWithAuthFailure.attempts).toBe(1);
    expect(staleWithAuthFailure.responseState).toBe('session_stale');
    expect(staleWithAuthFailure.lastSessionRefreshReason).toBeNull();
    expect(buildOpenCodePromptDeliveryAttemptId(staleWithAuthFailure)).toBe(
      `${record.id}:2:${record.payloadHash.slice(0, 12)}`
    );
  });

  it('keeps schema-1 legacy prompt-id fields compatible and normalizes when touched', async () => {
    const store = createStore();
    const legacy = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-legacy-runtime-prompt',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:legacy-runtime-prompt',
      now: '2026-04-25T10:00:00.000Z',
    });

    const envelope = JSON.parse(await fs.readFile(ledgerPath(), 'utf8')) as {
      data: Record<string, unknown>[];
    };
    delete envelope.data[0].runtimePromptMessageIds;
    delete envelope.data[0].lastRuntimePromptMessageId;
    delete envelope.data[0].lastDeliveryAttemptIdWithAcceptedPrompt;
    await fs.writeFile(ledgerPath(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

    await expect(store.list()).resolves.toHaveLength(1);

    const touched = await store.applyDeliveryResult({
      id: legacy.id,
      accepted: true,
      attempted: true,
      runtimePromptMessageId: 'msg_prompt_legacy_touch',
      deliveryAttemptId: 'attempt-legacy-touch',
      now: '2026-04-25T10:00:05.000Z',
    });
    expect(touched.runtimePromptMessageIds).toEqual(['msg_prompt_legacy_touch']);
    expect(touched.lastRuntimePromptMessageId).toBe('msg_prompt_legacy_touch');
    expect(touched.lastDeliveryAttemptIdWithAcceptedPrompt).toBe('attempt-legacy-touch');
  });

  it('accepts task stall remediation message kind across ledger validation', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'task-stall:team-a:jack:task-a',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watchdog',
      messageKind: 'task_stall_remediation',
      replyRecipient: 'team-lead',
      actionMode: 'do',
      payloadHash: 'sha256:task-stall',
      now: '2026-04-25T10:00:00.000Z',
    });

    expect(record.messageKind).toBe('task_stall_remediation');
    await expect(store.list()).resolves.toMatchObject([
      { messageKind: 'task_stall_remediation' },
    ]);
  });

  it('upgrades acceptance-unknown records when exact observation finds the prompt', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-observed-later',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:observed-later',
      now: '2026-04-25T10:00:00.000Z',
    });
    const unknown = await store.markAcceptanceUnknown({
      id: record.id,
      reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
      nextAttemptAt: '2026-04-25T10:01:00.000Z',
      markedAt: '2026-04-25T10:00:45.000Z',
    });
    expect(unknown.acceptanceUnknown).toBe(true);

    const observed = await store.applyObservation({
      id: record.id,
      sessionId: 'oc-session-recovered',
      runtimePromptMessageId: 'msg_prompt_recovered',
      responseObservation: {
        state: 'pending',
        deliveredUserMessageId: 'msg_prompt_recovered',
        assistantMessageId: null,
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: null,
        reason: 'assistant_response_pending',
      },
      observedAt: '2026-04-25T10:00:50.000Z',
    });

    expect(observed.status).toBe('accepted');
    expect(observed.acceptanceUnknown).toBe(false);
    expect(observed.acceptedAt).toBe('2026-04-25T10:00:50.000Z');
    expect(observed.runtimeSessionId).toBe('oc-session-recovered');
    expect(observed.runtimePromptMessageIds).toEqual(['msg_prompt_recovered']);
  });

  it('keeps plain-text responses active until their visible inbox reply is materialized', async () => {
    const store = createStore();
    const record = await store.ensurePending({
      teamName: 'team-a',
      memberName: 'jack',
      laneId: 'secondary:opencode:jack',
      inboxMessageId: 'msg-plain-visible',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      actionMode: 'ask',
      taskRefs: [],
      payloadHash: 'sha256:plain-visible',
      now: '2026-04-25T10:00:00.000Z',
    });

    const responded = await store.applyDeliveryResult({
      id: record.id,
      accepted: true,
      attempted: true,
      responseObservation: {
        state: 'responded_plain_text',
        deliveredUserMessageId: 'oc-user-plain',
        assistantMessageId: 'oc-assistant-plain',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: 'Concrete visible answer.',
        reason: null,
      },
      now: '2026-04-25T10:00:05.000Z',
    });
    expect(responded.status).toBe('responded');

    await expect(
      store.getActiveForMember({
        teamName: 'team-a',
        memberName: 'jack',
        laneId: 'secondary:opencode:jack',
      })
    ).resolves.toMatchObject({
      id: record.id,
      responseState: 'responded_plain_text',
    });

    const materialized = await store.applyDestinationProof({
      id: record.id,
      visibleReplyInbox: 'user',
      visibleReplyMessageId: 'opencode-plain-reply-1',
      visibleReplyCorrelation: 'plain_assistant_text',
      semanticallySufficient: true,
      observedAt: '2026-04-25T10:00:06.000Z',
    });
    expect(materialized).toMatchObject({
      status: 'responded',
      responseState: 'responded_plain_text',
      visibleReplyCorrelation: 'plain_assistant_text',
    });

    await expect(
      store.getActiveForMember({
        teamName: 'team-a',
        memberName: 'jack',
        laneId: 'secondary:opencode:jack',
      })
    ).resolves.toBeNull();
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

    await expect(
      store.getActiveForMember({
        teamName: 'team-a',
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
      })
    ).resolves.toBeNull();

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

    await expect(
      store.getActiveForMember({
        teamName: 'team-a',
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
      })
    ).resolves.toMatchObject({
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

    await expect(
      store.pruneTerminalRecords({
        now: new Date('2026-04-25T10:00:20.000Z'),
        respondedRetentionMs: 10_000,
        failedRetentionMs: 30_000,
      })
    ).resolves.toEqual({ pruned: 1, remaining: 2 });
    expect((await store.list()).map((record) => record.inboxMessageId).sort()).toEqual([
      active.inboxMessageId,
      failed.inboxMessageId,
    ]);

    await expect(
      store.pruneTerminalRecords({
        now: new Date('2026-04-25T10:00:40.000Z'),
        respondedRetentionMs: 10_000,
        failedRetentionMs: 30_000,
      })
    ).resolves.toEqual({ pruned: 1, remaining: 1 });
    expect((await store.list()).map((record) => record.inboxMessageId)).toEqual([
      active.inboxMessageId,
    ]);
  });
});
