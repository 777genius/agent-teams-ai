import {
  buildRuntimeRecoveryCircuitKey,
  classifyRuntimeFailure,
  getStableRuntimeRecoveryJitterFactor,
  normalizeTeamRuntimeRecoveryConfig,
  planRuntimeRecovery,
} from '@features/team-runtime-recovery';
import { describe, expect, it } from 'vitest';

import type { RuntimeFailureSignal } from '@features/team-runtime-recovery';

const baseSignal: RuntimeFailureSignal = {
  id: 'failure-1',
  source: 'lead_stream',
  phase: 'terminal',
  observedAt: '2026-07-16T10:00:00.000Z',
  contextId: 'local',
  teamName: 'test-team',
  memberName: 'lead',
  targetKind: 'lead',
  detail: 'API Error: 529 overloaded_error',
  runId: 'run-1',
  providerBackendId: 'anthropic-api',
  model: 'claude-opus',
};

describe('RuntimeRecoveryPolicy', () => {
  it('clamps user-controlled config values', () => {
    expect(
      normalizeTeamRuntimeRecoveryConfig({
        transientErrorsEnabled: true,
        rateLimitsEnabled: true,
        initialDelaySeconds: 1,
        maxAttempts: 99,
      })
    ).toEqual({
      transientErrorsEnabled: true,
      rateLimitsEnabled: true,
      initialDelaySeconds: 15,
      maxAttempts: 5,
    });
  });

  it('produces stable bounded jitter', () => {
    const first = getStableRuntimeRecoveryJitterFactor('same-seed');
    expect(first).toBe(getStableRuntimeRecoveryJitterFactor('same-seed'));
    expect(first).toBeGreaterThanOrEqual(0.8);
    expect(first).toBeLessThanOrEqual(1.2);
  });

  it('plans exponential bounded recovery when transient recovery is enabled', () => {
    const classification = classifyRuntimeFailure(baseSignal);
    const first = planRuntimeRecovery({
      signal: baseSignal,
      classification,
      config: {
        transientErrorsEnabled: true,
        rateLimitsEnabled: false,
        initialDelaySeconds: 60,
        maxAttempts: 2,
      },
      attempt: 0,
      now: new Date('2026-07-16T10:00:00.000Z'),
    });
    const second = planRuntimeRecovery({
      signal: baseSignal,
      classification,
      config: {
        transientErrorsEnabled: true,
        rateLimitsEnabled: false,
        initialDelaySeconds: 60,
        maxAttempts: 2,
      },
      attempt: 1,
      now: new Date('2026-07-16T10:00:00.000Z'),
    });
    expect(first.kind).toBe('scheduled');
    expect(second.kind).toBe('scheduled');
    if (first.kind === 'scheduled' && second.kind === 'scheduled') {
      expect(first.delayMs).toBeGreaterThanOrEqual(48_000);
      expect(first.delayMs).toBeLessThanOrEqual(72_000);
      expect(second.delayMs).toBeGreaterThanOrEqual(96_000);
      expect(second.delayMs).toBeLessThanOrEqual(144_000);
    }
  });

  it('does not schedule disabled or exhausted recovery', () => {
    const classification = classifyRuntimeFailure(baseSignal);
    expect(
      planRuntimeRecovery({
        signal: baseSignal,
        classification,
        config: {
          transientErrorsEnabled: false,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        },
        attempt: 0,
        now: new Date('2026-07-16T10:00:00.000Z'),
      })
    ).toEqual({ kind: 'manual', reason: 'disabled' });
    expect(
      planRuntimeRecovery({
        signal: baseSignal,
        classification,
        config: {
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 60,
          maxAttempts: 2,
        },
        attempt: 2,
        now: new Date('2026-07-16T10:00:00.000Z'),
      })
    ).toEqual({ kind: 'manual', reason: 'attempts_exhausted' });
  });

  it('keeps circuits independent by run, backend, and model', () => {
    const key = buildRuntimeRecoveryCircuitKey(baseSignal);
    expect(key).not.toBe(buildRuntimeRecoveryCircuitKey({ ...baseSignal, model: 'claude-sonnet' }));
    expect(key).not.toBe(buildRuntimeRecoveryCircuitKey({ ...baseSignal, runId: 'run-2' }));
    expect(key).not.toBe(
      buildRuntimeRecoveryCircuitKey({ ...baseSignal, providerBackendId: 'codex-api' })
    );
  });
});
