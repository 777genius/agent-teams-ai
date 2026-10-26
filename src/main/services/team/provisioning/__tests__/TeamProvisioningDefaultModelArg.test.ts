import { describe, expect, it } from 'vitest';

import { getLaunchModelArg } from '../TeamProvisioningRuntimeLaunchSelection';

import type { ProviderModelLaunchIdentity } from '@shared/types';

const identity = {
  selectedModelKind: 'default',
  resolvedLaunchModel: 'claude-opus-4-8',
} as ProviderModelLaunchIdentity;

describe('Anthropic runtime-owned Default', () => {
  it.each([undefined, '', '__provider_default__'])(
    'omits --model for %s despite resolved catalog facts',
    (model) => {
      expect(getLaunchModelArg('anthropic', model, identity)).toBeUndefined();
    }
  );

  it('keeps an explicitly selected model', () => {
    expect(getLaunchModelArg('anthropic', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('preserves Codex default materialization', () => {
    expect(
      getLaunchModelArg('codex', undefined, { ...identity, resolvedLaunchModel: 'gpt-6-luna' })
    ).toBe('gpt-6-luna');
  });
});
