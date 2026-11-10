import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT,
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
} from '@renderer/store/slices/cliInstallerSlice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { useOpenCodeDashboardStatus } from './useOpenCodeDashboardStatus';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { CliProviderId, CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';
import type { ElectronAPI } from '@shared/types/api';
import type { StateCreator, StoreApi } from 'zustand';

const mocks = vi.hoisted(() => ({ store: null as StoreApi<CliInstallerSlice> | null }));
vi.mock('@renderer/store', async () => {
  const { useStore } = await import('zustand');
  return {
    useStore: (selector: (state: CliInstallerSlice) => unknown) => useStore(mocks.store!, selector),
  };
});

const projectPath = '/TEST/scope-boundary';
const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
const readyRuntime: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'app-managed',
  state: 'ready',
  version: '2.2.0',
  v2Support: 'ready',
};
function provider(marker = 'verified-project'): CliProviderStatus {
  const base = createLoadingMultimodelCliStatus().providers.find(
    (value) => value.providerId === 'opencode'
  )!;
  return {
    ...base,
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    modelVerificationState: 'verified',
    statusMessage: marker,
    models: [`opencode/${marker}`],
    effectiveDefaultModel: `opencode/${marker}`,
    capabilities: { ...base.capabilities, teamLaunch: true, oneShot: true },
  };
}

const originalApi = window.electronAPI;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: originalApi });
  vi.unstubAllGlobals();
});

async function setup(
  input: {
    runtime?: OpenCodeRuntimeStatus | null;
    global?: CliProviderStatus;
    cached?: CliProviderStatus;
  } = {}
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const getProviderStatus = vi.fn(
    async (_id: CliProviderId, _options?: { projectPath?: string }) => input.cached ?? provider()
  );
  const verifyProviderModels = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { cliInstaller: { getProviderStatus, verifyProviderModels } } as unknown as ElectronAPI,
  });
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  mocks.store = store;
  store.setState({
    cliStatus: {
      ...createLoadingMultimodelCliStatus(),
      providers: [input.global ?? provider('global')],
    },
    openCodeRuntimeStatus: input.runtime === undefined ? readyRuntime : input.runtime,
    cliProviderStatusByScope: input.cached ? { [scopeKey]: input.cached } : {},
  });
  let observed: ReturnType<typeof useOpenCodeDashboardStatus> | undefined;
  const Probe = () => {
    const cliStatus = useStore(store, (state) => state.cliStatus);
    const runtimeStatus = useStore(store, (state) => state.openCodeRuntimeStatus);
    const result = useOpenCodeDashboardStatus({
      enabled: true,
      projectPath,
      cliStatus,
      runtimeStatus,
    });
    useEffect(() => {
      observed = result;
    }, [result]);
    return <span>{result.providerStatus?.statusMessage}</span>;
  };
  const host = document.createElement('div');
  root = createRoot(host);
  await act(async () => root!.render(<Probe />));
  const selectedReads = () =>
    getProviderStatus.mock.calls.filter(([, options]) => options?.projectPath === projectPath)
      .length;
  const evictSelected = async (round: number) => {
    let maximum = Object.keys(store.getState().cliProviderStatusByScope).length;
    const unsubscribe = store.subscribe((state) => {
      maximum = Math.max(maximum, Object.keys(state.cliProviderStatusByScope).length);
    });
    await act(async () => {
      for (let index = 0; index < CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT; index++) {
        await store.getState().fetchCliProviderStatus('opencode', {
          silent: true,
          projectPath: `/TEST/other-${round}-${index}`,
        });
      }
    });
    unsubscribe();
    expect(maximum).toBeLessThanOrEqual(CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  };
  return {
    store,
    getProviderStatus,
    verifyProviderModels,
    host,
    selectedReads,
    evictSelected,
    observed: () => observed!,
    render: async () => {
      await act(async () => root!.render(<Probe />));
    },
  };
}

