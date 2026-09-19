import { mergeProviderCatalogDisplayAuthority } from '@main/services/runtime/providerCatalogDisplayAuthority';
import { describe, expect, it } from 'vitest';

import type { CliProviderModelCatalog, CliProviderStatus } from '@shared/types';

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
    models: ['gpt-5.4'],
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: { teamLaunch: true, oneShot: true, extensions: undefined as never },
  };
}

function createUnavailableCatalog(): CliProviderModelCatalog {
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'static-fallback',
    status: 'unavailable',
    fetchedAt: '2026-09-19T00:00:00.000Z',
    staleAt: '2026-09-19T00:10:00.000Z',
    defaultModelId: 'gpt-5.4',
    defaultLaunchModel: 'gpt-5.4',
    models: [
      {
        id: 'gpt-5.4',
        launchModel: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
      {
        id: 'local-proxy-qwen3',
        launchModel: 'local-proxy-qwen3',
        displayName: 'Qwen 3',
        hidden: false,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
        metadata: { configuredFromLocalCatalog: true },
      },
    ],
    diagnostics: { configReadState: 'ready', appServerState: 'runtime-missing' },
  };
}

describe('mergeProviderCatalogDisplayAuthority', () => {
  it('keeps extra catalog launch models even when the live catalog is unavailable', () => {
    const merged = mergeProviderCatalogDisplayAuthority(
      createProvider(),
      createUnavailableCatalog(),
      'error'
    );

    expect(merged.models).toEqual(['gpt-5.4', 'local-proxy-qwen3']);
    expect(merged.modelCatalog?.status).toBe('unavailable');
  });
});
