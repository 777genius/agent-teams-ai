import { describe, expect, it, vi } from 'vitest';

import { isOpenCodeDeliveryResponseReadCommitAllowed } from '../OpenCodePromptDeliveryReadCommitPolicy';
import { OpenCodeVisibleReplyProofService } from '../OpenCodeVisibleReplyProofService';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';

function respondedRecord(): OpenCodePromptDeliveryLedgerRecord {
  const now = '2026-05-09T12:00:00.000Z';
  return {
    id: 'opencode-prompt:team-a:primary:alice:msg-1',
    teamName: 'team-a',
    memberName: 'alice',
    laneId: 'primary',
    runId: 'run-1',
    runtimeSessionId: null,
    runtimePromptMessageId: null,
    runtimePromptMessageIds: [],
    lastRuntimePromptMessageId: null,
    lastDeliveryAttemptIdWithAcceptedPrompt: null,
    inboxMessageId: 'msg-1',
    inboxTimestamp: now,
    source: 'ui-send',
    messageKind: null,
    workSyncIntent: null,
    replyRecipient: 'user',
    actionMode: null,
    taskRefs: [],
    payloadHash: 'sha256:test',
    status: 'responded',
    responseState: 'responded_plain_text',
    attempts: 0,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    maxSessionRefreshAttempts: 5,
    lastSessionRefreshReason: null,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastObservedAt: null,
    acceptedAt: null,
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: null,
    observedAssistantMessageId: null,
    observedAssistantPreview: 'The requested implementation is complete.',
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe('OpenCode delivery cancellation callback boundaries', () => {
  it.each(['materialize', 'destination'] as const)(
    'does not write or enrich after %s lookup is cancelled',
    async (operation) => {
      const record = respondedRecord();
      let current = record;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const sendMessage = vi.fn();
      const mergeRuntimeDeliveryTaskRefs = vi.fn();
      const correlateRuntimeDeliveryReply = vi.fn();
      const emitRuntimeDeliveryReplyAdvisoryRefresh = vi.fn();
      const service = new OpenCodeVisibleReplyProofService({
        inboxReader: { getMessagesFor: vi.fn(async () => []) },
        inboxWriter: { sendMessage, mergeRuntimeDeliveryTaskRefs, correlateRuntimeDeliveryReply },
        getConfiguredLeadName: vi.fn(async () => null),
        emitRuntimeDeliveryReplyAdvisoryRefresh,
        warn: vi.fn(),
        getErrorMessage: String,
      });
      vi.spyOn(service, 'findByRelayOfMessageId').mockImplementation(async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return operation === 'materialize'
          ? null
          : {
              inboxName: 'user',
              message: {
                messageId: 'reply-1',
                relayOfMessageId: 'message-1',
                from: 'alice',
                text: 'Implementation complete.',
                timestamp: '2026-05-09T12:00:00Z',
                read: false,
              },
            };
      });
      const applyDestinationProof = vi.fn(async () => current);
      const ledger = {
        getByInboxMessage: vi.fn(async () => current),
        applyDestinationProof,
      } as unknown as OpenCodePromptDeliveryLedgerStore;
      const input = { ledger, ledgerRecord: record, teamName: 'test-team', memberName: 'alice' };
      const work =
        operation === 'materialize'
          ? service.materializePlainTextReplyIfNeeded(input)
          : service.applyDestinationProof(input);
      await started;
      current = { ...record, status: 'failed_terminal', cancelledAt: '2026-05-09T12:01:00Z' };
      release();
      await expect(work).resolves.toEqual({ ledgerRecord: current, visibleReply: null });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(mergeRuntimeDeliveryTaskRefs).not.toHaveBeenCalled();
      expect(correlateRuntimeDeliveryReply).not.toHaveBeenCalled();
      expect(emitRuntimeDeliveryReplyAdvisoryRefresh).not.toHaveBeenCalled();
    }
  );

  it('rejects read commit for cancelled records retaining a successful response', async () => {
    await expect(
      isOpenCodeDeliveryResponseReadCommitAllowed({
        ledgerRecord: {
          ...respondedRecord(),
          cancelledAt: '2026-05-09T12:01:00Z',
          visibleReplyMessageId: 'reply-1',
          visibleReplyInbox: 'user',
        },
        responseState: 'responded_plain_text',
        hasAcceptedMemberWorkSyncReport: vi.fn(async () => true),
        taskRefsIncludeAll: () => true,
      })
    ).resolves.toBe(false);
  });
});
