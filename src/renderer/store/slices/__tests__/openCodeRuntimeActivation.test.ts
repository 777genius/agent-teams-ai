import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
} from '@renderer/store/slices/cliInstallerSlice';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { ElectronAPI } from '@shared/types/api';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types/cliInstaller';
import type { StateCreator } from 'zustand';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const missing: OpenCodeRuntimeStatus = { installed: false, source: 'missing', state: 'idle' };
const ready: OpenCodeRuntimeStatus = {
  installed: true,
  source: 'app-managed',
  state: 'ready',
  version: '2.1.4',
  binaryPath: '/TEST/managed-opencode',
  v2Support: 'ready',
  compatibleV2Version: '2.1.4',
};
const required: OpenCodeRuntimeStatus = {
  ...ready,
  source: 'path',
  state: 'idle',
  v2Support: 'required',
  error: 'OpenCode V2 support download required.',
};

function verifiedOpenCodeProvider(modelId = 'opencode/previous-native'): CliProviderStatus {
  const base = createLoadingMultimodelCliStatus().providers.find(
    (provider) => provider.providerId === 'opencode'
  )!;
  return {
    ...base,
    supported: true,
    authenticated: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    statusCheckErrorCode: undefined,
    capabilities: { ...base.capabilities, teamLaunch: true, oneShot: true },
    models: [modelId],
    defaultModel: modelId,
    effectiveDefaultModel: modelId,
    modelCatalogRefreshState: 'ready',
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1000).toISOString(),
      staleAt: new Date(Date.now() + 60_000).toISOString(),
      defaultModelId: modelId,
      defaultLaunchModel: modelId,
      models: [
        {
          id: modelId,
          launchModel: modelId,
          displayName: 'TEST previous native model',
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

const originalApi = window.electronAPI;
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: originalApi,
  });
  vi.mocked(console.error).mockClear();
  vi.mocked(console.warn).mockClear();
});

function setup(overrides: Partial<ElectronAPI['openCodeRuntime']> = {}) {
  const runtime = {
    getStatus: vi.fn(async () => missing),
    install: vi.fn(async () => ready),
    invalidateStatus: vi.fn(async () => undefined),
    onProgress: () => () => undefined,
    ...overrides,
  };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { openCodeRuntime: runtime },
  });
  const store = createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
  return { store, runtime };
}

