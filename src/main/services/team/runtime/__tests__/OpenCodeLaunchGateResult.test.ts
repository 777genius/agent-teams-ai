import { describe, expect, it } from 'vitest';

import {
  isAutoRetryableOpenCodePreLaunchGate,
  isRetryableReadinessState,
  openCodePreLaunchGate,
} from '../OpenCodeLaunchGateResult';

describe('OpenCodeLaunchGateResult', () => {
  it.each([
    'runtime_store_blocked' as const,
    'mcp_unavailable' as const,
    'model_unavailable' as const,
    'unknown_error' as const,
  ])('marks %j as auto-retryable', (reason) => {
    expect(isRetryableReadinessState(reason)).toBe(true);
    expect(
      isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: openCodePreLaunchGate(reason) })
    ).toBe(true);
  });

  it.each(['not_installed' as const, 'not_authenticated' as const])(
    'keeps %j user-retryable but never auto-retryable',
    (reason) => {
      // Nothing changes while the app waits: only a person can clear these.
      expect(isRetryableReadinessState(reason)).toBe(true);
      expect(
        isAutoRetryableOpenCodePreLaunchGate({ preLaunchGate: openCodePreLaunchGate(reason) })
      ).toBe(false);
    }
  );

  it('treats an unknown gate reason as neither retryable nor auto-retryable', () => {
    const gate = openCodePreLaunchGate('opencode_capability_snapshot_missing');

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
});
