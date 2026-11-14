import {
  isCodexProviderRuntimeMissing,
  shouldOfferCodexRuntimeInstall,
  shouldOfferCodexRuntimeUpdate,
} from '@renderer/components/runtime/codexRuntimeInstallAction';
import { createLoadingMultimodelCliStatus } from '@renderer/store/slices/cliInstallerSlice';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { describe, expect, it, vi } from 'vitest';

import { createTestStore } from '../../store/storeTestUtils';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderStatus } from '@shared/types';

const runtime = vi.hoisted(() => ({
  install: vi.fn<() => Promise<CodexRuntimeStatus>>(),
  invalidateStatus: vi.fn<() => Promise<void>>(),
  invalidateProvider: vi.fn<() => Promise<void>>(),
}));
vi.mock('@renderer/api', () => ({
  api: {
    codexRuntime: { install: runtime.install, invalidateStatus: runtime.invalidateStatus },
    cliInstaller: { invalidateStatus: runtime.invalidateProvider },
  },
  isElectronMode: () => true,
}));
vi.mock('@renderer/posthog', () => ({ capturePostHogEvent: vi.fn() }));

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

  it('offers an update for an installed stale Codex runtime', async () => {
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

    const store = createTestStore(),
      calls: string[] = [];
    const refresh = vi.fn(async () => {
      calls.push('provider.read');
      return true;
    });
    store.setState({
      cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [createCodexProvider()] },
      fetchCliProviderStatus: refresh,
    });
    let confirm: (status: CodexRuntimeStatus) => void = () => {
      throw new Error('TEST receipt is not pending');
    };
    const published = new Promise<CodexRuntimeStatus>((resolve) => {
      confirm = resolve;
    });
    runtime.install.mockImplementationOnce(() => {
      calls.push('install');
      return published;
    });
    runtime.invalidateStatus.mockImplementation(async () => {
      calls.push('selection.reconcile');
    });
    runtime.invalidateProvider.mockImplementation(async () => {
      calls.push('provider.invalidate');
    });
    const installing = store.getState().installCodexRuntime();
    expect(calls).toEqual(['install']);
    expect(store.getState().codexRuntimeStatusLoading).toBe(true);
    expect(store.getState().codexRuntimeStatus?.state).toBe('checking');
    const current: CodexRuntimeStatus = {
      installed: true,
      version: '0.169.0',
      latestVersion: '0.169.0',
      updateAvailable: false,
      source: 'app-managed',
      sourceRevision: 'TEST-published-B',
      state: 'ready',
    };
    confirm(current);
    await installing;
    expect(calls).toEqual([
      'install',
      'selection.reconcile',
      'provider.invalidate',
      'provider.read',
    ]);
    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('codex', {
      silent: false,
      epoch: expect.any(Number),
      checkReason: 'runtime_install',
    });
    expect(store.getState().codexRuntimeStatus).toEqual(current);
    expect(store.getState().codexRuntimeStatusLoading).toBe(false);

    const failed = new Error(
      'Codex selection could not be confirmed. The previous runtime is retained.'
    );
    runtime.install.mockRejectedValueOnce(failed);
    await store.getState().installCodexRuntime();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '[Store:cliInstaller]',
      'Failed to install Codex runtime:',
      failed
    );
    vi.mocked(console.error).mockClear();
    expect(runtime.install).toHaveBeenCalledTimes(2);
    expect(runtime.invalidateStatus).toHaveBeenCalledTimes(1);
    expect(runtime.invalidateProvider).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().codexRuntimeError).toBe(failed.message);
    expect(store.getState().codexRuntimeStatus?.sourceRevision).toBeUndefined();
    expect(store.getState().codexRuntimeStatusLoading).toBe(false);
  });
});
