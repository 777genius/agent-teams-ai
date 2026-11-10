import { describe, expect, it } from 'vitest';

import { resolveRuntimeStatusDefaultModel } from '../TeamProvisioningRuntimeDefaultModel';

const current = {
  providerId: 'anthropic' as const,
  verificationState: 'verified' as const,
  statusCheckOutcome: 'authoritative' as const,
  effectiveDefaultModel: 'gateway-selected[1m]',
  defaultModel: 'legacy-model',
};

describe('runtime status default model fallback', () => {
  it('uses current runtime identity with the existing context policy', () => {
    expect(resolveRuntimeStatusDefaultModel(current, 'anthropic', true)).toBe('gateway-selected');
    expect(resolveRuntimeStatusDefaultModel(current, 'anthropic', false)).toBe(
      'gateway-selected[1m]'
    );
  });

  it('preserves legacy defaults and ignores mismatched or unconfirmed effective values', () => {
    expect(
      resolveRuntimeStatusDefaultModel(
        { ...current, effectiveDefaultModel: undefined },
        'anthropic',
        true
      )
    ).toBe('legacy-model');
    expect(
      resolveRuntimeStatusDefaultModel(
        { ...current, statusCheckOutcome: 'pending' },
        'anthropic',
        true
      )
    ).toBe('legacy-model');
    expect(
      resolveRuntimeStatusDefaultModel(
        { ...current, statusCheckErrorCode: 'unavailable' },
        'anthropic',
        true
      )
    ).toBe('legacy-model');
    expect(
      resolveRuntimeStatusDefaultModel({ ...current, providerId: 'codex' }, 'anthropic', true)
    ).toBeNull();
  });
});
