import {
  blockedLaunchResult,
  buildOpenCodePreLaunchGate,
  firstDisplayableOpenCodeFailureMessage,
  GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON,
  isAutoRetryableOpenCodePreLaunchGate,
  isOpenCodeLaunchTimingDiagnostic,
  isRetryableReadinessState,
  normalizeOpenCodeFailureMessage,
} from '../OpenCodeLaunchGateResult';

import type { TeamRuntimeLaunchInput } from '../TeamRuntimeAdapter';

function launchInput(): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    laneId: 'primary',
    teamName: 'demo-team',
    cwd: '/repo',
    prompt: '',
    providerId: 'opencode',
    skipPermissions: true,
    previousLaunchState: null,
    expectedMembers: [{ name: 'team-lead', role: 'Lead', providerId: 'opencode', cwd: '/repo' }],
  } as TeamRuntimeLaunchInput;
}

describe('OpenCodeLaunchGateResult', () => {
  it.each([
    'runtime_store_blocked' as const,
    'mcp_unavailable' as const,
    'model_unavailable' as const,
    'unknown_error' as const,
  ])('marks %j as auto-retryable', (reason) => {
    expect(isRetryableReadinessState(reason)).toBe(true);
    expect(
      isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: buildOpenCodePreLaunchGate(reason) })
    ).toBe(true);
  });

  it.each(['not_installed' as const, 'not_authenticated' as const])(
    'keeps %j user-retryable but never auto-retryable',
    (reason) => {
      // Nothing changes while the app waits: only a person can clear these.
      expect(isRetryableReadinessState(reason)).toBe(true);
      expect(
        isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: buildOpenCodePreLaunchGate(reason) })
      ).toBe(false);
    }
  );

  it('treats an unknown gate reason as neither retryable nor auto-retryable', () => {
    const gate = buildOpenCodePreLaunchGate('opencode_capability_snapshot_missing');

    expect(gate).toEqual({
      blocked: true,
      reason: 'opencode_capability_snapshot_missing',
      retryable: false,
    });
    expect(isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: gate })).toBe(false);
  });

  it('treats an absent marker as no proof at all', () => {
    expect(isAutoRetryableOpenCodePreLaunchGate({})).toBe(false);
    expect(isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: undefined })).toBe(false);
  });

  it('fails every expected member with the first displayable readiness diagnostic', () => {
    const result = blockedLaunchResult(launchInput(), 'model_unavailable', [
      // Generic: skipped in favour of the diagnostic that says something.
      'OpenCode command timed out after 30s',
      'OpenCode model verification completed without assistant output',
    ]);

    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.launchPhase).toBe('finished');
    expect(result.members['team-lead']).toMatchObject({
      launchState: 'failed_to_start',
      hardFailure: true,
      runtimeAlive: false,
      hardFailureReason: 'OpenCode model verification completed without assistant output',
    });
  });

  it('reports a non-readiness reason verbatim instead of mining the diagnostics', () => {
    const result = blockedLaunchResult(launchInput(), 'opencode_launch_bridge_missing', [
      'OpenCode state-changing launch bridge is not registered.',
    ]);

    expect(result.members['team-lead'].hardFailureReason).toBe('opencode_launch_bridge_missing');
  });

  // The marker is opt-in: a block that cannot prove it preceded the
  // state-changing bridge command must never advertise one.
  it('omits the pre-launch gate marker unless the call site opts in', () => {
    expect(
      blockedLaunchResult(launchInput(), 'model_unavailable', []).preLaunchGate
    ).toBeUndefined();

    expect(
      blockedLaunchResult(launchInput(), 'model_unavailable', [], [], { preLaunchGate: true })
        .preLaunchGate
    ).toEqual({ blocked: true, reason: 'model_unavailable', retryable: true });
  });

  it('redacts secrets out of a failure message before it becomes user-facing', () => {
    expect(
      normalizeOpenCodeFailureMessage('  spawn failed:  opencode  --api-key sk-abcdefghijklmnop01 ')
    ).toBe('spawn failed: opencode --api-key [redacted]');
    expect(normalizeOpenCodeFailureMessage('Authorization: Bearer abc.def')).toBe(
      'Authorization: Bearer [redacted]'
    );
    expect(normalizeOpenCodeFailureMessage('   ')).toBeUndefined();
  });

  it('falls back to the generic reason only when generics are allowed', () => {
    const generics = [GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON, 'OpenCode session status busy'];

    expect(firstDisplayableOpenCodeFailureMessage(generics, { includeGeneric: false })).toBe(
      undefined
    );
    expect(firstDisplayableOpenCodeFailureMessage(generics, { includeGeneric: true })).toBe(
      GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON
    );
  });

  it('treats launch timing lines as noise rather than failure text', () => {
    expect(isOpenCodeLaunchTimingDiagnostic('info:opencode_launch_total_timing:1200')).toBe(true);
    expect(isOpenCodeLaunchTimingDiagnostic('OpenCode bridge refused the launch')).toBe(false);
    expect(
      firstDisplayableOpenCodeFailureMessage(
        ['info:opencode_launch_member_timing:lead=900', 'OpenCode bridge refused the launch'],
        { includeGeneric: false }
      )
    ).toBe('OpenCode bridge refused the launch');
  });
});
