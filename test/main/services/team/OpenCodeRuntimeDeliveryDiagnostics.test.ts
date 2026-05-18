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

  it('selects OpenCode free usage exhaustion before empty assistant fallback text', () => {
    const record = {
      diagnostics: [
        'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.267Z',
        'empty_assistant_turn',
      ],
      lastReason: 'empty_assistant_turn',
      responseState: 'empty_assistant_turn',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toContain('Free usage exceeded');
    expect(
      isActionRequiredOpenCodeRuntimeDeliveryReason(selectOpenCodeRuntimeDeliveryReason(record))
    ).toBe(true);
  });

  it('ignores positive OpenCode delivery breadcrumbs before fallback text', () => {
    const record = {
      diagnostics: [
        'OpenCode app MCP is connected for message delivery.',
        'OpenCode prompt_async accepted; response observation will continue through durable app-side ledger reconciliation.',
        'prompt_delivered_no_assistant_message',
      ],
      lastReason: 'prompt_delivered_no_assistant_message',
      responseState: 'prompt_delivered_no_assistant_message',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode accepted the prompt, but no assistant turn was recorded.'
    );
  });

  it('formats resolved behavior changes as recoverable session refresh state', () => {
    const record = {
      diagnostics: [
        'OpenCode session reconcile skipped because the stored session is stale',
        'resolved_behavior_changed:old->new',
      ],
      lastReason: 'resolved_behavior_changed:old->new',
      responseState: 'session_stale',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
    expect(
      isActionRequiredOpenCodeRuntimeDeliveryReason(selectOpenCodeRuntimeDeliveryReason(record))
    ).toBe(false);
  });

  it('formats app MCP transport changes as recoverable session refresh state', () => {
    const record = {
      diagnostics: ['opencode_app_mcp_transport_changed:old->new'],
      lastReason: 'opencode_app_mcp_transport_changed:old->new',
      responseState: 'session_stale',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
    expect(
      isActionRequiredOpenCodeRuntimeDeliveryReason(selectOpenCodeRuntimeDeliveryReason(record))
    ).toBe(false);
  });

  it('prioritizes local disk-full diagnostics over secondary aborted assistant errors', () => {
    const record = {
      diagnostics: [
        "OpenCode message bridge failed: ENOSPC: no space left on device, open '/tmp/.auth.json.tmp'",
        "ENOSPC: no space left on device, open '/tmp/.auth.json.tmp'",
        'OpenCode app MCP was reattached before message delivery.',
        'Latest assistant message msg_1 failed with MessageAbortedError - Aborted',
        'empty_assistant_turn',
      ],
      lastReason: 'empty_assistant_turn',
      responseState: 'empty_assistant_turn',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'Local disk is full (ENOSPC). Free disk space and retry OpenCode delivery.'
    );
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
