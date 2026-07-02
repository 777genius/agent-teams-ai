import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeRuntimeDeliveryDiagnostics,
  shouldClearPendingReplyForOpenCodeRuntimeDelivery,
} from '../../../src/renderer/utils/openCodeRuntimeDeliveryDiagnostics';

describe('openCodeRuntimeDeliveryDiagnostics', () => {
  it('honors user-visible checking impact over raw terminal delivery facts', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-empty',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        accepted: true,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        ledgerStatus: 'failed_terminal',
        ledgerRecordId: 'opencode-prompt:msg-empty',
        laneId: 'secondary:opencode:bob',
        reason: 'empty_assistant_turn',
        diagnostics: ['empty_assistant_turn'],
        userVisibleImpact: {
          state: 'checking',
          reasonCode: 'backend_error',
          message: 'empty_assistant_turn',
          nextReviewAt: '2026-05-09T12:00:00.000Z',
        },
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      messageId: 'msg-empty',
      statusMessageId: 'msg-empty',
      accepted: true,
      ledgerRecordId: 'opencode-prompt:msg-empty',
      laneId: 'secondary:opencode:bob',
      userVisibleState: 'checking',
      userVisibleNextReviewAt: '2026-05-09T12:00:00.000Z',
    });
  });

  it('honors user-visible none impact over raw terminal delivery facts', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-proven',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        ledgerStatus: 'failed_terminal',
        reason: 'empty_assistant_turn',
        diagnostics: ['empty_assistant_turn'],
        userVisibleImpact: {
          state: 'none',
        },
      },
    });

    expect(diagnostics).toEqual({ warning: null, debugDetails: null });
  });

  it('clears pending reply when user-visible none impact overrides raw pending facts', () => {
    expect(
      shouldClearPendingReplyForOpenCodeRuntimeDelivery({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'responded',
        userVisibleImpact: {
          state: 'none',
        },
      })
    ).toBe(true);
  });

  it('surfaces terminal empty assistant turn in the compact failed warning', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-empty',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'empty_assistant_turn',
        ledgerStatus: 'failed_terminal',
        reason: 'empty_assistant_turn',
        diagnostics: ['empty_assistant_turn'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode returned an empty assistant turn.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      responseState: 'empty_assistant_turn',
      reason: 'empty_assistant_turn',
    });
  });

  it('surfaces prompt delivery with no recorded assistant turn separately', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-no-assistant',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'prompt_delivered_no_assistant_message',
        ledgerStatus: 'failed_terminal',
        reason: 'prompt_delivered_no_assistant_message',
        diagnostics: ['prompt_delivered_no_assistant_message'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode accepted the prompt, but no assistant turn was recorded.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      responseState: 'prompt_delivered_no_assistant_message',
      reason: 'prompt_delivered_no_assistant_message',
    });
  });

  it('surfaces unknown OpenCode bridge outcome as observe/retry state', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-bridge-unknown',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'failed_terminal',
        reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
        diagnostics: ['opencode_prompt_acceptance_unknown_after_bridge_timeout'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode bridge outcome unknown after timeout, retrying/observing.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
    });
  });

  it('surfaces missing visible reply proof as a readable failure', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-visible-required',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'failed_terminal',
        reason: 'visible_reply_still_required',
        diagnostics: ['visible_reply_still_required'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode responded, but did not create a visible message_send reply.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      responseState: 'responded_non_visible_tool',
      reason: 'visible_reply_still_required',
    });
  });

  it('surfaces missing task progress proof as a readable failure', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-progress-required',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'responded_non_visible_tool',
        ledgerStatus: 'failed_terminal',
        reason: 'non_visible_tool_without_task_progress',
        diagnostics: ['non_visible_tool_without_task_progress'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode used tools, but did not create a visible reply or task progress proof.'
    );
  });

  it('surfaces missing taskRefs proof as a readable failure', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-taskrefs-required',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'failed_terminal',
        reason: 'visible_reply_missing_task_refs',
        diagnostics: ['visible_reply_missing_task_refs'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete. Reason: OpenCode created a reply without the required taskRefs metadata.'
    );
  });

  it('surfaces unsupported OpenCode attachment models as an actionable failure', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-unsupported-attachment-model',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        reason: 'attachment_model_unsupported',
        diagnostics: [
          'opencode_attachment_delivery_prepare_failed: This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.',
        ],
        userVisibleImpact: {
          state: 'error',
          reasonCode: 'backend_error',
          message:
            'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.',
        },
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode attachment was not sent. Message was saved to inbox, but live delivery cannot include this attachment. Reason: This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
    );
    expect(diagnostics.debugDetails).toMatchObject({
      reason: 'attachment_model_unsupported',
      userVisibleMessage:
        'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.',
    });
  });

  it('maps legacy unsupported attachment model codes to an actionable failure', () => {
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: 'msg-legacy-unsupported-attachment-model',
      runtimeDelivery: {
        providerId: 'opencode',
        attempted: true,
        delivered: false,
        responsePending: false,
        reason: 'attachment_model_unsupported',
        diagnostics: ['attachment_model_unsupported'],
      },
    });

    expect(diagnostics.warning).toBe(
      'OpenCode attachment was not sent. Message was saved to inbox, but live delivery cannot include this attachment. Reason: This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
    );
  });
});