describe('OpenCode project status boundaries', () => {
  it.each(['native missing', 'support required'] as const)(
    'keeps the settled %s diagnosis while denying global and cached project authority',
    async (reason) => {
      const message =
        reason === 'native missing'
          ? 'OpenCode native runtime is not installed.'
          : 'OpenCode V2 support must be installed.';
      const global = {
        ...provider('old-global'),
        supported: false,
        statusCheckErrorCode:
          reason === 'native missing' ? ('runtime_missing' as const) : ('unavailable' as const),
        statusMessage: message,
        detailMessage: `${message} Runtime diagnostic.`,
      };
      const runtime: OpenCodeRuntimeStatus =
        reason === 'native missing'
          ? { installed: false, source: 'missing', state: 'idle' }
          : { ...readyRuntime, state: 'idle', v2Support: 'required', error: message };
      const test = await setup({ global, runtime, cached: provider() });
      expect(test.observed().enabled).toBe(false);
      expect(test.host.textContent).toBe(message);
      expect(test.observed().providerStatus).toMatchObject({
        statusCheckOutcome: 'authoritative',
        statusCheckErrorCode: global.statusCheckErrorCode,
        detailMessage: global.detailMessage,
        authenticated: false,
        authMethod: null,
        effectiveDefaultModel: null,
        capabilities: { teamLaunch: false, oneShot: false },
        models: [],
        modelAvailability: [],
        modelCatalog: null,
      });
      expect(test.getProviderStatus).not.toHaveBeenCalled();
      expect(test.verifyProviderModels).not.toHaveBeenCalled();
    }
  );

  it('uses the current runtime failure instead of a stale successful global or project snapshot', async () => {
    const test = await setup({ cached: provider() });
    await act(async () =>
      test.store.setState({
        openCodeRuntimeStatus: {
          ...readyRuntime,
          state: 'idle',
          v2Support: 'required',
          error: 'Support receipt is missing.',
        },
      })
    );
    expect(test.host.textContent).toBe('Support receipt is missing.');
    expect(test.observed().providerStatus).toMatchObject({
      supported: false,
      authenticated: false,
      modelCatalogRefreshState: 'error',
      capabilities: { teamLaunch: false, oneShot: false },
      models: [],
      modelCatalog: null,
    });
    expect(test.observed().providerStatus?.statusCheckOutcome).not.toBe('pending');
    expect(test.selectedReads()).toBe(1);
    expect(test.verifyProviderModels).not.toHaveBeenCalled();
  });

  it('keeps real bootstrap and install progress pending, then resumes reads when support becomes ready', async () => {
    const pending = createLoadingMultimodelCliStatus().providers.find(
      (value) => value.providerId === 'opencode'
    )!;
    const test = await setup({ runtime: null, global: pending });
    expect(test.observed().providerStatus?.statusCheckOutcome).toBe('pending');
    expect(test.observed().enabled).toBe(false);
    await act(async () =>
      test.store.setState({
        openCodeRuntimeStatus: { ...readyRuntime, state: 'installing', v2Support: 'required' },
      })
    );
    expect(test.observed().providerStatus?.statusCheckOutcome).toBe('pending');
    expect(test.getProviderStatus).not.toHaveBeenCalled();
    await act(async () =>
      test.store.setState({
        openCodeRuntimeStatus: {
          ...readyRuntime,
          state: 'idle',
          v2Support: 'required',
          error: 'Support is not installed.',
        },
      })
    );
    expect(test.host.textContent).toBe('Support is not installed.');
    expect(test.observed().providerStatus?.statusCheckOutcome).toBe('transient_error');
    await act(async () => test.store.setState({ openCodeRuntimeStatus: readyRuntime }));
    expect(test.selectedReads()).toBe(1);
    expect(test.host.textContent).toBe('verified-project');
    expect(test.verifyProviderModels).not.toHaveBeenCalled();
  });

  it('recovers each actual active-scope eviction without increasing the twelve-entry cache', async () => {
    const test = await setup();
    expect(test.selectedReads()).toBe(1);
    await test.evictSelected(1);
    expect(test.selectedReads()).toBe(2);
    expect(test.store.getState().cliProviderStatusByScope[scopeKey]?.statusMessage).toBe(
      'verified-project'
    );
    await test.evictSelected(2);
    expect(test.selectedReads()).toBe(3);
    expect(test.host.textContent).toBe('verified-project');
    expect(test.store.getState().cliProviderStatusScopeRevision).toBe(0);
    expect(test.verifyProviderModels).not.toHaveBeenCalled();
  });

  it('does not recover the previous executable scope during a V1 to V2 upgrade', async () => {
    const previousModelId = 'opencode/previous-native';
    const previous = provider('previous-native');
    previous.modelCatalogRefreshState = 'ready';
    previous.modelCatalog = {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      staleAt: new Date(Date.now() + 60_000).toISOString(),
      defaultModelId: previousModelId,
      defaultLaunchModel: previousModelId,
      models: [
        {
          id: previousModelId,
          launchModel: previousModelId,
          displayName: 'TEST V1 model',
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
    };
    const v1 = { ...readyRuntime, version: '1.9.3' };
    const test = await setup({ runtime: v1, global: previous, cached: previous });
    expect(test.observed().providerStatus?.capabilities.teamLaunch).toBe(true);
    let complete!: (status: OpenCodeRuntimeStatus) => void;
    const installing = new Promise<OpenCodeRuntimeStatus>((resolve) => {
      complete = resolve;
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...window.electronAPI,
        cliInstaller: {
          ...window.electronAPI.cliInstaller,
          invalidateStatus: vi.fn(async () => undefined),
        },
        openCodeRuntime: {
          install: vi.fn(() => installing),
          invalidateStatus: vi.fn(async () => undefined),
        },
      },
    });
    let installation!: Promise<void>;
    await act(async () => {
      installation = test.store.getState().installOpenCodeRuntime({ generation: 'v2' });
    });
    const during = [test.observed()];
    for (const state of ['downloading', 'installing'] as const) {
      await act(async () => test.store.getState().applyOpenCodeRuntimeProgress({ ...v1, state }));
      during.push(test.observed());
    }
    const readsDuringUpgrade = test.selectedReads();
    test.getProviderStatus.mockResolvedValue(provider('new-v2-native'));
    await act(async () => {
      complete(readyRuntime);
      await installation;
    });

    expect(readsDuringUpgrade).toBe(1);
    for (const observation of during) {
      expect(observation.enabled).toBe(false);
      expect(observation.providerStatus).toMatchObject({
        statusCheckOutcome: 'pending',
        authenticated: false,
        models: [],
        modelCatalog: null,
        capabilities: { teamLaunch: false, oneShot: false },
      });
    }
    expect(test.observed().enabled).toBe(true);
    expect(test.observed().providerStatus?.models).toEqual(['opencode/new-v2-native']);
    expect(test.selectedReads()).toBeGreaterThan(1);
    expect(test.verifyProviderModels).not.toHaveBeenCalled();
  });

  it('settles failed eviction recovery without retrying missing or error snapshots', async () => {
    const test = await setup();
    test.getProviderStatus.mockImplementation(async (_id, options) => {
      if (options?.projectPath === projectPath) throw new Error('Scoped recovery unavailable');
      return provider('other');
    });
    await test.evictSelected(1);
    expect(test.selectedReads()).toBe(2);
    expect(test.observed().providerStatus?.statusCheckOutcome).toBe('transient_error');
    expect(test.host.textContent).toBe('Scoped recovery unavailable');
    await test.render();
    await act(async () => test.store.setState({ cliStatusError: 'unrelated update' }));
    expect(test.selectedReads()).toBe(2);
    expect(test.verifyProviderModels).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '[Store:cliInstaller]',
      'Failed to fetch opencode CLI status:',
      expect.objectContaining({ message: 'Scoped recovery unavailable' })
    );
    vi.mocked(console.error).mockClear();
  });

  it('does not retry when a missing-scope recovery ends without publishing a snapshot', async () => {
    const test = await setup();
    const fetch = vi.fn(async () => false);
    await act(async () => test.store.setState({ fetchCliProviderStatus: fetch }));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => test.store.setState({ cliProviderStatusByScope: {} }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await test.render();
    await act(async () => test.store.setState({ cliProviderStatusByScope: {} }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
