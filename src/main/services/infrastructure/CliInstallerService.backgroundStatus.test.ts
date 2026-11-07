import { afterEach, describe, expect, test, vi } from 'vitest';

import { createDefaultProviderStatus } from '../runtime/providerStatusCheckContract';
import { ClaudeBinaryResolver } from '../team/ClaudeBinaryResolver';

import { CliInstallerService } from './CliInstallerService';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

interface CliInstallerServiceInternals {
  statusGatherGeneration: number;
  latestStatusSnapshot: CliInstallationStatus | null;
  multimodelBridgeService: {
    getProviderStatus: (
      binaryPath: string,
      providerId: CliProviderId
    ) => Promise<CliProviderStatus>;
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
  test('resolves the runtime when a provider check races initial discovery', async () => {
    const service = new CliInstallerService();
    const internals = service as unknown as CliInstallerServiceInternals;
    internals.latestStatusSnapshot = internals.createInitialStatus();
    vi.spyOn(ClaudeBinaryResolver, 'resolve').mockResolvedValue('/fake/runtime');
    const provider = createDefaultProviderStatus('opencode');
    const check = vi
      .spyOn(internals.multimodelBridgeService, 'getProviderStatus')
      .mockResolvedValue(provider);

    const result = await service.getProviderStatus('opencode');

    expect(check).toHaveBeenCalledWith('/fake/runtime', 'opencode', expect.any(Function));
    expect(result?.providerId).toBe('opencode');
    expect(result?.statusMessage).not.toBe('Provider runtime missing');
  });

  test('still reports a missing runtime when discovery finds none', async () => {
    const service = new CliInstallerService();
    vi.spyOn(ClaudeBinaryResolver, 'resolve').mockResolvedValue(null);

    const result = await service.getProviderStatus('opencode');

    expect(result?.detailMessage).toContain('Provider runtime missing');
  });

  test('does not use a runtime discovered before status was invalidated', async () => {
    const service = new CliInstallerService();
    const internals = service as unknown as CliInstallerServiceInternals;
    let finish!: (path: string | null) => void;
    vi.spyOn(ClaudeBinaryResolver, 'resolve').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const check = vi.spyOn(internals.multimodelBridgeService, 'getProviderStatus');
    const pending = service.getProviderStatus('opencode');
    await Promise.resolve();
    service.invalidateStatusCache();
    finish('/fake/stale-runtime');
    const result = await pending;
    expect(check).not.toHaveBeenCalled();
    expect(result?.detailMessage).toContain('runtime changed during status check');
  });

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
