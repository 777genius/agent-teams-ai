import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  markOpenCodeGroupHandoff,
  unknownGroupHandoffSnapshot,
} from '../OpenCodeDeliverySnapshots';
import { materializeOpenCodeGroupReply } from '../OpenCodeGroupVisibleReply';
import {
  HUMAN_GROUP_REPLY_REQUIRED,
  isOpenCodeHumanGroupNonResponse,
} from '../OpenCodeHumanGroupReply';
import {
  getOpenCodeDeliveryNextDelayMs,
  OpenCodePromptDeliveryFollowUpPolicy,
} from '../OpenCodePromptDeliveryFollowUpPolicy';
import { createOpenCodePromptDeliveryLedgerStore } from '../OpenCodePromptDeliveryLedger';
import {
  getOpenCodeDeliveryPendingReason,
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDeliveryRetryablePendingResponse,
} from '../OpenCodePromptDeliveryReadCommitPolicy';
import { isOpenCodePromptDeliveryRetryAttemptDue } from '../OpenCodePromptDeliveryWatchdog';
import { prepareOpenCodePromptDispatch } from '../OpenCodePromptDispatchPreparation';

const ISO = '2026-10-26T10:00:00.000Z';
const marker = '[[AGENT_TEAMS_NO_REPLY]]';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-human-group-reply-'));
  dirs.push(dir);
  const filePath = join(dir, 'ledger.json');
  const ledger = createOpenCodePromptDeliveryLedgerStore({ filePath });
  const pending = await ledger.ensurePending({
    teamName: 'TEST-team',
    memberName: 'alice',
    laneId: 'secondary:alice',
    runId: 'lane-run',
    inboxMessageId: 'physical-inbound',
    groupChatId: 'group',
    inboxTimestamp: ISO,
    source: 'ui-send',
    replyRecipient: 'user',
    payloadHash: 'hash',
    maxAttempts: 2,
    now: ISO,
  });
  const record = await ledger.applyDeliveryResult({
    id: pending.id,
    accepted: true,
    runtimePromptMessageId: 'prompt-1',
    deliveryAttemptId: 'attempt-1',
    responseObservation: {
      state: 'responded_plain_text',
      deliveredUserMessageId: 'prompt-1',
      assistantMessageId: 'assistant-1',
      latestAssistantPreview: marker,
      toolCallNames: [],
      visibleMessageToolCallId: null,
      visibleReplyMessageId: null,
      visibleReplyCorrelation: null,
      reason: 'assistant_replied_with_plain_text',
    },
    now: ISO,
  });
  return { ledger, record, reload: () => createOpenCodePromptDeliveryLedgerStore({ filePath }) };
}

const pendingReason = (
  input: Omit<Parameters<typeof getOpenCodeDeliveryPendingReason>[0], 'taskRefsIncludeAll'>
) => getOpenCodeDeliveryPendingReason({ ...input, taskRefsIncludeAll: () => true });
const readAllowed = (
  input: Omit<
    Parameters<typeof isOpenCodeDeliveryResponseReadCommitAllowed>[0],
    'taskRefsIncludeAll' | 'hasAcceptedMemberWorkSyncReport'
  >
) =>
  isOpenCodeDeliveryResponseReadCommitAllowed({
    ...input,
    taskRefsIncludeAll: () => true,
    hasAcceptedMemberWorkSyncReport: async () => false,
  });

