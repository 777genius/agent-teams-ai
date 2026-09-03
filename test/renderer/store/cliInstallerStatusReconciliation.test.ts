import { reconcileCliProviderSnapshot } from '@renderer/store/slices/cliInstallerStatusReconciliation';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

const catalog = {
  schemaVersion: 1,
  providerId: 'anthropic',
  source: 'anthropic-models-api',
  status: 'ready',
  models: [
    {
      id: 'claude-3-5-haiku-latest',
      launchModel: 'claude-3-5-haiku-latest',
      displayName: 'Claude 3.5 Haiku',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: true,
      upgrade: false,
      source: 'anthropic-models-api',
    },
  ],
  staleAt: '2026-09-03T00:00:00.000Z',
  fetchedAt: '2026-09-02T00:00:00.000Z',
  defaultModelId: 'claude-3-5-haiku-latest',
  defaultLaunchModel: 'claude-3-5-haiku-latest',
  diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
} as CliProviderStatus['modelCatalog'];

function provider(overrides: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    modelVerificationState: 'verified',
    modelCatalogRefreshState: 'ready',
    statusMessage: null,
    detailMessage: null,
    models: ['claude-3-5-haiku-latest'],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: { teamLaunch: true, oneShot: true },
    selectedBackendId: 'anthropic',
    resolvedBackendId: 'anthropic',
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: { kind: 'anthropic-api', label: 'Anthropic API' },
    connection: null,
    modelCatalog: catalog,
    runtimeCapabilities: null,
    subscriptionRateLimits: null,
    ...overrides,
  } as CliProviderStatus;
}

describe('cli provider status reconciliation', () => {
  it('keeps a retained catalog loading during an authoritative partial refresh', () => {
    const current = provider();
    const incoming = provider({
      authenticated: false,
      authMethod: null,
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
      modelVerificationState: 'verifying',
      modelCatalogRefreshState: 'error',
      models: [],
      modelCatalog: null,
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: {} as CliProviderStatus['capabilities']['extensions'],
      },
    });

    const reconciled = reconcileCliProviderSnapshot(current, incoming);

    expect(reconciled.modelCatalog?.status).toBe('stale');
    expect(reconciled.modelCatalogRefreshState).toBe('loading');
    expect(reconciled.capabilities.teamLaunch).toBe(false);
  });
});
