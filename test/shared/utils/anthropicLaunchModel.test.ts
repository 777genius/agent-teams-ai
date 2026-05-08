import { describe, expect, it } from 'vitest';

import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';

describe('resolveAnthropicLaunchModel', () => {
  it('keeps legacy long-context fallback behavior when no runtime catalog is available', () => {
    expect(resolveAnthropicLaunchModel({ selectedModel: 'opus', limitContext: false })).toBe(
      'opus[1m]'
    );
    expect(resolveAnthropicLaunchModel({ selectedModel: '', limitContext: false })).toBe(
      'opus[1m]'
    );
  });

  it('falls back from long-context synthetic launch ids to base ids when runtime catalog lacks the 1M variant', () => {
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: 'opus',
        limitContext: false,
        availableLaunchModels: ['opus'],
      })
    ).toBe('opus');
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: 'claude-opus-4-6',
        limitContext: false,
        availableLaunchModels: ['claude-opus-4-6'],
      })
    ).toBe('claude-opus-4-6');
  });

  it('uses runtime default launch truth when the provider default is requested', () => {
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
        limitContext: false,
        defaultLaunchModel: 'opus',
        availableLaunchModels: ['opus'],
      })
    ).toBe('opus');
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
        limitContext: true,
        defaultLaunchModel: 'opus[1m]',
        availableLaunchModels: ['opus', 'opus[1m]'],
      })
    ).toBe('opus');
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
        limitContext: false,
        defaultLaunchModel: 'sonnet[1m]',
        availableLaunchModels: ['sonnet', 'sonnet[1m]'],
      })
    ).toBe('sonnet');
  });

  it('preserves limitContext requests and never manufactures 1M Sonnet or Haiku variants', () => {
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: 'sonnet',
        limitContext: false,
        availableLaunchModels: ['sonnet', 'sonnet[1m]'],
      })
    ).toBe('sonnet');
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: 'claude-sonnet-4-6',
        limitContext: false,
        availableLaunchModels: ['claude-sonnet-4-6', 'claude-sonnet-4-6[1m]'],
      })
    ).toBe('claude-sonnet-4-6');
    expect(
      resolveAnthropicLaunchModel({
        selectedModel: 'haiku',
        limitContext: false,
        availableLaunchModels: ['haiku'],
      })
    ).toBe('haiku');
    expect(resolveAnthropicLaunchModel({ selectedModel: 'opus[1m][1m]', limitContext: false })).toBe(
      'opus[1m]'
    );
  });
});
