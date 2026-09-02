import { describe, expect, it } from 'vitest';

import {
  isTransientOpenCodeSharedRuntimeFailure,
  OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS,
  type OpenCodeSharedRuntimeFailureScope,
  shouldRetryTransientOpenCodeSharedRuntimeFailure,
  takeBlockingOpenCodeSharedRuntimeFailure,
  trackOpenCodeSharedRuntimeFailureFromResult,
} from '../TeamProvisioningOpenCodeSharedRuntimeFailurePolicy';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimePreLaunchGate,
} from '../../runtime/TeamRuntimeAdapter';

const MODELS_QUERY_TIMEOUT =
  'Failed to query OpenCode models: OpenCode command timed out after 10000ms';
const AGENTS_QUERY_TIMEOUT =
  'Failed to query OpenCode agents: OpenCode command timed out after 10000ms';
const CONFIG_TIMEOUT = '/config request failed: request timed out after 15000ms';
const HOST_UNHEALTHY = 'OpenCode host is not healthy: exit 1';
const CONNECTION_REFUSED = 'OpenCode readiness bridge failed: internal_error: ECONNREFUSED';

const retryableGate: TeamRuntimePreLaunchGate = {
  blocked: true,
  reason: 'unknown_error',
  retryable: true,
};

function failureResult(input: {
  message: string;
  preLaunchGate?: TeamRuntimePreLaunchGate;
}): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members: {
      bob: {
        memberName: 'bob',
        providerId: 'opencode',
        launchState: 'failed_to_start',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: input.message,
        diagnostics: [input.message],
      },
    },
    warnings: [],
    diagnostics: [input.message],
    ...(input.preLaunchGate ? { preLaunchGate: input.preLaunchGate } : {}),
  };
}

const healthyResult: TeamRuntimeLaunchResult = {
  runId: 'run-2',
  teamName: 'team-a',
  launchPhase: 'finished',
  teamLaunchState: 'clean_success',
  members: {},
  warnings: [],
  diagnostics: [],
};

describe('TeamProvisioningOpenCodeSharedRuntimeFailurePolicy', () => {
  it.each([MODELS_QUERY_TIMEOUT, AGENTS_QUERY_TIMEOUT, CONFIG_TIMEOUT])(
    'classifies %j as transient',
    (rootCause) => {
      expect(isTransientOpenCodeSharedRuntimeFailure(rootCause)).toBe(true);
    }
  );

  it.each([HOST_UNHEALTHY, CONNECTION_REFUSED])('keeps %j non-transient', (rootCause) => {
    expect(isTransientOpenCodeSharedRuntimeFailure(rootCause)).toBe(false);
  });

  it('records a transient failure and blocks the project until the TTL elapses', () => {
    const scope: OpenCodeSharedRuntimeFailureScope = {};

    expect(
      trackOpenCodeSharedRuntimeFailureFromResult(
        scope,
        '/repo',
        failureResult({ message: MODELS_QUERY_TIMEOUT }),
        1_000
      )
    ).toBe(MODELS_QUERY_TIMEOUT);
    expect(takeBlockingOpenCodeSharedRuntimeFailure(scope, '/repo', 1_000)).toBe(
      MODELS_QUERY_TIMEOUT
    );
    expect(
      takeBlockingOpenCodeSharedRuntimeFailure(
        scope,
        '/repo',
        1_000 + OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS - 1
      )
    ).toBe(MODELS_QUERY_TIMEOUT);

    // Expiry consumes the record, so exactly the next lane re-attempts.
    expect(
      takeBlockingOpenCodeSharedRuntimeFailure(
        scope,
        '/repo',
        1_000 + OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS
      )
    ).toBeNull();
    expect(scope.mixedSecondarySharedRuntimeFailuresByProject?.size).toBe(0);
  });

  it.each([HOST_UNHEALTHY, CONNECTION_REFUSED])(
    'keeps %j blocking well past the transient TTL',
    (message) => {
      const scope: OpenCodeSharedRuntimeFailureScope = {};
      trackOpenCodeSharedRuntimeFailureFromResult(
        scope,
        '/repo',
        failureResult({ message }),
        1_000
      );

      expect(
        takeBlockingOpenCodeSharedRuntimeFailure(
          scope,
          '/repo',
          1_000 + 100 * OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS
        )
      ).toBe(message);
    }
  );

  it('drops a stale record when a later result carries no shared runtime failure', () => {
    const scope: OpenCodeSharedRuntimeFailureScope = {};
    trackOpenCodeSharedRuntimeFailureFromResult(
      scope,
      '/repo',
      failureResult({ message: MODELS_QUERY_TIMEOUT }),
      1_000
    );

    expect(
      trackOpenCodeSharedRuntimeFailureFromResult(scope, '/repo', healthyResult, 2_000)
    ).toBeNull();
    expect(scope.mixedSecondarySharedRuntimeFailuresByProject?.size).toBe(0);
  });

  it('does not record failures outside the shared runtime preflight classes', () => {
    const scope: OpenCodeSharedRuntimeFailureScope = {};

    expect(
      trackOpenCodeSharedRuntimeFailureFromResult(
        scope,
        '/repo',
        failureResult({ message: 'EPERM: operation not permitted, rename' }),
        1_000
      )
    ).toBeNull();
    expect(scope.mixedSecondarySharedRuntimeFailuresByProject?.size ?? 0).toBe(0);
  });

  it('allows one in-place retry only for a gated timeout-class failure', () => {
    expect(
      shouldRetryTransientOpenCodeSharedRuntimeFailure(
        failureResult({ message: MODELS_QUERY_TIMEOUT, preLaunchGate: retryableGate })
      )
    ).toBe(true);
    // Without the gate the bridge may already own a host: never relaunch.
    expect(
      shouldRetryTransientOpenCodeSharedRuntimeFailure(
        failureResult({ message: MODELS_QUERY_TIMEOUT })
      )
    ).toBe(false);
    // A gate that is present but not auto-retryable is not proof enough either.
    expect(
      shouldRetryTransientOpenCodeSharedRuntimeFailure(
        failureResult({
          message: MODELS_QUERY_TIMEOUT,
          preLaunchGate: { blocked: true, reason: 'not_authenticated', retryable: true },
        })
      )
    ).toBe(false);
    // Non-timeout classes keep the existing no-retry behavior.
    expect(
      shouldRetryTransientOpenCodeSharedRuntimeFailure(
        failureResult({ message: HOST_UNHEALTHY, preLaunchGate: retryableGate })
      )
    ).toBe(false);
    expect(
      shouldRetryTransientOpenCodeSharedRuntimeFailure(
        failureResult({ message: CONNECTION_REFUSED, preLaunchGate: retryableGate })
      )
    ).toBe(false);
    expect(shouldRetryTransientOpenCodeSharedRuntimeFailure(null)).toBe(false);
  });
});
