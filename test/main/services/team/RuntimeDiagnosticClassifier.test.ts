import { describe, expect, it } from 'vitest';

import {
  classifyRuntimeDiagnostic,
  selectRuntimeDiagnosticClassification,
} from '../../../../src/main/services/team/runtime/RuntimeDiagnosticClassifier';

describe('RuntimeDiagnosticClassifier', () => {
  it('selects disk-full errors over aborted and empty OpenCode noise', () => {
    const selected = selectRuntimeDiagnosticClassification([
      'Latest assistant message msg_1 failed with MessageAbortedError - Aborted',
      'empty_assistant_turn',
      "OpenCode message bridge failed: ENOSPC: no space left on device, open '/tmp/.auth.json.tmp'",
    ]);

    expect(selected).toMatchObject({
      reasonCode: 'filesystem_error',
      normalizedMessage: 'Local disk is full (ENOSPC). Free disk space and retry OpenCode delivery.',
      actionRequired: true,
      generic: false,
    });
  });

  it('selects quota errors over empty assistant turns', () => {
    const selected = selectRuntimeDiagnosticClassification([
      'empty_assistant_turn',
      'Latest assistant message msg_2 failed with APIError - Insufficient credits. Add more using https://openrouter.ai/settings/credits',
    ]);

    expect(selected).toMatchObject({
      reasonCode: 'quota_exhausted',
      normalizedMessage:
        'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
      actionRequired: true,
    });
  });

  it('classifies OpenCode free usage retry status as quota exhausted', () => {
    const selected = selectRuntimeDiagnosticClassification([
      'empty_assistant_turn',
      'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.267Z',
    ]);

    expect(selected).toMatchObject({
      reasonCode: 'quota_exhausted',
      normalizedMessage:
        'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.267Z',
      actionRequired: true,
    });
  });

  it('selects auth errors over bridge timeouts', () => {
    const selected = selectRuntimeDiagnosticClassification([
      'OpenCode bridge command timed out',
      'authentication_failed: invalid API key',
    ]);

    expect(selected).toMatchObject({
      reasonCode: 'auth_error',
      normalizedMessage: 'authentication_failed: invalid API key',
      actionRequired: true,
    });
  });

  it('classifies OpenCode bridge outcome timeouts as backend delivery state', () => {
    expect(
      classifyRuntimeDiagnostic('opencode_prompt_acceptance_unknown_after_bridge_timeout')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode bridge outcome unknown after timeout, retrying/observing.',
      generic: true,
      actionRequired: false,
    });
  });

  it('keeps pure empty assistant turns as generic backend fallback', () => {
    expect(classifyRuntimeDiagnostic('empty_assistant_turn')).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'empty_assistant_turn',
      generic: true,
      actionRequired: false,
    });
  });

  it('keeps protocol proof failures above generic runtime noise', () => {
    const selected = selectRuntimeDiagnosticClassification([
      'OpenCode bridge command timed out',
      'visible_reply_missing_task_refs',
    ]);

    expect(selected).toMatchObject({
      reasonCode: 'protocol_proof_missing',
      normalizedMessage: 'visible_reply_missing_task_refs',
      generic: true,
      actionRequired: false,
    });
  });

  it('does not classify message_send Not connected as protocol proof missing', () => {
    expect(
      classifyRuntimeDiagnostic(
        'agent-teams_message_send returned Not connected while sending a visible reply'
      )
    ).toMatchObject({
      reasonCode: 'backend_error',
      actionRequired: false,
    });
  });

  it('keeps explicit proof-missing diagnostics narrow', () => {
    expect(
      classifyRuntimeDiagnostic(
        'OpenCode used tools, but did not create a visible reply or task progress proof.'
      )
    ).toMatchObject({
      reasonCode: 'protocol_proof_missing',
      generic: true,
    });
  });

  it('keeps quota and auth diagnostics above proof-missing substrings in the same message', () => {
    expect(
      classifyRuntimeDiagnostic(
        'Insufficient credits: OpenCode used tools, but did not create a visible reply or task progress proof.'
      )
    ).toMatchObject({
      reasonCode: 'quota_exhausted',
      actionRequired: true,
    });

    expect(
      classifyRuntimeDiagnostic(
        'authentication_failed: visible_reply_missing_task_refs because API key is invalid'
      )
    ).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
  });

  it('keeps OpenCode bridge command timeout as backend state despite timeout tokens', () => {
    expect(classifyRuntimeDiagnostic('OpenCode bridge command timed out')).toMatchObject({
      reasonCode: 'backend_error',
      generic: true,
    });
  });

  it('classifies resolved OpenCode behavior changes as recoverable generic refresh state', () => {
    expect(classifyRuntimeDiagnostic('resolved_behavior_changed:old->new')).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic('opencode_app_mcp_transport_changed:old->new')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(classifyRuntimeDiagnostic('(resolved_behavior_changed:old->new)')).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:tool_error->session_error')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:responded_non_visible_tool->pending')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:permission_blocked->pending')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic(
        'resolved_behavior_changed:old->new opencode_app_mcp_transport_changed:a->b'
      )
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic('OpenCode session changed; refreshing the session before retry.')
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic(
        'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled'
      )
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic(
        'OpenCode API error. opencode_prompt_delivery_session_refresh_scheduled.'
      )
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
    expect(
      classifyRuntimeDiagnostic(
        'OpenCode API error. opencode_session_stale_observe_scheduled_after_accepted_prompt'
      )
    ).toMatchObject({
      reasonCode: 'backend_error',
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
      actionRequired: false,
    });
  });

  it('does not classify refresh markers with unknown extra text as clean refresh', () => {
    const result = classifyRuntimeDiagnostic(
      'resolved_behavior_changed:old->new unexpected detail'
    );

    expect(result.normalizedMessage).toBe(
      'resolved_behavior_changed:old->new unexpected detail'
    );
    expect(result.generic).toBe(false);
  });

  it('requires a separator after generic OpenCode API error before refresh markers', () => {
    const result = classifyRuntimeDiagnostic(
      'OpenCode API errorresolved_behavior_changed:old->new'
    );

    expect(result.normalizedMessage).toBe(
      'OpenCode API errorresolved_behavior_changed:old->new'
    );
    expect(result.generic).toBe(false);
  });

  it('only allows known stale log-projection text after refresh markers', () => {
    expect(
      classifyRuntimeDiagnostic(
        'OpenCode session is stale (resolved_behavior_changed:old->new); reading historical messages for log projection only'
      )
    ).toMatchObject({
      normalizedMessage: 'OpenCode session changed; refreshing the session before retry.',
      generic: true,
    });

    const unknown = classifyRuntimeDiagnostic(
      'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail'
    );
    expect(unknown.normalizedMessage).toBe(
      'OpenCode session is stale (resolved_behavior_changed:old->new); unexpected detail'
    );
    expect(unknown.generic).toBe(false);
  });

  it('does not let OpenCode refresh markers hide network failure details', () => {
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:old->new network timeout')
    ).toMatchObject({
      reasonCode: 'network_error',
      generic: false,
    });
    expect(
      classifyRuntimeDiagnostic('opencode_app_mcp_transport_changed:old->new service unavailable')
    ).toMatchObject({
      reasonCode: 'provider_overloaded',
      generic: false,
    });
  });

  it('does not let OpenCode refresh markers hide permission failures', () => {
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:old->new;permission_denied')
    ).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(
      classifyRuntimeDiagnostic('opencode_app_mcp_transport_changed:old->new permission denied')
    ).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(classifyRuntimeDiagnostic('permission_blocked')).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:old->new permission_blocked')
    ).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
  });

  it.each(['error', 'failed', 'failure', 'aborted', 'canceled', 'cancelled', 'interrupted', 'enospc'])(
    'does not classify directly attached OpenCode refresh suffix _%s as clean refresh',
    (suffix) => {
      const result = classifyRuntimeDiagnostic(`resolved_behavior_changed:old->new_${suffix}`);

      expect(result.normalizedMessage).not.toBe(
        'OpenCode session changed; refreshing the session before retry.'
      );
    }
  );

  it.each([
    ['resolved_behavior_changed:old->new/auth_unavailable', 'auth_error'],
    ['resolved_behavior_changed:old->new permission denied', 'auth_error'],
    ['resolved_behavior_changed:old->new permission_blocked', 'auth_error'],
    ['resolved_behavior_changed:old->new login required', 'auth_error'],
    ['resolved_behavior_changed:old->new not logged in', 'auth_error'],
    ['resolved_behavior_changed:old->new missing credentials', 'auth_error'],
    ['resolved_behavior_changed:old->new access denied', 'auth_error'],
    ['resolved_behavior_changed:old->new 401', 'auth_error'],
    ['resolved_behavior_changed:old->new 403', 'auth_error'],
    ['resolved_behavior_changed:old->new;key limit exceeded', 'quota_exhausted'],
    ['resolved_behavior_changed:old->new-network_timeout', 'network_error'],
    ['resolved_behavior_changed:old->new interrupted', 'backend_error'],
    [
      'resolved_behavior_changed:old->new(non_visible_tool_without_task_progress)',
      'protocol_proof_missing',
    ],
    ['opencode_app_mcp_transport_changed:old->new/permission_denied', 'auth_error'],
    [
      'opencode_app_mcp_transport_changed:old->new;visible_reply_missing_task_refs',
      'protocol_proof_missing',
    ],
  ])('classifies separator-attached failure detail %s as %s', (message, reasonCode) => {
    expect(classifyRuntimeDiagnostic(message)).toMatchObject({
      reasonCode,
    });
    expect(classifyRuntimeDiagnostic(message).normalizedMessage).not.toBe(
      'OpenCode session changed; refreshing the session before retry.'
    );
  });

  it('does not treat embedded HTTP status digits in ids as auth diagnostics', () => {
    expect(classifyRuntimeDiagnostic('trace id abc401def')).toMatchObject({
      reasonCode: 'backend_error',
      actionRequired: false,
    });
    expect(classifyRuntimeDiagnostic('trace id abc403def')).toMatchObject({
      reasonCode: 'backend_error',
      actionRequired: false,
    });
    expect(classifyRuntimeDiagnostic('HTTP 401')).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(classifyRuntimeDiagnostic('status:403')).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(classifyRuntimeDiagnostic('status_401')).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
    expect(classifyRuntimeDiagnostic('http_403')).toMatchObject({
      reasonCode: 'auth_error',
      actionRequired: true,
    });
  });

  it('does not let OpenCode refresh markers hide protocol proof failures', () => {
    expect(
      classifyRuntimeDiagnostic('resolved_behavior_changed:old->new visible_reply_missing_task_refs')
    ).toMatchObject({
      reasonCode: 'protocol_proof_missing',
      generic: true,
    });
  });
});
