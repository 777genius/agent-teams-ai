import { describe, expect, it } from 'vitest';

import {
  isActionRequiredOpenCodeRuntimeDeliveryReason,
  selectOpenCodeRuntimeDeliveryReason,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics';

describe('OpenCodeRuntimeDeliveryDiagnostics', () => {
  it('treats OpenRouter key limit errors as action-required delivery failures', () => {
    const reason =
      'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys';

    expect(isActionRequiredOpenCodeRuntimeDeliveryReason(reason)).toBe(true);
  });

  it('does not treat protocol proof repair reasons as action-required provider failures', () => {
    expect(isActionRequiredOpenCodeRuntimeDeliveryReason('visible_reply_still_required')).toBe(
      false
    );
  });

  it('selects a concrete OpenCode runtime delivery diagnostic before generic fallback text', () => {
    const record = {
      diagnostics: [
        'Latest assistant message for opencode session abc failed with APIError - Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys',
      ],
      lastReason: 'OpenCode runtime delivery failed',
      responseState: 'session_error',
      status: 'accepted',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toContain('Key limit exceeded');
  });

  it('formats non-visible tool progress failures without exposing the internal reason code', () => {
    const record = {
      diagnostics: ['non_visible_tool_without_task_progress'],
      lastReason: 'non_visible_tool_without_task_progress',
      responseState: 'responded_non_visible_tool',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode used tools, but did not create a visible reply or task progress proof.'
    );
  });

  it('formats visible replies missing taskRefs without exposing the internal reason code', () => {
    const record = {
      diagnostics: ['visible_reply_missing_task_refs'],
      lastReason: 'visible_reply_missing_task_refs',
      responseState: 'responded_visible_message',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode created a reply without the required taskRefs metadata.'
    );
  });

  it('formats taskRefs merge verification failures without exposing internal diagnostics', () => {
    const record = {
      diagnostics: ['visible_reply_missing_task_refs_after_merge'],
      lastReason: 'visible_reply_ack_only_still_requires_answer',
      responseState: 'responded_visible_message',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode created a reply without the required taskRefs metadata.'
    );
  });
});
