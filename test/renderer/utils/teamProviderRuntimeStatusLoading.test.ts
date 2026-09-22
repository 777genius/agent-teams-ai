import { isTeamProviderRuntimeStatusLoading } from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { describe, expect, it } from 'vitest';

import type { TeamModelRuntimeProviderStatus } from '@renderer/utils/teamModelAvailability';

describe('authenticated native catalog refresh indicator', () => {
  const refreshing = (providerId: 'anthropic' | 'codex'): TeamModelRuntimeProviderStatus => ({
    providerId,
    supported: true,
    authenticated: true,
    authMethod: 'subscription',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    detailMessage: null,
    models: ['gpt-5.6-luna'],
    modelAvailability: [],
    modelVerificationState: 'verified',
    modelCatalog: null,
    modelCatalogRefreshState: 'loading',
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
  });
  it.each(['anthropic', 'codex'] as const)(
    'keeps %s checking after provider discovery and selected-model verification settle',
    (providerId) => {
      expect(isTeamProviderRuntimeStatusLoading(providerId, refreshing(providerId), false)).toBe(
        true
      );
    }
  );
  it.each([
    { modelCatalogRefreshState: 'error' as const },
    { modelCatalogRefreshState: 'ready' as const },
    { authenticated: false },
    { verificationState: 'error' as const },
    { statusCheckErrorCode: 'unavailable' as const },
  ])('does not hide a settled Codex failure with Checking: %j', (override) => {
    expect(
      isTeamProviderRuntimeStatusLoading('codex', { ...refreshing('codex'), ...override }, false)
    ).toBe(false);
  });
});