describe('OpenCode installation without restarting the renderer', () => {
  it.each([null, '/TEST/model-refresh'])(
    'joins a later ordinary status read to the current model refresh in scope %s',
    async (projectPath) => {
      const { store } = setup();
      const response = deferred<CliProviderStatus>();
      const fresh = verifiedOpenCodeProvider('opencode/new-native');
      const getProviderStatus = vi.fn(() => response.promise);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: { ...window.electronAPI, cliInstaller: { getProviderStatus } },
      });
      store.setState({ cliStatus: createLoadingMultimodelCliStatus() });
      const models = store.getState().fetchCliProviderStatus('opencode', {
        projectPath,
        requireModelList: true,
      });
      const status = store.getState().fetchCliProviderStatus('opencode', { projectPath });
      const silent = store.getState().fetchCliProviderStatus('opencode', {
        projectPath,
        silent: true,
      });
      response.resolve(fresh);
      expect(await Promise.all([models, status, silent])).toEqual([true, true, true]);
      expect(getProviderStatus).toHaveBeenCalledTimes(1);
      const current = projectPath
        ? store.getState().cliProviderStatusByScope[
            getCliProviderStatusScopeKey('opencode', projectPath)
          ]
        : store.getState().cliStatus!.providers.find((row) => row.providerId === 'opencode');
      expect(current?.models).toEqual(fresh.models);
      expect(store.getState().cliProviderStatusLoading.opencode).toBe(false);
    }
  );

  it('does not join a model refresh from an invalidated epoch or another project', async () => {
    const { store } = setup();
    const old = deferred<CliProviderStatus>();
    const fresh = verifiedOpenCodeProvider('opencode/new-native');
    const getProviderStatus = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(fresh);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...window.electronAPI,
        cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
      },
    });
    store.setState({ cliStatus: createLoadingMultimodelCliStatus() });
    const models = store.getState().fetchCliProviderStatus('opencode', {
      projectPath: '/TEST/old-project',
      requireModelList: true,
    });
    expect(await store.getState().fetchCliProviderStatus('opencode')).toBe(true);
    await store.getState().invalidateCliStatus();
    expect(
      await store.getState().fetchCliProviderStatus('opencode', { projectPath: '/TEST/old-project' })
    ).toBe(true);
    old.resolve(verifiedOpenCodeProvider());
    expect(await models).toBe(false);
    expect(getProviderStatus).toHaveBeenCalledTimes(3);
    const scopeKey = getCliProviderStatusScopeKey('opencode', '/TEST/old-project');
    expect(store.getState().cliProviderStatusByScope[scopeKey]?.models).toEqual(fresh.models);
    expect(store.getState().cliProviderStatusLoading.opencode).toBe(false);
  });

  it('retries an empty model-only response instead of accepting retained pre-install models', async () => {
    vi.useFakeTimers();
    const { store } = setup();
    const old = verifiedOpenCodeProvider();
    const fresh = verifiedOpenCodeProvider('opencode/new-native');
    const empty: CliProviderStatus = {
      ...old,
      authenticated: false,
      verificationState: 'unknown',
      statusCheckOutcome: 'model_only',
      statusCheckErrorCode: 'partial_response',
      models: [],
      modelCatalog: null,
      capabilities: { ...old.capabilities, teamLaunch: false, oneShot: false },
    };
    const getProviderStatus = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(fresh);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ...window.electronAPI,
        cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
      },
    });
    store.setState({ cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [old] } });
    const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    await vi.runAllTimersAsync();
    await installing;
    expect(getProviderStatus).toHaveBeenCalledTimes(2);
    expect(store.getState().cliStatus!.providers[0].models).toEqual(fresh.models);
  });

  it.each(['success', 'failure'] as const)(
    'lets an unrelated provider read settle with %s during OpenCode install retries',
    async (outcome) => {
      vi.useFakeTimers();
      const { store } = setup();
      const old = verifiedOpenCodeProvider();
      const fresh = verifiedOpenCodeProvider('opencode/new-native');
      const codex = deferred<CliProviderStatus>();
      const transient: CliProviderStatus = {
        ...old,
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
        models: [],
        modelCatalog: null,
      };
      const openCodeRead = vi.fn().mockResolvedValueOnce(transient).mockResolvedValue(fresh);
      const getProviderStatus = vi.fn((providerId: string) =>
        providerId === 'codex' ? codex.promise : openCodeRead()
      );
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
        },
      });
      store.setState({ cliStatus: createLoadingMultimodelCliStatus() });
      const unrelatedRead = store.getState().fetchCliProviderStatus('codex');
      expect(store.getState().cliProviderStatusLoading.codex).toBe(true);
      const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      await vi.runAllTimersAsync();
      await installing;
      expect(openCodeRead).toHaveBeenCalledTimes(2);
      if (outcome === 'failure') codex.reject(new Error('TEST unrelated provider unavailable'));
      else
        codex.resolve({
          ...verifiedOpenCodeProvider('codex/current-model'),
          providerId: 'codex',
          displayName: 'Codex',
          modelCatalog: null,
        });
      expect(await unrelatedRead).toBe(outcome === 'success');
      expect(store.getState().cliProviderStatusLoading.codex).toBe(false);
      expect(
        store.getState().cliStatus!.providers.find((row) => row.providerId === 'codex')
      ).toMatchObject(
        outcome === 'success'
          ? { models: ['codex/current-model'] }
          : { statusCheckOutcome: 'transient_error' }
      );
    }
  );

  it.each(['rejected', 'transient', 'superseded', 'persistent transient'] as const)(
    'does not finish a post-install refresh on retained models after a %s read',
    async (outcome) => {
      vi.useFakeTimers();
      const { store } = setup();
      const old = verifiedOpenCodeProvider();
      const fresh = verifiedOpenCodeProvider('opencode/new-native');
      const first = deferred<CliProviderStatus>();
      const transient: CliProviderStatus = {
        ...old,
        authenticated: false,
        verificationState: 'error',
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'unavailable',
        models: [],
        modelCatalog: null,
        modelCatalogRefreshState: 'error',
        capabilities: { ...old.capabilities, teamLaunch: false, oneShot: false },
      };
      const getProviderStatus = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(outcome === 'persistent transient' ? transient : fresh);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
        },
      });
      store.setState({ cliStatus: { ...createLoadingMultimodelCliStatus(), providers: [old] } });
      const fetch = vi.spyOn(store.getState(), 'fetchCliProviderStatus');
      const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      await vi.waitFor(() => expect(getProviderStatus).toHaveBeenCalledTimes(1));
      if (outcome === 'superseded') store.getState().invalidateCliProviderModelCatalog();
      if (outcome === 'rejected') first.reject(new Error('TEST provider IPC failed'));
      else first.resolve(outcome === 'superseded' ? old : transient);
      expect(await fetch.mock.results[0].value).toBe(false);
      expect(store.getState().cliStatus!.providers[0]).toMatchObject({
        models: old.models,
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });
      await vi.runAllTimersAsync();
      await installing;
      expect(getProviderStatus).toHaveBeenCalledTimes(outcome === 'persistent transient' ? 3 : 2);
      expect(store.getState().cliStatus!.providers[0].models).toEqual(
        outcome === 'persistent transient' ? old.models : fresh.models
      );
      expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
      expect(store.getState().openCodeRuntimeStatusLoading).toBe(false);
    }
  );

  it.each(['V1 legacy models only', 'V1 model_only', 'V2 catalog only'] as const)(
    'finishes a successful %s post-install read without requiring launch authority',
    async (mode) => {
      vi.useFakeTimers();
      const { store } = setup();
      const fresh: CliProviderStatus = {
        ...verifiedOpenCodeProvider('opencode/read-only'),
        authenticated: false,
        verificationState: 'unknown',
        statusCheckOutcome: mode === 'V1 legacy models only' ? undefined : 'model_only',
        statusCheckErrorCode: mode === 'V1 model_only' ? 'partial_response' : undefined,
        effectiveDefaultModel: null,
        capabilities: {
          ...verifiedOpenCodeProvider().capabilities,
          teamLaunch: false,
          oneShot: false,
        },
      };
      if (mode !== 'V2 catalog only') fresh.modelCatalog = null;
      const getProviderStatus = vi.fn(async () => fresh);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
        },
      });
      store.setState({ cliStatus: createLoadingMultimodelCliStatus() });
      const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      await vi.runAllTimersAsync();
      await installing;
      expect(getProviderStatus).toHaveBeenCalledTimes(1);
      const provider = store
        .getState()
        .cliStatus!.providers.find((value) => value.providerId === 'opencode')!;
      expect(provider.models).toEqual(fresh.models);
      expect(hasEffectiveProviderLaunchAuthority(provider)).toBe(false);
    }
  );

  it.each(['success', 'failure'] as const)(
    'ignores a pre-install status %s after V2 is ready',
    async (outcome) => {
      const old = deferred<OpenCodeRuntimeStatus>();
      const { store } = setup({ getStatus: () => old.promise });
      const checking = store.getState().fetchOpenCodeRuntimeStatus();
      await store.getState().installOpenCodeRuntime({ generation: 'v2' });
      if (outcome === 'success') old.resolve(missing);
      else old.reject(new Error('old status transport failed'));
      await checking;
      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatus: ready,
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: null,
      });
    }
  );

  it('a pre-install status response cannot clear the installation busy state', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const installing = deferred<OpenCodeRuntimeStatus>();
    const { store } = setup({ getStatus: () => old.promise, install: () => installing.promise });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    const install = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    old.resolve(missing);
    await checking;
    const duringInstall = {
      status: store.getState().openCodeRuntimeStatus?.state,
      loading: store.getState().openCodeRuntimeStatusLoading,
    };
    installing.resolve(ready);
    await install;
    expect(duringInstall).toEqual({ status: 'checking', loading: true });
  });

  it('preserves missing support and its retry action when install IPC fails', async () => {
    const { store } = setup({
      install: async () => {
        throw new Error('download IPC disconnected');
      },
    });
    store.setState({ openCodeRuntimeStatus: required });
    await store.getState().installOpenCodeRuntime({ generation: 'v2', supportOnly: true });
    expect(store.getState().openCodeRuntimeStatus).toMatchObject({
      installed: true,
      state: 'failed',
      v2Support: 'required',
      compatibleV2Version: '2.1.4',
      error: 'download IPC disconnected',
    });
  });

  it('preserves missing support when a readiness refresh fails', async () => {
    const { store } = setup({
      getStatus: async () => {
        throw new Error('status IPC disconnected');
      },
    });
    store.setState({ openCodeRuntimeStatus: required });
    await store.getState().fetchOpenCodeRuntimeStatus();
    expect(store.getState().openCodeRuntimeStatus).toMatchObject({
      state: 'failed',
      v2Support: 'required',
      compatibleV2Version: '2.1.4',
    });
  });

  it('keeps an installed V2 ready if the follow-up provider refresh is unavailable', async () => {
    const { store } = setup({
      invalidateStatus: async () => {
        throw new Error('provider refresh IPC disconnected');
      },
    });
    await store.getState().installOpenCodeRuntime({ generation: 'v2' });
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: ready,
      openCodeRuntimeStatusLoading: false,
      openCodeRuntimeError: null,
    });
  });

  it('does not reuse a status read started before explicit invalidation', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const getStatus = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(ready);
    const { store } = setup({ getStatus });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    await store.getState().invalidateOpenCodeRuntimeStatus();
    const refreshed = store.getState().fetchOpenCodeRuntimeStatus();
    old.resolve(missing);
    await Promise.all([checking, refreshed]);
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
  });

  it('a delayed poll cannot replace progress delivered by the main process', async () => {
    const old = deferred<OpenCodeRuntimeStatus>();
    const { store } = setup({ getStatus: () => old.promise });
    const checking = store.getState().fetchOpenCodeRuntimeStatus();
    const downloading: OpenCodeRuntimeStatus = {
      ...required,
      state: 'downloading',
      progress: { phase: 'downloading', percent: 42 },
      error: undefined,
    };
    store.getState().applyOpenCodeRuntimeProgress(downloading);
    old.resolve(required);
    await checking;
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: downloading,
      openCodeRuntimeStatusLoading: true,
      openCodeRuntimeError: null,
    });
    store.getState().applyOpenCodeRuntimeProgress(ready);
    expect(store.getState().openCodeRuntimeStatusLoading).toBe(false);
  });

  it('shares a repeated install request until the first installation settles', async () => {
    const result = deferred<OpenCodeRuntimeStatus>();
    const install = vi.fn(() => result.promise);
    const { store } = setup({ install });
    const first = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    const second = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    expect(install).toHaveBeenCalledTimes(1);
    result.resolve(ready);
    await Promise.all([first, second]);
    expect(store.getState().openCodeRuntimeStatus).toEqual(ready);
  });

  it('retains newer main-process progress when an earlier post-install refresh finishes', async () => {
    const refresh = deferred<void>();
    const invalidateStatus = vi.fn(() => refresh.promise);
    const { store } = setup({ invalidateStatus });
    const installing = store.getState().installOpenCodeRuntime({ generation: 'v2' });
    await vi.waitFor(() => expect(invalidateStatus).toHaveBeenCalledTimes(1));
    const downloading: OpenCodeRuntimeStatus = {
      ...ready,
      state: 'downloading',
      progress: { phase: 'downloading', percent: 12 },
    };
    store.getState().applyOpenCodeRuntimeProgress(downloading);
    refresh.resolve();
    await installing;
    expect(store.getState()).toMatchObject({
      openCodeRuntimeStatus: downloading,
      openCodeRuntimeStatusLoading: true,
    });
    store.getState().applyOpenCodeRuntimeProgress(ready);
  });

  it.each(['failed install', 'failed refresh', 'fresh refresh'] as const)(
    'revokes global launch authority until a new provider check after %s',
    async (outcome) => {
      const installing = deferred<OpenCodeRuntimeStatus>();
      const oldRead = deferred<CliProviderStatus>();
      const { store } = setup({
        install: () => installing.promise,
        invalidateStatus: async () => {
          if (outcome === 'failed refresh') throw new Error('provider refresh IPC disconnected');
        },
      });
      const cliStatus = createLoadingMultimodelCliStatus();
      const old = verifiedOpenCodeProvider();
      const fresh: CliProviderStatus = { ...old, statusMessage: 'TEST new native verified' };
      const otherProviders = cliStatus.providers.filter(
        (provider) => provider.providerId !== 'opencode'
      );
      const getProviderStatus = vi
        .fn()
        .mockReturnValueOnce(oldRead.promise)
        .mockResolvedValue(fresh);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: { invalidateStatus: vi.fn(async () => undefined), getProviderStatus },
        },
      });
      const globalProvider = (): CliProviderStatus =>
        store
          .getState()
          .cliStatus!.providers.find((provider) => provider.providerId === 'opencode')!;
      store.setState({
        cliStatus: {
          ...cliStatus,
          providers: cliStatus.providers.map((provider) =>
            provider.providerId === 'opencode' ? old : provider
          ),
        },
        openCodeRuntimeStatus: { ...ready, version: '1.9.3' },
      });
      // This is the real no-project launch gate, not only a raw capability flag.
      expect(hasEffectiveProviderLaunchAuthority(globalProvider())).toBe(true);
      const previousRead = store.getState().fetchCliProviderStatus('opencode', { silent: true });
      const installation = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      const duringInstall = globalProvider();
      oldRead.resolve(old);
      const oldReadCommitted = await previousRead;
      const afterOldRead = globalProvider();
      installing.resolve(
        outcome === 'failed install'
          ? { ...missing, state: 'failed', error: 'TEST package download failed' }
          : ready
      );
      await installation;

      expect(hasEffectiveProviderLaunchAuthority(duringInstall)).toBe(false);
      expect(duringInstall.capabilities.teamLaunch).toBe(false);
      expect(duringInstall.effectiveDefaultModel).toBeNull();
      expect(duringInstall.modelCatalog?.status).toBe('stale');
      expect(oldReadCommitted).toBe(false);
      expect(afterOldRead).toBe(duringInstall);
      expect(hasEffectiveProviderLaunchAuthority(globalProvider())).toBe(
        outcome === 'fresh refresh'
      );
      expect(getProviderStatus).toHaveBeenCalledTimes(outcome === 'fresh refresh' ? 2 : 1);
      expect(
        store
          .getState()
          .cliStatus!.providers.filter((provider) => provider.providerId !== 'opencode')
      ).toEqual(otherProviders);
    }
  );

  it.each([
    ['bootstrap', 'before', 'snapshot', 'authoritative'],
    ['fetch', 'before', 'snapshot', 'authoritative'],
    ['bootstrap', 'during', 'snapshot', 'authoritative'],
    ['fetch', 'during', 'snapshot', 'authoritative'],
    ['bootstrap', 'before', 'error', 'authoritative'],
    ['bootstrap', 'during', 'error', 'authoritative'],
    ['bootstrap', 'fresh', 'snapshot', 'authoritative'],
    ['fetch', 'fresh', 'snapshot', 'authoritative'],
    ['bootstrap', 'during', 'snapshot', 'model_only'],
    ['bootstrap', 'during', 'error', 'model_only'],
  ] as const)(
    'fences OpenCode metadata from %s begun %s install (%s, %s), preserving other hydration',
    async (entryPoint, timing, response, evidence) => {
      const installing = deferred<OpenCodeRuntimeStatus>();
      const metadata = deferred<NonNullable<CliInstallerSlice['cliStatus']>>();
      const { store } = setup({ install: () => installing.promise });
      const old = verifiedOpenCodeProvider();
      if (evidence === 'model_only') {
        old.authenticated = false;
        old.verificationState = 'unknown';
        old.statusCheckOutcome = 'model_only';
        old.capabilities = { ...old.capabilities, teamLaunch: false, oneShot: false };
        old.modelCatalog = { ...old.modelCatalog!, status: 'degraded' };
      }
      const cliStatus = createLoadingMultimodelCliStatus();
      const incoming = {
        ...cliStatus,
        installedVersion: '0.0.147',
        providers: cliStatus.providers.map((provider) =>
          provider.providerId === 'opencode' ? old : provider
        ),
      };
      const getProviderStatus = vi.fn(async (providerId: string) => {
        if (providerId === 'opencode') return old;
        const base = cliStatus.providers.find((provider) => provider.providerId === providerId)!;
        return {
          ...base,
          supported: true,
          verificationState: 'verified',
          statusCheckOutcome: 'authoritative',
          statusCheckErrorCode: undefined,
          models: [`${providerId}/TEST-fresh-hydration`],
        };
      });
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: {
            getStatus: vi.fn(() => metadata.promise),
            getProviderStatus,
          },
        },
      });
      store.setState({
        cliStatus: incoming,
        openCodeRuntimeStatus: { ...ready, version: evidence === 'model_only' ? '2.1.3' : '1.9.3' },
      });
      const readMetadata = (): Promise<void> =>
        entryPoint === 'bootstrap'
          ? store.getState().bootstrapCliStatus()
          : store.getState().fetchCliStatus();
      let reading: Promise<void> | undefined;
      if (timing === 'before') reading = readMetadata();
      const installation = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      if (timing === 'during') reading = readMetadata();
      const initialOpenCodeLoading = store.getState().cliProviderStatusLoading.opencode ?? false;
      installing.resolve({ ...missing, state: 'failed', error: 'TEST download failed' });
      await installation;
      expect(
        hasEffectiveProviderLaunchAuthority(
          store
            .getState()
            .cliStatus!.providers.find((provider) => provider.providerId === 'opencode')
        )
      ).toBe(false);
      if (timing === 'fresh') reading = readMetadata();
      if (response === 'error') metadata.reject(new Error('TEST delayed metadata failed'));
      else metadata.resolve(incoming);
      await reading;
      await Promise.resolve();

      const final = store.getState().cliStatus!;
      expect(initialOpenCodeLoading).toBe(false);
      expect(store.getState().cliProviderStatusLoading.opencode ?? false).toBe(false);
      expect(
        hasEffectiveProviderLaunchAuthority(
          final.providers.find((provider) => provider.providerId === 'opencode')
        )
      ).toBe(timing === 'fresh');
      expect(
        final.providers.find((provider) => provider.providerId === 'anthropic')?.models
      ).toEqual(['anthropic/TEST-fresh-hydration']);
      expect(
        getProviderStatus.mock.calls.filter(([providerId]) => providerId === 'opencode')
      ).toHaveLength(timing === 'fresh' && entryPoint === 'fetch' ? 1 : 0);
      if (response === 'snapshot') expect(final.installedVersion).toBe('0.0.147');
    }
  );

  it.each(['1.9.3', '2.1.3'])(
    'drops project authority and detached reads from native %s without disturbing another provider',
    async (version) => {
      const installing = deferred<OpenCodeRuntimeStatus>();
      const oldRead = deferred<CliProviderStatus>();
      const { store } = setup({ install: () => installing.promise });
      const cliStatus = createLoadingMultimodelCliStatus();
      const base = cliStatus.providers.find((provider) => provider.providerId === 'opencode')!;
      const old: CliProviderStatus = {
        ...base,
        supported: true,
        authenticated: true,
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        capabilities: { ...base.capabilities, teamLaunch: true, oneShot: true },
        models: ['opencode/previous-native'],
      };
      const other = cliStatus.providers.find((provider) => provider.providerId === 'anthropic')!;
      const projectPath = '/TEST/previous-native-project';
      const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
      const otherProjectScopeKey = getCliProviderStatusScopeKey(
        'opencode',
        '/TEST/another-project'
      );
      const otherScopeKey = getCliProviderStatusScopeKey('anthropic', projectPath);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          ...window.electronAPI,
          cliInstaller: {
            invalidateStatus: vi.fn(async () => undefined),
            getProviderStatus: vi.fn(
              async (_provider: string, options?: { projectPath?: string }) =>
                options?.projectPath ? oldRead.promise : { ...old, models: ['opencode/new-native'] }
            ),
          },
        },
      });
      store.setState({
        cliStatus: { ...cliStatus, installed: true },
        openCodeRuntimeStatus: {
          ...ready,
          version,
          v2Support: version.startsWith('1.') ? undefined : 'ready',
        },
        cliProviderStatusByScope: {
          [scopeKey]: old,
          [otherProjectScopeKey]: old,
          [otherScopeKey]: other,
        },
      });
      const previousRead = store.getState().fetchCliProviderStatus('opencode', { projectPath });
      const installation = store.getState().installOpenCodeRuntime({ generation: 'v2' });
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusByScope[otherProjectScopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusByScope[otherScopeKey]).toBe(other);
      oldRead.resolve(old);
      expect(await previousRead).toBe(false);
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toBeUndefined();
      installing.resolve(ready);
      await installation;
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusByScope[otherScopeKey]).toBe(other);
      expect(store.getState().cliProviderStatusByScope[otherProjectScopeKey]).toBeUndefined();
      expect(store.getState().cliProviderStatusScopeRevision).toBe(1);
    }
  );
});
