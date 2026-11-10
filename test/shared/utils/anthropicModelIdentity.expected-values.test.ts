import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { DEFAULT_PROVIDER_MODEL_SELECTION } from '@shared/utils/providerModelSelection';
import { describe, expect, it } from 'vitest';

const CONCRETE_DEFAULT = 'claude-opus-5-5';

describe('Anthropic model identity expected values', () => {
  it.each([
    {
      name: 'no catalog, null default selection, 1M',
      selectedModel: null,
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: undefined,
      limitContext: false,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'no catalog, empty default selection, 200K',
      selectedModel: '',
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: undefined,
      limitContext: true,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'default sentinel, aliases-only catalog, 1M',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: ['opus'],
      limitContext: false,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'default sentinel, incomplete authoritative catalog, 200K',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: ['opus', 'sonnet'],
      limitContext: true,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'default sentinel, stale alias catalog, 1M',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: ['opus'],
      limitContext: false,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'default sentinel, static alias catalog, 200K',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: ['opus'],
      limitContext: true,
      expected: CONCRETE_DEFAULT,
    },
    {
      name: 'custom runtime default, aliases-only catalog, 1M',
      selectedModel: '',
      defaultLaunchModel: 'anthropic-compatible/acme-coder',
      availableLaunchModels: ['opus', 'sonnet', 'haiku'],
      limitContext: false,
      expected: 'anthropic-compatible/acme-coder',
    },
    {
      name: 'unknown runtime default with no catalog, 1M fallback',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: null,
      availableLaunchModels: undefined,
      limitContext: false,
      expected: 'opus[1m]',
    },
    {
      name: 'unknown runtime default with aliases-only catalog, 200K fallback',
      selectedModel: DEFAULT_PROVIDER_MODEL_SELECTION,
      defaultLaunchModel: '   ',
      availableLaunchModels: ['opus'],
      limitContext: true,
      expected: 'opus',
    },
    {
      name: 'explicit future Opus preserves base identity when no 1M launch variant exists',
      selectedModel: 'claude-opus-9',
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: ['opus'],
      limitContext: false,
      expected: 'claude-opus-9',
    },
    {
      name: 'explicit future Opus applies only the 1M context suffix without a catalog',
      selectedModel: 'claude-opus-9',
      defaultLaunchModel: CONCRETE_DEFAULT,
      availableLaunchModels: undefined,
      limitContext: false,
      expected: 'claude-opus-9[1m]',
    },
    {
      name: 'explicit future Sonnet preserves base identity and context policy',
      selectedModel: 'claude-sonnet-9[1m]',
      defaultLaunchModel: 'claude-sonnet-9',
      availableLaunchModels: ['sonnet'],
      limitContext: true,
      expected: 'claude-sonnet-9',
    },
    {
      name: 'explicit custom ID is never replaced by an Anthropic family alias',
      selectedModel: 'anthropic-compatible/acme-coder[1m]',
      defaultLaunchModel: 'opus',
      availableLaunchModels: ['opus'],
      limitContext: false,
      expected: 'anthropic-compatible/acme-coder[1m]',
    },
  ])(
    '$name',
    ({ selectedModel, defaultLaunchModel, availableLaunchModels, limitContext, expected }) => {
      expect(
        resolveAnthropicLaunchModel({
          selectedModel,
          defaultLaunchModel,
          availableLaunchModels,
          limitContext,
        })
      ).toBe(expected);
    }
  );
});
