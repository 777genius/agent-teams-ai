import {
  isCodexProviderRuntimeMissing,
  shouldOfferCodexRuntimeInstall,
  shouldOfferCodexRuntimeUpdate,
} from '@renderer/components/runtime/codexRuntimeInstallAction';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

function createCodexProvider(overrides?: Partial<CliProviderStatus>): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'error',
    statusMessage: 'Codex CLI not found',
    models: [],
    modelAvailability: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: 'codex-native',
    resolvedBackendId: 'codex-native',
    availableBackends: [
      {
        id: 'codex-native',
        label: 'Codex native',
        description: 'Use codex exec JSON mode.',
        selectable: false,
        recommended: true,
        available: false,
        state: 'runtime-missing',
        audience: 'general',
        statusMessage: 'Codex CLI not found',
      },
    ],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: null,
    ...overrides,
  };
}

describe('codexRuntimeInstallAction', () => {
  it('recognizes provider runtime-missing snapshots', () => {
    expect(isCodexProviderRuntimeMissing(createCodexProvider())).toBe(true);
  });

  it('does not offer install before installer status is loaded', () => {
    expect(shouldOfferCodexRuntimeInstall(null)).toBe(false);
  });

  it('offers install for confirmed missing or failed runtime status only', () => {
    expect(
      shouldOfferCodexRuntimeInstall({
        installed: false,
        latestVersion: '0.144.1',
        updateAvailable: false,
        source: 'missing',
        state: 'idle',
      })
    ).toBe(true);
    expect(
      shouldOfferCodexRuntimeInstall({
        installed: false,
        latestVersion: '0.144.1',
        updateAvailable: false,
        source: 'app-managed',
        state: 'failed',
      })
    ).toBe(true);
    expect(
      shouldOfferCodexRuntimeInstall({
        installed: true,
        latestVersion: '0.144.1',
        updateAvailable: false,
        source: 'path',
        state: 'ready',
      })
    ).toBe(false);
  });

  it('offers an update for an installed stale Codex runtime', () => {
    expect(
      shouldOfferCodexRuntimeUpdate({
        installed: true,
        version: 'codex-cli 0.139.0',
        latestVersion: '0.144.1',
        updateAvailable: true,
        source: 'path',
        state: 'ready',
      })
    ).toBe(true);
  });
});
