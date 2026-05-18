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
  });
});
