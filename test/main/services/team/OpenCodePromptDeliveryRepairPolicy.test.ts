import {
  decideOpenCodePromptDeliveryRepair,
  type OpenCodePromptDeliveryRepairInput,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy';
import { describe, expect, it } from 'vitest';

function base(overrides: Partial<OpenCodePromptDeliveryRepairInput> = {}) {
  return {
    teamName: 'team-a',
    memberName: 'alice',
    inboxMessageId: 'msg-1',
    replyRecipient: 'user',
    messageKind: 'default',
    actionMode: 'ask',
    taskRefs: [],
    status: 'responded',
    responseState: 'empty_assistant_turn',
    attempts: 1,
    maxAttempts: 3,
    pendingReason: 'empty_assistant_turn',
    readAllowed: false,
    inboxReadCommitted: false,
    visibleReplyFound: false,
    hasKnownProgressProof: false,
    toolCallNames: [],
    acceptanceUnknown: false,
    hardFailureKind: 'none',
    ...overrides,
  } satisfies OpenCodePromptDeliveryRepairInput;
}

describe('OpenCodePromptDeliveryRepairPolicy', () => {
  it('adds no-assistant response repair without treating it as success', () => {
    const decision = decideOpenCodePromptDeliveryRepair(base());

    expect(decision.kind).toBe('no_assistant_response');
    expect(decision.retryable).toBe(true);
    expect(decision.controlText).toContain('You must not end this turn empty.');
    expect(decision.controlText).toContain('relayOfMessageId="msg-1"');
  });

  it('keeps no-assistant response repair available for a bounded max-attempt recovery retry', () => {
    const decision = decideOpenCodePromptDeliveryRepair(
      base({
        status: 'retry_scheduled',
        attempts: 3,
        maxAttempts: 3,
        responseState: 'prompt_delivered_no_assistant_message',
        pendingReason: 'prompt_delivered_no_assistant_message',
      })
    );

    expect(decision.kind).toBe('no_assistant_response');
    expect(decision.retryable).toBe(true);
    expect(decision.controlText).toContain('You must not end this turn empty.');
  });

  it('requires member work sync status and report for work-sync nudges', () => {
    const decision = decideOpenCodePromptDeliveryRepair(
      base({
        messageKind: 'member_work_sync_nudge',
        actionMode: 'do',
        taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'team-a' }],
        responseState: 'responded_plain_text',
        pendingReason: 'plain_text_ack_only_still_requires_answer',
        controlUrl: 'http://127.0.0.1:43123',
      })
    );

    expect(decision.kind).toBe('work_sync_report_required');
    expect(decision.controlText).toContain('member_work_sync_status');
    expect(decision.controlText).toContain('member_work_sync_report');
    expect(decision.controlText).toContain('A status-only tool call is incomplete');
    expect(decision.controlText).toContain('controlUrl="http://127.0.0.1:43123"');
    expect(decision.controlText).toContain('"task-1"');
    expect(decision.controlText).not.toContain('reportToken=');
  });

  it('uses review pickup repair wording for review pickup work-sync nudges', () => {
    const decision = decideOpenCodePromptDeliveryRepair(
      base({
        messageKind: 'member_work_sync_nudge',
        workSyncIntent: 'review_pickup',
        actionMode: 'do',
        taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'team-a' }],
        responseState: 'responded_plain_text',
        pendingReason: 'plain_text_ack_only_still_requires_answer',
      })
    );

    expect(decision.kind).toBe('work_sync_report_required');
    expect(decision.controlText).toContain('review pickup control message');
    expect(decision.controlText).toContain('start or continue the review');
    expect(decision.controlText).toContain('A status-only tool call is incomplete');
    expect(decision.controlText).toContain('"task-1"');
    expect(decision.controlText).not.toContain('Then call agent-teams_member_work_sync_report');
  });

  it('repairs visible replies that missed required taskRefs with exact metadata', () => {
    const taskRef = { taskId: 'task-refs-1', displayId: 'refs-1', teamName: 'team-a' };
    const decision = decideOpenCodePromptDeliveryRepair(
      base({
        taskRefs: [taskRef],
        responseState: 'responded_visible_message',
        pendingReason: 'visible_reply_missing_task_refs',
        visibleReplyFound: true,
      })
    );

    expect(decision.kind).toBe('missing_visible_reply_correlation');
    expect(decision.retryable).toBe(true);
    expect(decision.controlText).toContain('relayOfMessageId="msg-1"');
    expect(decision.controlText).toContain(
      `Include taskRefs exactly as this JSON array: ${JSON.stringify([taskRef])}.`
    );
  });

  it('does not repair terminal, permission, or session failures', () => {
    expect(
      decideOpenCodePromptDeliveryRepair(
        base({ status: 'failed_terminal', responseState: 'empty_assistant_turn' })
      )
    ).toMatchObject({ kind: 'none', retryable: false });

    expect(
      decideOpenCodePromptDeliveryRepair(
        base({ responseState: 'permission_blocked', hardFailureKind: 'permission' })
      )
    ).toMatchObject({ kind: 'none', retryable: false });

    expect(
      decideOpenCodePromptDeliveryRepair(
        base({ responseState: 'session_error', hardFailureKind: 'session' })
      )
    ).toMatchObject({ kind: 'none', retryable: false });
  });

  it('does not ask to repeat side-effect tools after tool_error', () => {
    const decision = decideOpenCodePromptDeliveryRepair(
      base({
        responseState: 'tool_error',
        pendingReason: 'tool_error_without_required_delivery_proof',
        toolCallNames: ['bash'],
        actionMode: 'do',
        taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'team-a' }],
      })
    );

    expect(decision.kind).toBe('progress_proof_required');
    expect(decision.controlText).toContain('Do not repeat side-effectful commands');
    expect(decision.controlText).toContain('"task-2"');
  });
});
