import { afterEach, describe, expect, test, vi } from 'vitest';

import { createDefaultProviderStatus } from '../runtime/providerStatusCheckContract';

import { CliInstallerService } from './CliInstallerService';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

interface CliInstallerServiceInternals {
  statusGatherGeneration: number;
  latestStatusSnapshot: CliInstallationStatus | null;
  multimodelBridgeService: {
    getProviderStatuses: (
      binaryPath: string,
      onUpdate?: (providers: CliProviderStatus[], providerId?: CliProviderId) => void
    ) => Promise<CliProviderStatus[]>;
  };
  createInitialStatus: () => CliInstallationStatus;
  checkAuthStatus: (
    binaryPath: string,
    result: CliInstallationStatus,
    diag: Record<string, unknown>,
    generation: number
  ) => Promise<void>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CliInstallerService background provider status', () => {
  test('publishes provider completion after the initial status budget expires', async () => {
    vi.useFakeTimers();
    const internals = new CliInstallerService() as unknown as CliInstallerServiceInternals;
    const result = internals.createInitialStatus();
    result.installed = true;
    result.binaryPath = '/fake/runtime';
    internals.latestStatusSnapshot = result;

    let resolveProviders!: (providers: CliProviderStatus[]) => void;
    let publishProviderUpdate:
      | ((providers: CliProviderStatus[], providerId?: CliProviderId) => void)
      | undefined;
    const providersPromise = new Promise<CliProviderStatus[]>((resolve) => {
      resolveProviders = resolve;
    });
    vi.spyOn(internals.multimodelBridgeService, 'getProviderStatuses').mockImplementation(
      (_binaryPath, onUpdate) => {
        publishProviderUpdate = onUpdate;
        return providersPromise;
      }
    );

    const checkPromise = internals.checkAuthStatus(
      result.binaryPath,
      result,
      { authTimedOut: false },
      internals.statusGatherGeneration
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await checkPromise;

    const codex = createDefaultProviderStatus('codex');
    codex.supported = true;
    codex.authenticated = true;
    codex.authMethod = 'oauth_token';
    codex.verificationState = 'verified';
    codex.statusCheckOutcome = 'authoritative';
    codex.statusCheckErrorCode = undefined;
    codex.capabilities = { ...codex.capabilities, teamLaunch: true, oneShot: true };
    publishProviderUpdate?.([codex], 'codex');

    expect(
      internals.latestStatusSnapshot?.providers.find((provider) => provider.providerId === 'codex')
    ).toMatchObject({
      authenticated: true,
      authMethod: 'oauth_token',
      verificationState: 'verified',
    });

    resolveProviders([codex]);
    await providersPromise;
    await Promise.resolve();
  });
});
