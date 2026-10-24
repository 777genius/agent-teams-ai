import { getAnthropicRuntimeDefaultLaunchModel } from '@shared/utils/providerDefaultModel';
import { describe, expect, it } from 'vitest';

const current = {
  providerId: 'anthropic' as const,
  verificationState: 'verified' as const,
  statusCheckOutcome: 'authoritative' as const,
  effectiveDefaultModel: ' applied-model ',
  defaultModel: 'legacy-model',
};

describe('current inherited Anthropic launch default', () => {
  it('uses confirmed current runtime config before model-list fallback', () => {
    expect(getAnthropicRuntimeDefaultLaunchModel(current)).toBe('applied-model');
    expect(getAnthropicRuntimeDefaultLaunchModel({ ...current, effectiveDefaultModel: null })).toBe(
      'legacy-model'
    );
  });

  it.each([
    { statusCheckOutcome: 'pending' as const },
    { statusCheckOutcome: 'transient_error' as const },
    { verificationState: 'unknown' as const },
    { statusCheckErrorCode: 'unavailable' as const },
  ])('does not promote unconfirmed current config %j', (change) => {
    expect(getAnthropicRuntimeDefaultLaunchModel({ ...current, ...change })).toBe('legacy-model');
  });

  it('rejects a different provider and absent status', () => {
    expect(getAnthropicRuntimeDefaultLaunchModel({ ...current, providerId: 'codex' })).toBeNull();
    expect(getAnthropicRuntimeDefaultLaunchModel(null)).toBeNull();
  });
});