describe('human group non-response recovery', () => {
  it('keeps the real ledger unread, repairs only control text, and accepts a canonical reaction', async () => {
    const { ledger, record, reload } = await fixture();
    const send = vi.fn();
    const proof = await materializeOpenCodeGroupReply({
      ledger,
      ledgerRecord: record,
      teamName: record.teamName,
      memberName: 'alice',
      send,
      checkpoint: async () => {},
      messageId: 'reply',
      nowIso: () => ISO,
    });
    expect(proof.ledgerRecord.status).toBe('responded');
    expect(send).not.toHaveBeenCalled();
    expect(
      await readAllowed({
        ledgerRecord: record,
        responseState: record.responseState,
        teamName: record.teamName,
        memberName: 'alice',
      })
    ).toBe(false);
    expect(pendingReason({ ledgerRecord: record })).toBe(HUMAN_GROUP_REPLY_REQUIRED);
    expect(
      isOpenCodeDeliveryRetryablePendingResponse({ ledgerRecord: record, readAllowed: false })
    ).toBe(true);
    expect(
      isOpenCodePromptDeliveryRetryAttemptDue({ ledgerRecord: record, attemptDue: true })
    ).toBe(true);
    const dispatch = await prepareOpenCodePromptDispatch({
      deps: {
        getOpenCodeDeliveryPendingReason: pendingReason,
        isOpenCodeDeliveryResponseReadCommitAllowed: readAllowed,
        resolveControlApiBaseUrl: async () => null,
      },
      teamName: record.teamName,
      memberName: 'alice',
      message: {
        text: 'всем привет!',
        messageId: record.inboxMessageId,
        groupChatId: 'group',
        replyRecipient: 'user',
      },
      ledgerRecord: record,
      forceSessionRefreshReason: undefined,
    });
    expect(dispatch.promptBodyAlreadyDelivered).toBe(true);
    expect(dispatch.forceSessionRefreshReason).toBeUndefined();
    expect(dispatch.deliveryText).not.toContain('всем привет!');
    expect(dispatch.deliveryText).toContain('group_chat_react');
    expect(dispatch.deliveryText).toContain('group_chat_send');
    expect(dispatch.deliveryText).toContain('physical-inbound');
    expect(dispatch.deliveryText).not.toContain('via message_send');
    const initial = await prepareOpenCodePromptDispatch({
      deps: {
        getOpenCodeDeliveryPendingReason: pendingReason,
        isOpenCodeDeliveryResponseReadCommitAllowed: readAllowed,
        resolveControlApiBaseUrl: async () => null,
      },
      teamName: record.teamName,
      memberName: 'alice',
      message: { text: 'всем привет!', messageId: record.inboxMessageId, groupChatId: 'group' },
      ledgerRecord: {
        ...record,
        acceptedAt: null,
        runtimePromptMessageId: null,
        lastRuntimePromptMessageId: null,
        runtimePromptMessageIds: [],
        deliveredUserMessageId: null,
      },
      forceSessionRefreshReason: undefined,
    });
    expect(initial.deliveryText).toContain('всем привет!');
    expect(initial.deliveryText).toContain('Human group messages require');
    const hasAcknowledgedInbound = vi.fn(async () => true);
    expect(
      await readAllowed({
        ledgerRecord: record,
        responseState: record.responseState,
        teamName: record.teamName,
        memberName: 'alice',
        hasAcknowledgedInbound,
      })
    ).toBe(true);
    expect(hasAcknowledgedInbound).toHaveBeenCalledExactlyOnceWith({
      teamName: record.teamName,
      memberName: 'alice',
      groupChatId: 'group',
      inboxMessageId: 'physical-inbound',
      runId: 'lane-run',
    });
    expect(proof.ledgerRecord.inboxReadCommittedAt).toBeNull();
    expect((await reload().getByInboxMessage(record))?.inboxReadCommittedAt).toBeNull();
  });

  it('persists a separate corrective handoff fence despite original accepted prompt proof', async () => {
    const { ledger, record, reload } = await fixture();
    const handedOff = await markOpenCodeGroupHandoff(ledger, record, ISO);
    expect(handedOff.groupRepairHandoffPending).toBe(true);
    const persisted = await reload().getByInboxMessage(record);
    expect(unknownGroupHandoffSnapshot(persisted!, record.laneId)).toMatchObject({
      acceptanceUnknown: true,
      reason: 'group_handoff_acceptance_unknown',
    });
    const failed = await ledger.applyDeliveryResult({
      id: record.id,
      accepted: false,
      attempted: true,
      reason: 'transport timeout',
      now: ISO,
    });
    expect(unknownGroupHandoffSnapshot(failed, record.laneId)).not.toBeNull();
    const accepted = await ledger.applyDeliveryResult({
      id: record.id,
      accepted: true,
      runtimePromptMessageId: 'prompt-2',
      deliveryAttemptId: 'attempt-2',
      now: ISO,
    });
    expect(accepted.groupRepairHandoffPending).toBe(false);
    expect(accepted.attempts).toBe(3);
    expect(isOpenCodeHumanGroupNonResponse(accepted)).toBe(false); // old child cannot certify new prompt
  });

  it('releases only a runtime-confirmed unsubmitted corrective handoff for a bounded retry', async () => {
    const { ledger, record, reload } = await fixture();
    await markOpenCodeGroupHandoff(ledger, record, ISO);
    const failed = await ledger.applyDeliveryResult({
      id: record.id,
      accepted: false,
      attempted: true,
      promptNotSubmitted: true,
      reason: 'host acquisition timeout',
      now: ISO,
    });
    expect(failed.acceptanceUnknown).toBe(false);
    expect(failed.groupRepairHandoffPending).toBe(false);
    await ledger.markNextAttemptScheduled({
      id: record.id,
      status: 'retry_scheduled',
      nextAttemptAt: ISO,
      scheduledAt: ISO,
      reason: 'pre_submission_retry',
    });
    const persisted = await reload().getByInboxMessage(record);
    expect(unknownGroupHandoffSnapshot(persisted!, record.laneId)).toBeNull();
    expect(persisted?.attempts).toBe(record.attempts + 1);
  });

  it.each([false, true])(
    'settles corrective handoff once, with prior result counted=%s',
    async (counted) => {
      const { ledger, record } = await fixture();
      await markOpenCodeGroupHandoff(ledger, record, ISO);
      if (counted)
        await ledger.applyDeliveryResult({
          id: record.id,
          accepted: false,
          attempted: true,
          reason: 'transport timeout',
          now: ISO,
        });
      const observation = (id: string) => ({
        state: 'responded_plain_text' as const,
        deliveredUserMessageId: id,
        assistantMessageId: 'assistant',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: marker,
        reason: null,
      });
      const old = await ledger.applyObservation({
        id: record.id,
        responseObservation: observation('prompt-1'),
        observedAt: ISO,
      });
      expect(old.groupRepairHandoffPending).toBe(true);
      const fresh = await ledger.applyObservation({
        id: record.id,
        responseObservation: observation('prompt-2'),
        observedAt: ISO,
      });
      expect(fresh.groupRepairHandoffPending).toBe(false);
      expect(fresh.attempts).toBe(record.attempts + 1);
      const repeated = await ledger.applyObservation({
        id: record.id,
        responseObservation: observation('prompt-2'),
        observedAt: ISO,
      });
      expect(repeated.attempts).toBe(fresh.attempts);
      expect(isOpenCodeHumanGroupNonResponse(fresh)).toBe(true);
      expect(unknownGroupHandoffSnapshot(fresh, record.laneId)).toBeNull();
    }
  );

  it('clears the old marker atomically before correction and materializes only the fresh child', async () => {
    const { ledger, record, reload } = await fixture();
    expect(
      getOpenCodeDeliveryNextDelayMs({
        retry: true,
        responseState: record.responseState,
        ledgerRecord: record,
      })
    ).toBe(15_000);
    expect(
      getOpenCodeDeliveryNextDelayMs({
        retry: true,
        responseState: record.responseState,
        ledgerRecord: { ...record, observedAssistantPreview: 'Concrete answer' },
      })
    ).toBe(90_000);
    await markOpenCodeGroupHandoff(ledger, record, ISO);
    const handoff = await reload().getByInboxMessage(record);
    expect(handoff).toMatchObject({
      groupRepairHandoffPending: true,
      responseState: 'pending',
      deliveredUserMessageId: null,
      observedAssistantMessageId: null,
      observedAssistantPreview: null,
      observedToolCallNames: [],
      observedVisibleMessageId: null,
      visibleReplyCorrelation: null,
      respondedAt: null,
      runtimePromptMessageId: 'prompt-1',
      acceptedAt: ISO,
    });
    const accepted = await ledger.applyDeliveryResult({
      id: record.id,
      accepted: true,
      runtimePromptMessageId: 'prompt-2',
      deliveryAttemptId: 'attempt-2',
      now: ISO,
    });
    const policy = new OpenCodePromptDeliveryFollowUpPolicy({
      markFailedTerminal: async (input) => ledger.markFailedTerminal(input),
      logEvent: vi.fn(),
      scheduleWatchdog: vi.fn(),
      nowIso: () => ISO,
      nowMs: () => Date.parse(ISO),
    });
    const observeOnly = await policy.schedule({
      ledger,
      ledgerRecord: accepted,
      teamName: record.teamName,
      memberName: record.memberName,
      retry: false,
      reason: 'group_repair_handoff_acceptance_unknown',
    });
    expect(observeOnly).toMatchObject({
      groupRepairHandoffPending: false,
      responseState: 'pending',
      runtimePromptMessageId: 'prompt-2',
    });
    expect(unknownGroupHandoffSnapshot(observeOnly, record.laneId)).toBeNull();
    const send = vi.fn(async () => ({
      saved: true as const,
      groupChatId: 'group',
      messageId: 'reply',
      statusPersisted: true,
    }));
    const input = {
      ledger,
      ledgerRecord: observeOnly,
      teamName: record.teamName,
      memberName: 'alice',
      send,
      checkpoint: async () => {},
      messageId: 'reply',
      nowIso: () => ISO,
    };
    const waiting = await materializeOpenCodeGroupReply(input);
    expect(waiting.ledgerRecord).toMatchObject({
      status: 'accepted',
      responseState: 'pending',
      observedAssistantPreview: null,
      runtimePromptMessageId: 'prompt-2',
    });
    expect(send).not.toHaveBeenCalled();
    const observed = await ledger.applyObservation({
      id: record.id,
      responseObservation: {
        state: 'responded_plain_text',
        deliveredUserMessageId: 'prompt-2',
        assistantMessageId: 'assistant-2',
        latestAssistantPreview: 'Привет! Я Alice, на связи.',
        toolCallNames: [],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        reason: 'assistant_replied_with_plain_text',
      },
      observedAt: ISO,
    });
    const completed = await materializeOpenCodeGroupReply({ ...input, ledgerRecord: observed });
    expect(completed.visibleReply?.message).toMatchObject({
      groupChatId: 'group',
      relayOfMessageId: record.inboxMessageId,
      text: 'Привет! Я Alice, на связи.',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(completed.ledgerRecord).toMatchObject({
      status: 'responded',
      attempts: 2,
      visibleReplyMessageId: 'reply',
    });
  });

  it('reopens only the old unsupported human failure with remaining budget in the same run', async () => {
    const { ledger, record } = await fixture();
    await ledger.markFailedTerminal({
      id: record.id,
      reason: 'group_non_response_runtime_unsupported',
      failedAt: ISO,
    });
    const request = {
      teamName: record.teamName,
      memberName: record.memberName,
      laneId: record.laneId,
      runId: record.runId,
      inboxMessageId: record.inboxMessageId,
      groupChatId: record.groupChatId,
      inboxTimestamp: ISO,
      source: 'ui-send' as const,
      replyRecipient: 'user',
      payloadHash: record.payloadHash,
      now: ISO,
    };
    const recovered = await ledger.ensurePending(request);
    expect(recovered).toMatchObject({
      status: 'retry_scheduled',
      lastReason: HUMAN_GROUP_REPLY_REQUIRED,
      attempts: 1,
      failedAt: null,
      runtimePromptMessageId: 'prompt-1',
      inboxReadCommittedAt: null,
    });
    await ledger.markFailedTerminal({
      id: record.id,
      reason: HUMAN_GROUP_REPLY_REQUIRED,
      failedAt: ISO,
    });
    expect((await ledger.ensurePending(request)).status).toBe('failed_terminal');
    await ledger.markFailedTerminal({
      id: record.id,
      reason: 'group_non_response_runtime_unsupported',
      failedAt: ISO,
    });
    expect((await ledger.ensurePending({ ...request, runId: 'other-run' })).cancelledAt).toBe(ISO);
  });

  it('exhausts the actual send budget with a truthful group reason', async () => {
    const { ledger, record } = await fixture();
    const exhausted = { ...record, attempts: record.maxAttempts };
    const markFailedTerminal = vi.fn(async (input) => ledger.markFailedTerminal(input));
    const policy = new OpenCodePromptDeliveryFollowUpPolicy({
      markFailedTerminal,
      logEvent: vi.fn(),
      scheduleWatchdog: vi.fn(),
      nowIso: () => ISO,
      nowMs: () => Date.parse(ISO),
    });
    const settled = await policy.schedule({
      ledger,
      ledgerRecord: exhausted,
      teamName: record.teamName,
      memberName: 'alice',
      retry: true,
      reason: HUMAN_GROUP_REPLY_REQUIRED,
    });
    expect(settled).toMatchObject({
      status: 'failed_terminal',
      lastReason: HUMAN_GROUP_REPLY_REQUIRED,
      inboxReadCommittedAt: null,
    });
  });

  it('does not authorize peer, unknown, mismatched, incomplete, or terminal correction', async () => {
    const { record } = await fixture();
    for (const overrides of [
      { replyRecipient: 'peer' },
      { cancelledAt: ISO },
      { lastReason: 'force_stop_requested:TEST-team' },
      { acceptanceUnknown: true },
      { deliveredUserMessageId: 'other' },
      { responseState: 'pending' as const },
      { observedAssistantMessageId: null },
      { status: 'failed_terminal' as const },
      { groupRepairHandoffPending: true },
    ]) {
      const invalid = { ...record, ...overrides };
      expect(isOpenCodeHumanGroupNonResponse(invalid)).toBe(false);
      expect(
        isOpenCodeDeliveryRetryablePendingResponse({ ledgerRecord: invalid, readAllowed: false })
      ).toBe(false);
      expect(
        isOpenCodePromptDeliveryRetryAttemptDue({ ledgerRecord: invalid, attemptDue: true })
      ).toBe(false);
    }
  });
});
