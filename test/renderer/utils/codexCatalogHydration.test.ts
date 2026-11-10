import { shouldHydrateCodexModelCatalog } from '@renderer/utils/codexCatalogHydration';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

function snapshot(changes: Partial<CliProviderStatus> = {}): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusMessage: CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
    models: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    modelCatalogRefreshState: 'idle',
    runtimeCapabilities: null,
    ...changes,
  };
}

describe('shouldHydrateCodexModelCatalog', () => {
  it('hydrates the typed pending partial-response status emitted before a runtime probe', () => {
    expect(
      shouldHydrateCodexModelCatalog(
        snapshot({
          statusCheckOutcome: 'pending',
          statusCheckErrorCode: 'partial_response',
          statusMessage: 'Checking...',
        })
      )
    ).toBe(true);
  });

  it.each([undefined, 'pending'] as const)(
    'hydrates a selected deferred snapshot with outcome %s',
    (statusCheckOutcome) => {
      const provider = snapshot({ statusCheckOutcome });
      expect(shouldHydrateCodexModelCatalog(provider)).toBe(true);
      expect(provider.authenticated).toBe(false);
      expect(provider.capabilities.teamLaunch).toBe(false);
    }
  );

  it.each<Partial<CliProviderStatus>>([
    { statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'timeout' },
    { statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'runtime_missing' },
    { verificationState: 'error' },
    { modelCatalogRefreshState: 'error' },
    { statusCheckOutcome: 'authoritative', verificationState: 'verified', supported: false },
    {
      statusCheckOutcome: 'authoritative',
      verificationState: 'verified',
      supported: true,
      authenticated: false,
    },
    { providerId: 'anthropic' },
  ])('does not automatically retry a completed or unrelated snapshot %#', (changes) => {
    expect(shouldHydrateCodexModelCatalog(snapshot(changes))).toBe(false);
  });

  it('still hydrates a connected dynamic catalog when only the summary is present', () => {
    expect(
      shouldHydrateCodexModelCatalog(
        snapshot({
          supported: true,
          authenticated: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
        })
      )
    ).toBe(true);
  });
});
