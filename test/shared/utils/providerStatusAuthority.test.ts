import {
  hasAuthoritativeProviderLaunchEvidence,
  isProviderModelCatalogExactReady,
} from '@shared/utils/providerStatusAuthority';
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

function createReadyProvider(): CliProviderStatus {
  const provider = createProvider();
  provider.modelCatalogRefreshState = 'ready';
  provider.modelCatalog = {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'app-server',
    status: 'ready',
    fetchedAt: '2026-08-29T00:00:00.000Z',
    staleAt: '2026-08-29T00:10:00.000Z',
    defaultModelId: null,
    defaultLaunchModel: null,
    models: [],
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
  };
  return provider;
}

describe('isProviderModelCatalogExactReady', () => {
  it.each([
    ['impossible date', '2026-02-30T00:10:00.000Z'],
    ['date only', '2026-08-29'],
    ['timezone-less', '2026-08-29T00:10:00.000'],
    ['offset', '2026-08-29T01:10:00.000+01:00'],
    ['overflow', '2026-13-29T00:10:00.000Z'],
    ['NaN', 'NaN'],
  ])('rejects a non-canonical %s staleAt', (_label, staleAt) => {
    const provider = createReadyProvider();
    provider.modelCatalog!.staleAt = staleAt;

    expect(isProviderModelCatalogExactReady(provider, Date.parse('2026-08-29T00:05:00.000Z'))).toBe(
      false
    );
  });

  it.each([
    ['before', Date.parse('2026-08-29T00:09:59.999Z'), true],
    ['at', Date.parse('2026-08-29T00:10:00.000Z'), false],
    ['after', Date.parse('2026-08-29T00:10:00.001Z'), false],
  ])('is %s the staleAt boundary', (_label, now, expected) => {
    expect(isProviderModelCatalogExactReady(createReadyProvider(), now)).toBe(expected);
  });
});

describe('hasAuthoritativeProviderLaunchEvidence', () => {
  it('rejects an otherwise authoritative payload when catalog evidence is absent', () => {
    expect(hasAuthoritativeProviderLaunchEvidence(createProvider())).toBe(false);
  });

  it('accepts an explicitly exact-ready empty catalog as authoritative evidence', () => {
    const provider = createReadyProvider();
    provider.modelCatalog!.staleAt = '2100-01-01T00:00:00.000Z';

    expect(hasAuthoritativeProviderLaunchEvidence(provider)).toBe(true);
  });
});
