import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeAcceptedDeliveryMissingPromptProofRetry,
  buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan,
  buildOpenCodePromptLedgerFailedTerminalPlan,
  buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan,
  getOpenCodeDeliveryPendingReason,
  isLegacyOpenCodeMemberWorkSyncReadCommitAllowed,
  isOpenCodeAcceptedDeliveryMissingPromptProof,
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDeliveryRetryablePendingResponse,
} from '../OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from '../OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from '../OpenCodePromptDeliveryWatchdog';
import type { TaskRef } from '@shared/types/team';

const ISO = '2026-01-01T00:00:00.000Z';
const TASK_REF: TaskRef = { taskId: 'task-1', displayId: 'T-1', teamName: 'team' };

function record(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'team',
    memberName: 'alice',
    laneId: 'lane-1',
    runId: 'run-1',
    runtimeSessionId: 'session-1',
    runtimePromptMessageId: null,
    runtimePromptMessageIds: [],
    lastRuntimePromptMessageId: null,
    lastDeliveryAttemptIdWithAcceptedPrompt: null,
    inboxMessageId: 'msg-1',
    inboxTimestamp: ISO,
    source: 'watcher',
    messageKind: null,
    workSyncIntent: null,
    replyRecipient: 'user',
    actionMode: 'ask',
    taskRefs: [],
    payloadHash: 'hash',
    status: 'accepted',
    responseState: 'pending',
    attempts: 1,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    maxSessionRefreshAttempts: 5,
    lastSessionRefreshReason: null,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastObservedAt: null,
    acceptedAt: ISO,
    respondedAt: null,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: null,
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    lastReason: null,
    diagnostics: [],
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function visibleReply(taskRefs: TaskRef[] = []): OpenCodeVisibleReplyProof {
  return {
    inboxName: 'user',
    message: {
      from: 'alice',
      to: 'user',
      text: 'The change is complete.',
      timestamp: ISO,
      read: false,
      messageId: 'reply-1',
      taskRefs,
    },
  };
}

function taskRefsIncludeAll(
  actual: readonly TaskRef[] | undefined,
  expected: readonly TaskRef[] | undefined
): boolean {
  return (expected ?? []).every((expectedRef) =>
    (actual ?? []).some(
      (actualRef) =>
        actualRef.taskId === expectedRef.taskId &&
        actualRef.displayId === expectedRef.displayId &&
        actualRef.teamName === expectedRef.teamName
    )
  );
}

describe('OpenCode prompt delivery read commit policy', () => {
  it('keeps visible-message responses pending until the destination reply is found', () => {
    expect(
      getOpenCodeDeliveryPendingReason({
        responseState: 'responded_visible_message',
        taskRefsIncludeAll,
      })
    ).toBe('visible_reply_destination_not_found_yet');
  });

  it('reports visible replies that do not include all required task refs', () => {
    expect(
      getOpenCodeDeliveryPendingReason({
        responseState: 'responded_visible_message',
        visibleReply: visibleReply([]),
        taskRefs: [TASK_REF],
        taskRefsIncludeAll,
      })
    ).toBe('visible_reply_missing_task_refs');
  });

  it('requires work-sync nudges to produce accepted work-sync proof', () => {
    expect(
      getOpenCodeDeliveryPendingReason({
        ledgerRecord: record({
          messageKind: 'member_work_sync_nudge',
          responseState: 'responded_plain_text',
          observedAssistantPreview: 'done',
        }),
        taskRefsIncludeAll,
      })
    ).toBe('member_work_sync_report_required');
  });

  it('allows review pickup workflow proof without a member work-sync report acceptance lookup', async () => {
    const hasAcceptedMemberWorkSyncReport = vi.fn(async () => false);

    await expect(
      isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'team',
        memberName: 'alice',
        responseState: 'responded_tool_call',
        ledgerRecord: record({
          messageKind: 'member_work_sync_nudge',
          workSyncIntent: 'review_pickup',
          responseState: 'responded_tool_call',
          observedToolCallNames: ['mcp__agent-teams__review_start'],
        }),
        hasAcceptedMemberWorkSyncReport,
        taskRefsIncludeAll,
      })
    ).resolves.toBe(true);
    expect(hasAcceptedMemberWorkSyncReport).not.toHaveBeenCalled();
  });

  it('requires persisted acceptance for legacy work-sync report tool proof', async () => {
    const hasAcceptedMemberWorkSyncReport = vi.fn(async () => true);

    await expect(
      isLegacyOpenCodeMemberWorkSyncReadCommitAllowed({
        teamName: 'team',
        memberName: 'alice',
        workSyncIntent: 'agenda_sync',
        responseObservation: {
          state: 'responded_tool_call',
          deliveredUserMessageId: 'runtime-prompt-1',
          assistantMessageId: 'assistant-1',
          toolCallNames: ['agent_teams_member_work_sync_report'],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: null,
        },
        hasAcceptedMemberWorkSyncReport,
      })
    ).resolves.toBe(true);
    expect(hasAcceptedMemberWorkSyncReport).toHaveBeenCalledWith({
      teamName: 'team',
      memberName: 'alice',
    });
  });
});

