import { describe, expect, it } from 'vitest';

import {
  isOpenCodeBridgeUnknownOutcomeFailure,
  isOpenCodePromptNotSubmittedFailure,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgePreconditions';
import {
  didOpenCodeCommandFailBeforeDispatch,
  rememberOpenCodeStateChangingFailurePhase,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingCausalFailure';

import type { OpenCodeBridgeFailure } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

describe('OpenCode prompt submission outcome', () => {
  const failure = (details?: Record<string, unknown>): OpenCodeBridgeFailure => ({
    ok: false,
    schemaVersion: 1,
    requestId: 'owned-attempt',
    command: 'opencode.sendMessage',
    completedAt: '2026-10-26T16:00:00Z',
    durationMs: 25,
    error: { kind: 'timeout', message: 'deadline', retryable: true, details },
    diagnostics: [],
  });

  it('requires explicit runtime proof, including for legacy host_start timeouts', () => {
    for (const details of [undefined, { phase: 'host_start' }, { promptSubmission: 'unknown' }]) {
      expect(isOpenCodePromptNotSubmittedFailure(failure(details))).toBe(false);
      expect(isOpenCodeBridgeUnknownOutcomeFailure(failure(details))).toBe(true);
    }
    const confirmed = failure({ promptSubmission: 'not_started' });
    expect(isOpenCodePromptNotSubmittedFailure(confirmed)).toBe(true);
    expect(isOpenCodeBridgeUnknownOutcomeFailure(confirmed)).toBe(false);
    expect(
      isOpenCodePromptNotSubmittedFailure({ ...confirmed, command: 'opencode.stopTeam' })
    ).toBe(false);
    expect(
      isOpenCodePromptNotSubmittedFailure({
        ...confirmed,
        error: { ...confirmed.error, kind: 'transport_watchdog_timeout' },
      })
    ).toBe(false);
  });

  it('uses owned pre-dispatch facts and rejects copied or post-dispatch facts', () => {
    for (const phase of ['handshake', 'handshake_validation', 'binding', 'lease_acquire']) {
      const error = new Error('failed');
      rememberOpenCodeStateChangingFailurePhase(error, phase);
      expect(didOpenCodeCommandFailBeforeDispatch(error)).toBe(true);
      expect(didOpenCodeCommandFailBeforeDispatch({ phase })).toBe(false);
    }
    for (const phase of ['dispatch', 'ledger_begin', 'result_validation', 'failure_persistence']) {
      const error = new Error('failed');
      rememberOpenCodeStateChangingFailurePhase(error, phase);
      expect(didOpenCodeCommandFailBeforeDispatch(error)).toBe(false);
    }
  });
});
