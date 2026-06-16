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

  it('treats OpenCode permission-blocked responses as action-required delivery failures', () => {
    expect(isActionRequiredOpenCodeRuntimeDeliveryReason('permission_blocked')).toBe(true);
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

  it('treats generic OpenCode API error plus clean refresh evidence as session refresh', () => {
    const record = {
      diagnostics: ['OpenCode API error', 'resolved_behavior_changed:old->new'],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('treats legacy prompt-delivery refresh scheduled diagnostics as session refresh', () => {
    const record = {
      diagnostics: ['opencode_prompt_delivery_session_refresh_scheduled'],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('treats generic-prefixed legacy prompt-delivery refresh scheduled diagnostics as session refresh', () => {
    const record = {
      diagnostics: [
        'OpenCode API error',
        'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled',
      ],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('treats generic-prefixed resolved-behavior refresh scheduled diagnostics as session refresh', () => {
    const record = {
      diagnostics: [
        'OpenCode API error',
        'OpenCode API error. opencode_session_refresh_scheduled_after_resolved_behavior_changed',
      ],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('treats stale observe scheduled diagnostics after an accepted prompt as session refresh', () => {
    const record = {
      diagnostics: [
        'OpenCode API error',
        'OpenCode API error. opencode_session_stale_observe_scheduled_after_accepted_prompt',
      ],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
    expect(
      isActionRequiredOpenCodeRuntimeDeliveryReason(selectOpenCodeRuntimeDeliveryReason(record))
    ).toBe(false);
  });

  it('treats colon-terminated generic OpenCode API errors plus clean refresh evidence as session refresh', () => {
    const record = {
      diagnostics: ['OpenCode API error:', 'resolved_behavior_changed:old->new'],
      lastReason: 'OpenCode API error:',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not treat generic-prefixed refresh scheduled diagnostics with failure details as session refresh', () => {
    const reason =
      'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled permission denied';
    const record = {
      diagnostics: ['OpenCode API error', reason],
      lastReason: 'OpenCode API error',
      responseState: 'reconcile_failed',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(reason);
  });

  it('keeps real failure diagnostics above generic OpenCode API error plus refresh evidence', () => {
    const record = {
      diagnostics: ['OpenCode API error', 'resolved_behavior_changed:old->new', 'permission denied'],
      lastReason: 'OpenCode API error',
      responseState: 'not_observed',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe('permission denied');
  });

  it('does not treat refresh-looking diagnostics with failure details as informational refresh state', () => {
    const record = {
      diagnostics: ['resolved_behavior_changed:old->new;permission_denied'],
      lastReason: 'resolved_behavior_changed:old->new;permission_denied',
      responseState: 'reconcile_failed',
      status: 'failed_terminal',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).not.toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not treat refresh-looking diagnostics with unknown extra text as informational refresh state', () => {
    const record = {
      diagnostics: ['resolved_behavior_changed:old->new unexpected detail'],
      lastReason: 'resolved_behavior_changed:old->new unexpected detail',
      responseState: 'reconcile_failed',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'resolved_behavior_changed:old->new unexpected detail'
    );
  });

  it('does not treat stale refresh-looking diagnostics with unknown extra text as informational refresh state', () => {
    const reason =
      'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail';
    const record = {
      diagnostics: [reason],
      lastReason: reason,
      responseState: 'reconcile_failed',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(reason);
  });

  it.each(['permission_denied', 'error', 'failed', 'failure', 'aborted', 'enospc'])(
    'does not let refresh pattern consume directly attached failure token _%s',
    (suffix) => {
      const reason = `resolved_behavior_changed:old->new_${suffix}`;
      const record = {
        diagnostics: [reason],
        lastReason: reason,
        responseState: 'reconcile_failed',
        status: 'failed_retryable',
      } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

      const selected = selectOpenCodeRuntimeDeliveryReason(record);

      expect(selected).not.toBe(
        'OpenCode session changed; refreshing the session before retry.'
      );
      expect(selected).toBeTruthy();
    }
  );

  it.each([
    'resolved_behavior_changed:old->new/auth_unavailable',
    'resolved_behavior_changed:old->new permission denied',
    'resolved_behavior_changed:old->new permission_blocked',
    'resolved_behavior_changed:old->new;key limit exceeded',
    'resolved_behavior_changed:old->new-network_timeout',
    'resolved_behavior_changed:old->new(non_visible_tool_without_task_progress)',
    'opencode_app_mcp_transport_changed:old->new/permission_denied',
    'opencode_app_mcp_transport_changed:old->new;visible_reply_missing_task_refs',
  ])('keeps separator-attached failure detail visible for %s', (reason) => {
    const record = {
      diagnostics: [reason],
      lastReason: reason,
      responseState: 'reconcile_failed',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    const selected = selectOpenCodeRuntimeDeliveryReason(record);

    expect(selected).not.toBe('OpenCode session changed; refreshing the session before retry.');
    expect(selected).toBeTruthy();
  });

  it('keeps clean refresh diagnostics recoverable after direct suffix checks', () => {
    const record = {
      diagnostics: ['resolved_behavior_changed:old->new'],
      lastReason: 'resolved_behavior_changed:old->new',
      responseState: 'session_stale',
      status: 'retry_scheduled',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('surfaces network details when they are mixed with OpenCode refresh markers', () => {
    const record = {
      diagnostics: ['resolved_behavior_changed:old->new network timeout'],
      lastReason: 'resolved_behavior_changed:old->new network timeout',
      responseState: 'reconcile_failed',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toContain('network timeout');
    expect(selectOpenCodeRuntimeDeliveryReason(record)).not.toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('prioritizes real failure details over session_stale fallback copy', () => {
    const record = {
      diagnostics: ['permission denied'],
      lastReason: 'permission denied',
      responseState: 'session_stale',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe('permission denied');
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

  it('keeps protocol proof failures above session_stale fallback for stale log projections', () => {
    const record = {
      diagnostics: [
        'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_task_refs',
      ],
      lastReason: 'resolved_behavior_changed:old->new visible_reply_missing_task_refs',
      responseState: 'session_stale',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(
      'OpenCode created a reply without the required taskRefs metadata.'
    );
  });

  it.each([
    {
      diagnostic:
        'OpenCode session is stale (resolved_behavior_changed:old->new); visible_reply_missing_relayofmessageid',
      reason: 'resolved_behavior_changed:old->new visible_reply_missing_relayofmessageid',
      expected:
        'OpenCode created a reply without the required relayOfMessageId correlation.',
    },
    {
      diagnostic:
        'OpenCode session is stale (resolved_behavior_changed:old->new); non_visible_tool_without_task_progress',
      reason: 'resolved_behavior_changed:old->new non_visible_tool_without_task_progress',
      expected:
        'OpenCode used tools, but did not create a visible reply or task progress proof.',
    },
  ])('keeps $reason above session_stale fallback', ({ diagnostic, reason, expected }) => {
    const record = {
      diagnostics: [diagnostic],
      lastReason: reason,
      responseState: 'session_stale',
      status: 'failed_retryable',
    } as Parameters<typeof selectOpenCodeRuntimeDeliveryReason>[0];

    expect(selectOpenCodeRuntimeDeliveryReason(record)).toBe(expected);
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
