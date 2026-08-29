import { hasAuthoritativeProviderLaunchEvidence } from '@shared/utils/providerStatusAuthority';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

function createProvider(): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'chatgpt',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
  };
}

describe('hasAuthoritativeProviderLaunchEvidence', () => {
  it('rejects an otherwise authoritative payload when catalog evidence is absent', () => {
    expect(hasAuthoritativeProviderLaunchEvidence(createProvider())).toBe(false);
  });

  it('accepts an explicitly exact-ready empty catalog as authoritative evidence', () => {
    const provider = createProvider();
    provider.modelCatalogRefreshState = 'ready';
    provider.modelCatalog = {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-08-29T00:00:00.000Z',
      staleAt: '2100-01-01T00:00:00.000Z',
      defaultModelId: null,
      defaultLaunchModel: null,
      models: [],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    };

    expect(hasAuthoritativeProviderLaunchEvidence(provider)).toBe(true);
  });
});
