import { describe, expect, it } from 'vitest';

import { resolveRuntimeDefaultModelLabel } from './runtimeDefaultModelLabel';

import type { CliProviderStatus } from '@shared/types';

const NOW = Date.parse('2026-10-20T12:00:00Z');
function status(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'anthropic',
    supported: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    effectiveDefaultModel: 'vendor/custom-model',
    ...overrides,
  } as CliProviderStatus;
}

describe('runtime-confirmed Default labels', () => {
  it('shows the exact model id without requiring a matching catalog entry', () => {
    expect(resolveRuntimeDefaultModelLabel('anthropic', status(), false, NOW)).toEqual({
      label: 'vendor/custom-model',
      modelLabel: 'vendor/custom-model',
    });
  });

  it('keeps a Codex configured model id intact', () => {
    expect(
      resolveRuntimeDefaultModelLabel(
        'codex',
        status({ providerId: 'codex', effectiveDefaultModel: 'gpt-configured-model' }),
        false,
        NOW
      )?.label
    ).toBe('gpt-configured-model');
  });

  it.each([
    [false, 'claude-opus-4-8[1m]'],
    [true, 'claude-opus-4-8'],
  ])('uses the existing Anthropic context policy with limitContext=%s', (limited, expected) => {
    expect(
      resolveRuntimeDefaultModelLabel(
        'anthropic',
        status({ effectiveDefaultModel: 'claude-opus-4-8[1m]' }),
        limited,
        NOW
      )?.label
    ).toBe(expected);
  });

  it.each([
    ['no confirmed model', { effectiveDefaultModel: null }],
    [
      'only the legacy model-list default',
      { effectiveDefaultModel: undefined, defaultModel: 'other' },
    ],
    ['an unresolved family alias', { effectiveDefaultModel: 'sonnet' }],
    ['a pending check', { statusCheckOutcome: 'pending' }],
    ['a transient error', { statusCheckOutcome: 'transient_error' }],
    ['a model-only snapshot', { statusCheckOutcome: 'model_only' }],
    ['an unverified snapshot', { verificationState: 'unknown' }],
    ['a loading catalog', { modelCatalogRefreshState: 'loading' }],
    ['a failed refresh', { modelCatalogRefreshState: 'error' }],
    ['a different provider', { providerId: 'codex' }],
  ] as const)('keeps Default unresolved for %s', (_description, overrides) => {
    expect(resolveRuntimeDefaultModelLabel('anthropic', status(overrides), false, NOW)).toBeNull();
  });

  it.each(['stale', 'unavailable', 'ready'] as const)(
    'does not claim a default from an expired %s catalog',
    (catalogStatus) => {
      const modelCatalog = {
        providerId: 'anthropic',
        status: catalogStatus,
        staleAt: '2026-10-20T11:59:59Z',
        defaultLaunchModel: 'catalog-fallback',
        models: [],
      } as unknown as NonNullable<CliProviderStatus['modelCatalog']>;
      expect(
        resolveRuntimeDefaultModelLabel('anthropic', status({ modelCatalog }), false, NOW)
      ).toBeNull();
    }
  );

  it('leaves OpenCode to its existing project route authority', () => {
    expect(
      resolveRuntimeDefaultModelLabel('opencode', status({ providerId: 'opencode' }), false, NOW)
    ).toBeNull();
  });
});