describe('OpenCode prompt delivery retry and requeue policy', () => {
  it('identifies accepted deliveries that need legacy missing-prompt-proof recovery', () => {
    const ledgerRecord = record({
      status: 'accepted',
      responseState: 'pending',
      acceptedAt: null,
      runtimePromptMessageId: null,
      runtimePromptMessageIds: [],
      deliveredUserMessageId: null,
    });

    expect(isOpenCodeAcceptedDeliveryMissingPromptProof(ledgerRecord)).toBe(true);
    expect(
      buildOpenCodeAcceptedDeliveryMissingPromptProofRetry({
        ledgerRecord,
        now: ISO,
        eventContext: { source: 'watchdog' },
      })
    ).toEqual({
      markInput: {
        id: 'record-1',
        reason: 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id',
        nextAttemptAt: ISO,
        diagnostics: ['opencode_accepted_prompt_missing_runtime_prompt_id_recovered'],
        markedAt: ISO,
      },
      eventExtra: {
        acceptanceUnknown: true,
        recoveredLegacyAcceptedWithoutPromptProof: true,
        source: 'watchdog',
        reason: 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id',
      },
    });
  });

  it('does not recover accepted deliveries that already have runtime prompt proof', () => {
    expect(
      isOpenCodeAcceptedDeliveryMissingPromptProof(
        record({
          status: 'accepted',
          responseState: 'pending',
          runtimePromptMessageId: 'runtime-message-1',
        })
      )
    ).toBe(false);
  });

  it('retries pending responses that still lack required read-commit proof', () => {
    expect(
      isOpenCodeDeliveryRetryablePendingResponse({
        ledgerRecord: record({
          messageKind: 'member_work_sync_nudge',
          responseState: 'responded_plain_text',
        }),
        readAllowed: false,
      })
    ).toBe(true);
    expect(
      isOpenCodeDeliveryRetryablePendingResponse({
        ledgerRecord: record({ responseState: 'prompt_delivered_no_assistant_message' }),
        readAllowed: true,
      })
    ).toBe(false);
  });

  it('builds a requeue plan for terminal no-assistant delivery failures', () => {
    expect(
      buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan({
        ledgerRecord: record({
          status: 'failed_terminal',
          responseState: 'prompt_delivered_no_assistant_message',
          attempts: 3,
          maxAttempts: 3,
        }),
        scheduledAt: ISO,
      })
    ).toEqual({
      markInput: {
        id: 'record-1',
        status: 'retry_scheduled',
        nextAttemptAt: ISO,
        reason: 'opencode_prompt_delivery_requeued_after_terminal_no_assistant_response',
        scheduledAt: ISO,
      },
      logEvent: 'opencode_prompt_delivery_requeued_after_terminal_no_assistant_response',
      logContext: {
        teamName: 'team',
        memberName: 'alice',
        laneId: 'lane-1',
        runId: 'run-1',
        inboxMessageId: 'msg-1',
        attempts: 3,
        maxAttempts: 3,
      },
    });
  });

  it('does not requeue terminal no-assistant failures caused by quota/auth/filesystem failures', () => {
    expect(
      buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan({
        ledgerRecord: record({
          status: 'failed_terminal',
          responseState: 'prompt_delivered_no_assistant_message',
          diagnostics: ['quota exceeded while sending prompt'],
        }),
        scheduledAt: ISO,
      })
    ).toBeNull();
  });

  it('builds a requeue plan for runtime manifest high-watermark terminal failures only while unread', () => {
    const ledgerRecord = record({
      status: 'failed_terminal',
      responseState: 'tool_error',
      lastReason: 'Bridge server runtime manifest high watermark is stale',
    });

    expect(
      buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan({
        ledgerRecord,
        scheduledAt: ISO,
      })?.markInput
    ).toEqual({
      id: 'record-1',
      status: 'retry_scheduled',
      nextAttemptAt: ISO,
      reason: 'opencode_prompt_delivery_requeued_after_runtime_manifest_high_watermark_fix',
      scheduledAt: ISO,
    });
    expect(
      buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan({
        ledgerRecord: { ...ledgerRecord, inboxReadCommittedAt: ISO },
        scheduledAt: ISO,
      })
    ).toBeNull();
  });

  it('builds failed-terminal ledger mark input and preserves event-context precedence', () => {
    expect(
      buildOpenCodePromptLedgerFailedTerminalPlan({
        id: 'record-1',
        reason: 'original_reason',
        diagnostics: [],
        failedAt: ISO,
        eventContext: { reason: 'event_reason', source: 'watchdog' },
      })
    ).toEqual({
      markInput: {
        id: 'record-1',
        reason: 'original_reason',
        diagnostics: [],
        failedAt: ISO,
      },
      eventExtra: {
        reason: 'event_reason',
        source: 'watchdog',
      },
    });
  });
});
