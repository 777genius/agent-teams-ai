// @vitest-environment node
import { expect, it } from 'vitest';
import { reconcileCliProviderSnapshot } from '../../../src/renderer/store/slices/cliInstallerStatusReconciliation';
import { createDefaultProviderStatus } from '../../../src/main/services/runtime/providerStatusCheckContract';
import type { CliProviderStatus } from '../../../src/shared/types';

function snapshot(scope: string, model: string): CliProviderStatus {
  const now = Date.now();
  return {
    ...createDefaultProviderStatus('opencode'),
    catalogScope: scope,
    supported: true,
    authenticated: false,
    verificationState: 'unknown',
    statusCheckOutcome: 'model_only',
    modelCatalogRefreshState: 'ready',
    models: [model],
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(now - 1000).toISOString(),
      staleAt: new Date(now + 30000).toISOString(),
      defaultModelId: model,
      defaultLaunchModel: model,
      models: [
        {
          id: model,
          launchModel: model,
          displayName: model,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  };
}

it('fresh captured Native metadata replaces displayed models without granting authentication or launch authority', () => {
  const old = snapshot('a'.repeat(64), 'TEST/old');
  const incoming = snapshot('a'.repeat(64), 'TEST/new');
  const result = reconcileCliProviderSnapshot(old, incoming);
  expect(result.models).toEqual(['TEST/new']);
  expect(result.authenticated).toBe(false);
  expect(result.capabilities.teamLaunch).toBe(false);
});

it('a new Native presentation scope cannot inherit old models, availability or connection metadata even on failure', () => {
  const old = {
    ...snapshot('a'.repeat(64), 'TEST/private-old'),
    modelAvailability: [{ modelId: 'TEST/private-old', status: 'available' as const }],
    backend: { kind: 'TEST-private-old', label: 'TEST-private-old' },
  };
  const result = reconcileCliProviderSnapshot(old, {
    ...createDefaultProviderStatus('opencode'),
    catalogScope: 'b'.repeat(64),
    statusCheckOutcome: 'transient_error',
  });
  expect(result.models).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('TEST/private-old');
  expect(result.capabilities.teamLaunch).toBe(false);
});
