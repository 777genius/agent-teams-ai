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
      providerId: CliProviderId,
      onCatalogUpdate?: (provider: CliProviderStatus) => void
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
  const projectPath = '/sandbox/TEST-opencode-preflight';
  test.each([false, true])(
    'ignores older single-read catalog callbacks after a fresh result (signed out=%s)',
    async (signedOut) => {
      const service = new CliInstallerService();
      const internals = service as unknown as CliInstallerServiceInternals;
      const result = internals.createInitialStatus();
      result.flavor = 'agent_teams_orchestrator';
      result.installed = true;
      result.binaryPath = '/fake/runtime';
      internals.latestStatusSnapshot = result;
      const unknown: CliProviderStatus = {
        ...createDefaultProviderStatus('codex'),
        supported: true,
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: undefined,
        verificationState: 'unknown',
      };
      const verified: CliProviderStatus = {
        ...unknown,
        authenticated: true,
        verificationState: 'verified',
      };
      let oldUpdate!: (provider: CliProviderStatus) => void;
      vi.spyOn(internals.multimodelBridgeService, 'getProviderStatus')
        .mockImplementationOnce(async (_binary, _provider, onUpdate) => {
          oldUpdate = onUpdate!;
          return signedOut ? verified : unknown;
        })
        .mockResolvedValueOnce(signedOut ? unknown : verified);
      await service.getProviderStatus('codex');
      await service.getProviderStatus('codex');
      oldUpdate(signedOut ? verified : { ...unknown, modelCatalogRefreshState: 'error' });
      expect(
        internals.latestStatusSnapshot?.providers.find(
          (provider) => provider.providerId === 'codex'
        )
      ).toMatchObject({ authenticated: !signedOut });
    }
  );
  test.each([
    { startOrder: 'before', fails: false },
    { startOrder: 'during', fails: false },
    { startOrder: 'during', fails: true },
  ])(
    'fences aggregate started $startOrder provider read (failure=$fails) and permits fresh revocation',
    async ({ startOrder, fails }) => {
      vi.useFakeTimers();
      const service = new CliInstallerService();
      const internals = service as unknown as CliInstallerServiceInternals;
      const result = internals.createInitialStatus();
      result.flavor = 'agent_teams_orchestrator';
      result.installed = true;
      result.binaryPath = '/fake/runtime';
      internals.latestStatusSnapshot = result;
      const unknown = {
        ...createDefaultProviderStatus('codex'),
        supported: true,
        statusCheckOutcome: 'authoritative' as const,
        statusCheckErrorCode: undefined,
        verificationState: 'unknown' as const,
      };
      const verified = { ...unknown, authenticated: true, verificationState: 'verified' as const };
      let finishProvider!: (provider: CliProviderStatus) => void;
      let rejectProvider!: (reason: Error) => void;
      const providerCheck = vi
        .spyOn(internals.multimodelBridgeService, 'getProviderStatus')
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            finishProvider = resolve;
            rejectProvider = reject;
          })
        )
        .mockResolvedValueOnce(unknown);
      let providerRead: Promise<CliProviderStatus | null> | undefined;
      if (startOrder === 'during') {
        providerRead = service.getProviderStatus('codex');
        await vi.waitFor(() => expect(providerCheck).toHaveBeenCalledTimes(1));
      }
      let finishAggregate!: (providers: CliProviderStatus[]) => void;
      let publishAggregate!: (providers: CliProviderStatus[], providerId?: CliProviderId) => void;
      vi.spyOn(internals.multimodelBridgeService, 'getProviderStatuses').mockImplementation(
        (_binaryPath, onUpdate) => {
          publishAggregate = onUpdate!;
          return new Promise((resolve) => {
            finishAggregate = resolve;
          });
        }
      );
      const pending = internals.checkAuthStatus(
        result.binaryPath,
        result,
        {},
        internals.statusGatherGeneration
      );
      await vi.advanceTimersByTimeAsync(1_500);
      await pending;
      providerRead ??= service.getProviderStatus('codex');
      if (fails) rejectProvider(new Error('Test-only status read unavailable'));
      else finishProvider(verified);
      await providerRead;
      expect(
        internals.latestStatusSnapshot?.providers.find((p) => p.providerId === 'codex')
          ?.authenticated
      ).toBe(!fails);
      const stale = fails ? verified : unknown;
      publishAggregate([stale]);
      expect(
        internals.latestStatusSnapshot?.providers.find((p) => p.providerId === 'codex')
          ?.authenticated
      ).toBe(!fails);
      publishAggregate([stale], 'codex');
      finishAggregate([stale]);
      await Promise.resolve();
      await Promise.resolve();
      expect(
        internals.latestStatusSnapshot?.providers.find((p) => p.providerId === 'codex')
          ?.authenticated
      ).toBe(!fails);
      await service.getProviderStatus('codex');
      expect(providerCheck).toHaveBeenCalledTimes(2);
      expect(
        internals.latestStatusSnapshot?.providers.find((p) => p.providerId === 'codex')
          ?.authenticated
      ).toBe(false);
    }
  );
  test('resolves the runtime when project-scoped preflight races initial discovery', async () => {
    const service = new CliInstallerService();
    const internals = service as unknown as CliInstallerServiceInternals;
    internals.latestStatusSnapshot = internals.createInitialStatus();
    vi.spyOn(ClaudeBinaryResolver, 'resolve').mockResolvedValue('/fake/runtime');
    const provider = createDefaultProviderStatus('opencode');
    const check = vi
      .spyOn(internals.multimodelBridgeService, 'getProviderStatus')
      .mockResolvedValue(provider);

    const result = await service.getProviderStatus('opencode', { projectPath });

    expect(check).toHaveBeenCalledWith('/fake/runtime', 'opencode', undefined, { projectPath });
    expect(result?.providerId).toBe('opencode');
    expect(result?.statusMessage).not.toBe('Provider runtime missing');
  });

  test('keeps passive provider polling cold before initial runtime discovery', async () => {
    const service = new CliInstallerService();
    const internals = service as unknown as CliInstallerServiceInternals;
    internals.latestStatusSnapshot = internals.createInitialStatus();
    const discover = vi.spyOn(ClaudeBinaryResolver, 'resolve').mockResolvedValue('/fake/runtime');
    const check = vi.spyOn(internals.multimodelBridgeService, 'getProviderStatus');

    const result = await service.getProviderStatus('opencode');

    expect(result?.detailMessage).toContain('Provider runtime missing');
    expect(discover).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  test('still reports a missing runtime when discovery finds none', async () => {
    const service = new CliInstallerService();
    vi.spyOn(ClaudeBinaryResolver, 'resolve').mockResolvedValue(null);

    const result = await service.getProviderStatus('opencode', { projectPath });

    expect(result?.detailMessage).toContain('Provider runtime missing');
  });


  test.each([true, false])(
    'does not return a superseded provider error after a newer %s auth result',
    async (newConnected) => {
      const service = new CliInstallerService();
      const internals = service as unknown as CliInstallerServiceInternals;
      const status = internals.createInitialStatus();
      status.flavor = 'agent_teams_orchestrator';
      status.installed = true;
      status.binaryPath = '/fake/runtime';
      internals.latestStatusSnapshot = status;
      const base = { ...createDefaultProviderStatus('codex'), supported: true };
      const current = {
        ...base,
        authenticated: newConnected,
        verificationState: 'verified' as const,
        statusCheckOutcome: 'authoritative' as const,
        statusCheckErrorCode: undefined,
      };
      let rejectOld!: (error: Error) => void;
      const spy = vi.spyOn(internals.multimodelBridgeService, 'getProviderStatus')
        .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
        .mockResolvedValueOnce(current);
      const older = service.getProviderStatus('codex');
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      const newer = await service.getProviderStatus('codex');
      expect(newer?.authenticated).toBe(newConnected);
      rejectOld(new Error('Test-only obsolete provider transport failure'));
      const obsolete = await older;
      expect(obsolete).toMatchObject({
        providerId: 'codex',
        authenticated: false,
        statusCheckOutcome: 'pending',
        capabilities: { teamLaunch: false },
      });
      expect(internals.latestStatusSnapshot?.providers.find(
        (provider) => provider.providerId === 'codex'
      )).toMatchObject({ authenticated: newConnected });
    }
  );

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
    const pending = service.getProviderStatus('opencode', { projectPath });
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
