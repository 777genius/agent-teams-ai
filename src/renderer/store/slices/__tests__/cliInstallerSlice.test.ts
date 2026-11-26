import {
  createCliInstallerSlice,
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
  reconcileCliStatus,
  refreshCodexProviderStatusAfterRuntimeInstall,
} from '@renderer/store/slices/cliInstallerSlice';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';
import type { ElectronAPI } from '@shared/types/api';
import type {
  CliInstallationStatus,
  CliProviderReasoningEffort,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types/cliInstaller';
import type { StateCreator } from 'zustand';

// Keep the real slice and Zustand; only the external preload API is controlled here.
vi.mock('@renderer/api', () => ({
  api: new Proxy(
    {},
    {
      get(_target, property) {
        return Reflect.get(window.electronAPI ?? {}, property);
      },
    }
  ),
  isElectronMode: () => Boolean(window.electronAPI),
}));

function createCliInstallerStore() {
  return createStore<CliInstallerSlice>()(
    createCliInstallerSlice as unknown as StateCreator<CliInstallerSlice>
  );
}

function installElectronApi(openCodeRuntime: ElectronAPI['openCodeRuntime']): () => void {
  const previousApi = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: { openCodeRuntime } as ElectronAPI,
  });
  return () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: previousApi,
    });
  };
}

describe('reconcileCliStatus', () => {
  it('returns the previous status reference when a structurally identical clone arrives', () => {
    // This mirrors the real IPC path: `CliInstallerService.cloneCliInstallationStatus()`
    // (called from `publishStatusSnapshot()`) hands the renderer a fresh
    // `CliInstallationStatus` whose `providers` are also freshly-cloned
    // objects, even when nothing has actually changed. The merge function
    // must compare provider content (not just reference) so that no-op
    // progress ticks do not produce a new `cliStatus` identity and trigger
    // a re-render storm across every consumer.
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns the previous status reference when an authenticated clone arrives', () => {
    const base = createLoadingMultimodelCliStatus();
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'oauth' as const,
      providers: base.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              authenticated: true,
              authMethod: 'oauth' as const,
              supported: true,
              verificationState: 'verified' as const,
              statusCheckOutcome: 'authoritative' as const,
              statusMessage: null,
              models: ['model-a', 'model-b'],
            }
          : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns a new status when an incoming provider field actually differs', () => {
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);
    incoming.providers[0] = {
      ...incoming.providers[0],
      statusMessage: 'Verifying credentials...',
    };

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[0].statusMessage).toBe('Verifying credentials...');
  });

  it('returns current when a structurally identical populated provider clone arrives', () => {
    // Mirrors the real IPC flow with a fully-populated provider: ChatGPT-Codex
    // authenticated, with a model catalog, model availability records,
    // runtime capabilities, available backends, and a selected backend.
    // None of these fields are reference-stable across IPC clones, so the
    // equality guard must compare them by content, not reference.
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      statusMessage: null,
      models: ['gpt-5.2'],
      modelAvailability: [
        {
          modelId: 'gpt-5.2',
          status: 'available' as const,
          checkedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      runtimeCapabilities: {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'] as CliProviderReasoningEffort[],
        },
      },
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
      backend: { kind: 'codex-cli' as const, label: 'Codex CLI' },
    };
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'codex_chatgpt' as const,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).toBe(current);
    expect(merged.providers[1]).toBe(current.providers[1]);
  });

  it('produces a new status when a cloned populated field actually changed', () => {
    // Negative companion to the populated-clone test: confirms that when a
    // cloned DTO field really differs, the merge does NOT preserve the
    // previous reference (i.e. we never let stale data through).
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusCheckOutcome: 'authoritative' as const,
      models: ['gpt-5.2'],
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
    };
    const current = {
      ...base,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);
    // Flip a nested DTO field on the cloned snapshot.
    incoming.providers[1].availableBackends![0].available = false;

    const merged = reconcileCliStatus(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[1]).not.toBe(current.providers[1]);
    expect(merged.providers[1].availableBackends?.[0].available).toBe(false);
  });

  it.each([
    ['stale', 'anthropic'],
    ['ready', 'codex'],
  ] as const)(
    'preserves status authentication but fails launch closed for a %s catalog owned by %s',
    (catalogStatus, catalogProviderId) => {
      const incoming = createLoadingMultimodelCliStatus();
      incoming.authLoggedIn = true;
      incoming.authMethod = 'oauth';
      incoming.providers[0] = {
        ...incoming.providers[0],
        supported: true,
        authenticated: true,
        authMethod: 'oauth',
        verificationState: 'verified',
        statusCheckOutcome: 'authoritative',
        capabilities: { ...incoming.providers[0].capabilities, teamLaunch: true },
        runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'runtime' } },
        modelCatalog: {
          schemaVersion: 1,
          providerId: catalogProviderId,
          source: 'app-server',
          status: catalogStatus,
          fetchedAt: '2026-08-29T00:00:00.000Z',
          staleAt: '2026-08-29T00:10:00.000Z',
          defaultModelId: 'model-a',
          defaultLaunchModel: 'model-a',
          models: [],
          diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
        },
      };

      const merged = reconcileCliStatus(null, incoming);

      expect(merged.authLoggedIn).toBe(true);
      expect(merged.authMethod).toBe('oauth');
      expect(merged.providers[0]).toMatchObject({
        authenticated: true,
        authMethod: 'oauth',
        capabilities: { teamLaunch: false },
        modelCatalog: { providerId: catalogProviderId, status: 'stale' },
      });
    }
  );

  it('retains both model evidence arrays but revokes launch for authoritative exact-empty input', () => {
    const current = createLoadingMultimodelCliStatus();
    current.providers[1] = {
      ...current.providers[1],
      providerId: 'codex',
      supported: true,
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      models: ['old-flat-model'],
      modelAvailability: [
        {
          modelId: 'old-flat-model',
          status: 'available',
          checkedAt: '2026-08-28T00:00:00.000Z',
        },
      ],
      capabilities: { ...current.providers[1].capabilities, teamLaunch: true },
    };
    const incoming = structuredClone(current);
    incoming.providers[1] = {
      ...incoming.providers[1],
      models: [],
      modelAvailability: [],
      modelCatalogRefreshState: 'ready',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        staleAt: '2100-01-01T00:00:00.000Z',
        defaultModelId: null,
        defaultLaunchModel: null,
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };

    const merged = reconcileCliStatus(current, incoming);

    expect(merged.providers[1]).toMatchObject({
      authenticated: true,
      authMethod: 'chatgpt',
      capabilities: { teamLaunch: false },
      models: ['old-flat-model'],
      modelAvailability: [{ modelId: 'old-flat-model', status: 'available' }],
      modelCatalog: { status: 'stale', defaultModelId: null },
      modelCatalogRefreshState: 'error',
    });
  });

  it('retains both model evidence arrays and revokes launch for non-authoritative exact-empty input', () => {
    const current = createLoadingMultimodelCliStatus();
    current.providers[1] = {
      ...current.providers[1],
      supported: true,
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      models: ['old-flat-model'],
      modelAvailability: [
        {
          modelId: 'old-flat-model',
          status: 'available',
          checkedAt: '2026-08-28T00:00:00.000Z',
        },
      ],
      capabilities: { ...current.providers[1].capabilities, teamLaunch: true },
    };
    const incoming = structuredClone(current);
    incoming.providers[1] = {
      ...incoming.providers[1],
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusCheckOutcome: 'transient_error',
      models: [],
      modelAvailability: [],
      modelCatalogRefreshState: 'ready',
      runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-08-29T00:00:00.000Z',
        staleAt: '2026-08-29T00:10:00.000Z',
        defaultModelId: null,
        defaultLaunchModel: null,
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    };

    const merged = reconcileCliStatus(current, incoming);

    expect(merged.providers[1]).toMatchObject({
      authenticated: false,
      authMethod: null,
      capabilities: { teamLaunch: false },
      models: ['old-flat-model'],
      modelAvailability: [{ modelId: 'old-flat-model', status: 'available' }],
      modelCatalog: { status: 'stale' },
      modelCatalogRefreshState: 'error',
    });
  });
});

describe('OpenCode runtime rejection state', () => {
  it('surfaces a rejected status check as failed without discarding known runtime identity', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('runtime status IPC unavailable');
      },
      install: async () => {
        throw new Error('not used');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();
    store.setState({
      openCodeRuntimeStatus: {
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.16.0',
        source: 'path',
        state: 'ready',
      },
    });

    try {
      await store.getState().fetchOpenCodeRuntimeStatus();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'runtime status IPC unavailable',
        openCodeRuntimeStatus: {
          installed: true,
          binaryPath: '/known/opencode',
          version: '1.16.0',
          source: 'path',
          state: 'failed',
          error: 'runtime status IPC unavailable',
          progress: {
            phase: 'failed',
            detail: 'runtime status IPC unavailable',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });

  it('forwards an explicit V2 install choice through the bridge', async () => {
    const install = vi.fn().mockResolvedValue({
      installed: false,
      source: 'missing',
      state: 'failed',
      error: 'TEST expected failure',
    });
    const restoreApi = installElectronApi({
      getStatus: async () => ({ installed: false, source: 'missing', state: 'idle' }),
      install,
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    try {
      await createCliInstallerStore().getState().installOpenCodeRuntime({ generation: 'v2' });
      expect(install).toHaveBeenCalledWith({ generation: 'v2' });
    } finally {
      restoreApi();
    }
  });

  it('replaces the temporary checking state with failed when installation rejects', async () => {
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('not used');
      },
      install: async () => {
        throw new Error('download connection lost');
      },
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();

    try {
      await store.getState().installOpenCodeRuntime();

      expect(store.getState()).toMatchObject({
        openCodeRuntimeStatusLoading: false,
        openCodeRuntimeError: 'download connection lost',
        openCodeRuntimeStatus: {
          installed: false,
          source: 'missing',
          state: 'failed',
          error: 'download connection lost',
          progress: {
            phase: 'failed',
            detail: 'download connection lost',
          },
        },
      });
    } finally {
      restoreApi();
      vi.mocked(console.error).mockClear();
    }
  });

  it('keeps a working runtime usable while its update request is checking and then fails', async () => {
    let resolveInstall!: (status: OpenCodeRuntimeStatus) => void;
    const installResult = new Promise<OpenCodeRuntimeStatus>((resolve) => {
      resolveInstall = resolve;
    });
    const restoreApi = installElectronApi({
      getStatus: async () => {
        throw new Error('not used');
      },
      install: () => installResult,
      invalidateStatus: async () => undefined,
      onProgress: () => () => undefined,
    });
    const store = createCliInstallerStore();
    store.setState({
      openCodeRuntimeStatus: {
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.18.1',
        latestVersion: '1.18.32',
        updateAvailable: true,
        source: 'app-managed',
        state: 'ready',
      },
    });

    try {
      const request = store.getState().installOpenCodeRuntime();
      expect(store.getState().openCodeRuntimeStatus).toMatchObject({
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.18.1',
        latestVersion: '1.18.32',
        updateAvailable: true,
        source: 'app-managed',
        state: 'checking',
      });

      resolveInstall({
        installed: true,
        binaryPath: '/known/opencode',
        version: '1.18.1',
        latestVersion: '1.18.32',
        updateAvailable: true,
        source: 'app-managed',
        state: 'failed',
        error: 'registry unavailable',
      });
      await request;

      expect(store.getState().openCodeRuntimeStatus).toMatchObject({
        installed: true,
        binaryPath: '/known/opencode',
        source: 'app-managed',
        state: 'failed',
        latestVersion: '1.18.32',
        updateAvailable: true,
        error: 'registry unavailable',
      });
    } finally {
      restoreApi();
    }
  });
});

describe('provider status loading ownership', () => {
  function pendingStatusStore() {
    const store = createCliInstallerStore();
    const previousApi = window.electronAPI;
    const base = createLoadingMultimodelCliStatus();
    const ready = (
      model: string,
      providerId: CliProviderStatus['providerId'] = 'opencode'
    ): CliProviderStatus => ({
      ...base.providers.find((provider) => provider.providerId === providerId)!,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: undefined,
      statusMessage: null,
      capabilities: {
        ...base.providers.find((provider) => provider.providerId === providerId)!.capabilities,
        teamLaunch: true,
      },
      models: [model],
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId,
        source: 'app-server',
        status: 'ready',
        fetchedAt: new Date().toISOString(),
        staleAt: new Date(Date.now() + 60_000).toISOString(),
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
    });
    const responses: {
      resolve: (value: CliProviderStatus) => void;
      reject: (reason: unknown) => void;
    }[] = [];
    const reads: Promise<boolean>[] = [];
    const getProviderStatus = vi.fn(
      () => new Promise<CliProviderStatus>((resolve, reject) => responses.push({ resolve, reject }))
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus, invalidateStatus: vi.fn(async () => undefined) },
      },
    });
    store.setState({
      cliStatus: { ...base, installed: true, providers: [ready('opencode/global-previous')] },
    });
    return {
      store,
      ready,
      responses,
      getProviderStatus,
      fetch(
        options: Parameters<CliInstallerSlice['fetchCliProviderStatus']>[1],
        providerId: CliProviderStatus['providerId'] = 'opencode'
      ) {
        const read = store.getState().fetchCliProviderStatus(providerId, options);
        reads.push(read);
        return read;
      },
      async cleanup() {
        for (const response of responses) response.resolve(ready('opencode/cleanup'));
        await Promise.allSettled(reads);
        store.setState({ cliStatus: null });
        try {
          await store.getState().invalidateCliStatus();
        } finally {
          Object.defineProperty(window, 'electronAPI', {
            configurable: true,
            writable: true,
            value: previousApi,
          });
        }
      },
    };
  }

  it('keeps provider loading while a project request outlives a global request', async () => {
    const fixture = pendingStatusStore();
    const projectPath = '/sandbox/opencode-overlapping-status';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    fixture.store.setState({
      cliProviderStatusByScope: { [scopeKey]: fixture.ready('ollama/project-previous') },
    });
    try {
      const globalRead = fixture.fetch({ silent: false });
      const projectRead = fixture.fetch({ projectPath, silent: false });
      expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(fixture.getProviderStatus).toHaveBeenNthCalledWith(1, 'opencode');
      expect(fixture.getProviderStatus).toHaveBeenNthCalledWith(2, 'opencode', { projectPath });
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
      fixture.responses[0].resolve(fixture.ready('opencode/global-current'));
      await expect(globalRead).resolves.toBe(true);
      const pending = fixture.store.getState();
      expect(pending.cliStatus?.providers[0].models).toEqual(['opencode/global-current']);
      expect(pending.cliProviderStatusByScope[scopeKey]).toMatchObject({
        statusCheckOutcome: 'pending',
        models: ['ollama/project-previous'],
      });
      expect(pending.cliProviderStatusLoading.opencode).toBe(true);
      expect(pending.cliStatus?.authStatusChecking).toBe(true);
      fixture.responses[1].resolve(fixture.ready('ollama/project-current'));
      await expect(projectRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
      expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(false);
      expect(fixture.store.getState().cliProviderStatusByScope[scopeKey]?.models).toEqual([
        'ollama/project-current',
      ]);
      expect(fixture.store.getState().cliStatus?.providers[0].models).toEqual([
        'opencode/global-current',
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['reject', 'invalidate'] as const)(
    'settles aggregate auth after the final project read ends with %s',
    async (outcome) => {
      const fixture = pendingStatusStore();
      const projectPath = '/sandbox/TEST-opencode-auth-settlement';
      try {
        const globalRead = fixture.fetch({ silent: false });
        const projectRead = fixture.fetch({ projectPath });
        fixture.responses[0].resolve(fixture.ready('opencode/global-current'));
        await expect(globalRead).resolves.toBe(true);
        expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(true);
        if (outcome === 'reject') {
          const error = new Error('TEST project status rejected');
          fixture.responses[1].reject(error);
          await expect(projectRead).resolves.toBe(false);
          expect(vi.mocked(console.error).mock.calls).toEqual([
            ['[Store:cliInstaller]', 'Failed to fetch opencode CLI status:', error],
          ]);
          vi.mocked(console.error).mockClear();
        } else {
          fixture.store.getState().invalidateCliProviderModelCatalog({ scopedOnly: true });
          expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(false);
          fixture.responses[1].resolve(fixture.ready('ollama/obsolete-project'));
          await expect(projectRead).resolves.toBe(false);
        }
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).not.toBe(true);
        expect(fixture.store.getState().cliStatus).toMatchObject({
          authStatusChecking: false,
          authLoggedIn: true,
          providers: [{ models: ['opencode/global-current'] }],
        });
      } finally {
        await fixture.cleanup();
      }
    }
  );

  it.each([
    { outcome: 'resolve', successor: false, projectPath: undefined },
    { outcome: 'reject', successor: false, projectPath: '/sandbox/TEST-codex-install-epoch' },
    { outcome: 'resolve', successor: true, projectPath: '/sandbox/TEST-codex-install-epoch' },
    { outcome: 'reject', successor: true, projectPath: undefined },
  ] as const)(
    'retires old-epoch loading on Codex install: $outcome, successor=$successor, scope=$projectPath',
    async ({ outcome, successor, projectPath }) => {
      const fixture = pendingStatusStore();
      const codexReady: CliProviderStatus = {
        ...fixture.ready('codex/installed', 'codex'),
        availableBackends: [
          {
            id: 'codex-native',
            label: 'TEST Codex runtime',
            description: 'TEST app-managed runtime',
            available: true,
            selectable: true,
            recommended: true,
          },
        ],
      };
      let refresh: Promise<void> | undefined;
      try {
        const oldRead = fixture.fetch({ projectPath });
        refresh = refreshCodexProviderStatusAfterRuntimeInstall(fixture.store.getState);
        await vi.waitFor(() => expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2));
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
        expect(fixture.getProviderStatus).toHaveBeenNthCalledWith(2, 'codex');
        fixture.responses[1].resolve(codexReady);
        await refresh;
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).not.toBe(true);
        expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(false);

        const currentRead = successor ? fixture.fetch({ projectPath }) : null;
        if (outcome === 'reject') {
          const error = new Error('TEST retired epoch rejected');
          fixture.responses[0].reject(error);
          await expect(oldRead).resolves.toBe(false);
          expect(vi.mocked(console.error).mock.calls).toEqual([
            ['[Store:cliInstaller]', 'Failed to fetch opencode CLI status:', error],
          ]);
          vi.mocked(console.error).mockClear();
        } else {
          fixture.responses[0].resolve(fixture.ready('opencode/obsolete-epoch'));
          await expect(oldRead).resolves.toBe(false);
        }
        expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(successor);
        expect(fixture.store.getState().cliStatus?.providers[0].models).toEqual([
          'opencode/global-previous',
        ]);
        if (currentRead) {
          expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
          fixture.responses[2].resolve(fixture.ready('opencode/current-epoch'));
          await expect(currentRead).resolves.toBe(true);
        }
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).not.toBe(true);
        expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(false);
      } finally {
        fixture.responses[1]?.resolve(codexReady);
        try {
          await refresh;
        } finally {
          await fixture.cleanup();
        }
      }
    }
  );

  it.each([false, true])(
    'retires whole-status ownership on Codex install without disturbing a successor=%s',
    async (successor) => {
      const fixture = pendingStatusStore();
      const metadataResponses: ((status: CliInstallationStatus) => void)[] = [];
      const metadataReads: Promise<void>[] = [];
      const getStatus = vi.fn(
        () => new Promise<CliInstallationStatus>((resolve) => metadataResponses.push(resolve))
      );
      Object.assign(window.electronAPI!.cliInstaller, { getStatus });
      const codexReady: CliProviderStatus = {
        ...fixture.ready('codex/installed', 'codex'),
        availableBackends: [
          {
            id: 'codex-native',
            label: 'TEST Codex runtime',
            description: 'TEST app-managed runtime',
            available: true,
            selectable: true,
            recommended: true,
          },
        ],
      };
      const currentMetadata: CliInstallationStatus = {
        ...createLoadingMultimodelCliStatus(),
        installed: false,
        launchError: 'TEST current metadata',
      };
      let refresh: Promise<void> | undefined;
      try {
        const oldRead = fixture.store.getState().fetchCliStatus();
        metadataReads.push(oldRead);
        expect(fixture.store.getState().cliStatusLoading).toBe(true);
        refresh = refreshCodexProviderStatusAfterRuntimeInstall(fixture.store.getState);
        await vi.waitFor(() => expect(fixture.getProviderStatus).toHaveBeenCalledTimes(1));
        fixture.responses[0].resolve(codexReady);
        await refresh;
        expect(fixture.store.getState().cliStatusLoading).toBe(false);
        const currentRead = successor ? fixture.store.getState().fetchCliStatus() : null;
        if (currentRead) metadataReads.push(currentRead);
        expect(getStatus).toHaveBeenCalledTimes(successor ? 2 : 1);
        metadataResponses[0]({ ...currentMetadata, launchError: 'TEST obsolete metadata' });
        await oldRead;
        expect(fixture.store.getState().cliStatusLoading).toBe(successor);
        expect(fixture.store.getState().cliStatus?.launchError).toBeNull();
        if (currentRead) {
          metadataResponses[1](currentMetadata);
          await currentRead;
          expect(fixture.store.getState().cliStatus?.launchError).toBe('TEST current metadata');
        }
        expect(fixture.store.getState().cliStatusLoading).toBe(false);
      } finally {
        fixture.responses[0]?.resolve(codexReady);
        for (const resolve of metadataResponses) resolve(currentMetadata);
        try {
          await Promise.all([...metadataReads, refresh]);
        } finally {
          await fixture.cleanup();
        }
      }
    }
  );

  it.each(['invalidation', 'provider', 'retry-delay'] as const)(
    'does not let an install refresh superseded during %s adopt a newer invalidation',
    async (stage) => {
      vi.useFakeTimers();
      const fixture = pendingStatusStore();
      const invalidateStatus = vi.mocked(window.electronAPI!.cliInstaller.invalidateStatus);
      let acknowledgeOld!: () => void;
      let acknowledgeNew!: () => void;
      const oldAcknowledgement = new Promise<void>((resolve) => {
        acknowledgeOld = resolve;
      });
      const newAcknowledgement = new Promise<void>((resolve) => {
        acknowledgeNew = resolve;
      });
      const codexReady: CliProviderStatus = {
        ...fixture.ready('codex/installed', 'codex'),
        availableBackends: [
          {
            id: 'codex-native',
            label: 'TEST Codex runtime',
            description: 'TEST app-managed runtime',
            available: true,
            selectable: true,
            recommended: true,
          },
        ],
      };
      if (stage === 'invalidation') invalidateStatus.mockReturnValueOnce(oldAcknowledgement);
      else invalidateStatus.mockResolvedValueOnce(undefined);
      invalidateStatus.mockReturnValueOnce(newAcknowledgement);
      let refresh: Promise<void> | undefined;
      let newerInvalidation: Promise<void> | undefined;
      try {
        refresh = refreshCodexProviderStatusAfterRuntimeInstall(fixture.store.getState);
        await vi.advanceTimersByTimeAsync(0);
        if (stage === 'retry-delay') {
          fixture.responses[0].resolve(fixture.ready('codex/not-installed', 'codex'));
          await vi.advanceTimersByTimeAsync(0);
          expect(vi.getTimerCount()).toBe(1);
        }
        const providersBeforeInvalidation = fixture.store.getState().cliStatus?.providers;
        newerInvalidation = fixture.store.getState().invalidateCliStatus();
        acknowledgeOld();
        if (stage === 'provider') fixture.responses[0].resolve(codexReady);
        await vi.advanceTimersByTimeAsync(700);
        expect(invalidateStatus).toHaveBeenCalledTimes(2);
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(stage === 'invalidation' ? 0 : 1);
        expect(fixture.store.getState().cliProviderStatusLoading.codex).not.toBe(true);
        expect(fixture.store.getState().cliStatus?.providers).toEqual(providersBeforeInvalidation);
        await refresh;
      } finally {
        acknowledgeOld();
        acknowledgeNew();
        fixture.getProviderStatus.mockResolvedValue(codexReady);
        for (const response of fixture.responses) response.resolve(codexReady);
        try {
          await vi.advanceTimersByTimeAsync(2_100);
          await Promise.all([refresh, newerInvalidation]);
        } finally {
          await fixture.cleanup();
          vi.useRealTimers();
        }
      }
    }
  );

  it('keeps an independent silent global read quiet', async () => {
    const fixture = pendingStatusStore();
    try {
      const read = fixture.fetch({ silent: true });
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBeUndefined();
      fixture.responses[0].resolve(fixture.ready('opencode/quiet-current'));
      await expect(read).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not transfer project loading to an independent silent global read', async () => {
    const fixture = pendingStatusStore();
    try {
      const projectRead = fixture.fetch({
        projectPath: '/sandbox/opencode-silent-project',
        silent: true,
      });
      const globalRead = fixture.fetch({ silent: true });
      expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
      fixture.responses[0].resolve(fixture.ready('ollama/project-current'));
      await expect(projectRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
      fixture.responses[1].resolve(fixture.ready('opencode/quiet-current'));
      await expect(globalRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps a visible global request loading when the project response finishes first', async () => {
    const fixture = pendingStatusStore();
    try {
      const globalRead = fixture.fetch({ silent: false });
      const projectRead = fixture.fetch({
        projectPath: '/sandbox/opencode-project-first',
        silent: false,
      });
      fixture.responses[1].resolve(fixture.ready('ollama/project-current'));
      await expect(projectRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
      expect(fixture.store.getState().cliStatus?.providers[0].models).toEqual([
        'opencode/global-previous',
      ]);
      fixture.responses[0].resolve(fixture.ready('opencode/global-current'));
      await expect(globalRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps project loading when the visible global request rejects', async () => {
    const fixture = pendingStatusStore();
    try {
      const globalRead = fixture.fetch({ silent: false });
      const projectRead = fixture.fetch({
        projectPath: '/sandbox/opencode-after-global-rejection',
        silent: false,
      });
      const error = new Error('TEST global status rejected');
      fixture.responses[0].reject(error);
      await expect(globalRead).resolves.toBe(false);
      expect(vi.mocked(console.error).mock.calls).toEqual([
        ['[Store:cliInstaller]', 'Failed to fetch opencode CLI status:', error],
      ]);
      vi.mocked(console.error).mockClear();
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
      fixture.responses[1].resolve(fixture.ready('ollama/project-current'));
      await expect(projectRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not keep OpenCode loading for a different pending provider', async () => {
    const fixture = pendingStatusStore();
    try {
      const codexRead = fixture.fetch({ silent: false }, 'codex');
      const openCodeRead = fixture.fetch({ silent: false });
      fixture.responses[1].resolve(fixture.ready('opencode/current'));
      await expect(openCodeRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading).toMatchObject({
        opencode: false,
        codex: true,
      });
      fixture.responses[0].resolve(fixture.ready('codex/current', 'codex'));
      await expect(codexRead).resolves.toBe(true);
      expect(fixture.store.getState().cliProviderStatusLoading.codex).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([true, false])(
    'retires only project loading while a global request remains silent=%s',
    async (silent) => {
      const fixture = pendingStatusStore();
      const projectPath = '/sandbox/opencode-retired-project';
      try {
        const projectRead = fixture.fetch({ projectPath, silent: true });
        const globalRead = fixture.fetch({ silent });
        fixture.store.getState().invalidateCliProviderModelCatalog({ scopedOnly: true });
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(
          silent ? undefined : true
        );
        expect(fixture.store.getState().cliStatus?.authStatusChecking).toBe(!silent);
        fixture.responses[0].resolve(fixture.ready('ollama/obsolete-project'));
        await expect(projectRead).resolves.toBe(false);
        expect(fixture.store.getState().cliProviderStatusByScope).not.toHaveProperty(
          getCliProviderStatusScopeKey('opencode', projectPath)
        );
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(
          silent ? undefined : true
        );
        fixture.responses[1].resolve(fixture.ready('opencode/global-current'));
        await expect(globalRead).resolves.toBe(true);
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(
          silent ? undefined : false
        );
      } finally {
        await fixture.cleanup();
      }
    }
  );

  it.each(['old-first', 'new-first'] as const)(
    'settles visible loading when a silent model request supersedes it (%s)',
    async (order) => {
      const fixture = pendingStatusStore();
      try {
        const oldRead = fixture.fetch({ silent: false });
        const currentRead = fixture.fetch({ silent: true, requireModelList: true });
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
        if (order === 'old-first') {
          fixture.responses[0].resolve(fixture.ready('opencode/obsolete'));
          await expect(oldRead).resolves.toBe(false);
          expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(true);
          expect(fixture.store.getState().cliStatus?.providers[0].models).toEqual([
            'opencode/global-previous',
          ]);
        }
        fixture.responses[1].resolve(fixture.ready('opencode/newest'));
        await expect(currentRead).resolves.toBe(true);
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
        fixture.responses[0].resolve(fixture.ready('opencode/obsolete'));
        await expect(oldRead).resolves.toBe(false);
        expect(fixture.store.getState().cliProviderStatusLoading.opencode).toBe(false);
        expect(fixture.store.getState().cliStatus?.providers[0].models).toEqual([
          'opencode/newest',
        ]);
      } finally {
        await fixture.cleanup();
      }
    }
  );
});

describe('provider catalog invalidation races', () => {
  it('settles an OpenCode partial response after the bounded retry', async () => {
    const previousApi = window.electronAPI;
    const partial = {
      ...createLoadingMultimodelCliStatus().providers.find(
        (provider) => provider.providerId === 'opencode'
      )!,
      statusCheckOutcome: 'pending' as const,
      statusCheckErrorCode: 'partial_response' as const,
    };
    const getProviderStatus = vi.fn(async () => partial);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { cliInstaller: { getProviderStatus, verifyProviderModels: vi.fn() } },
    });
    const store = createCliInstallerStore();
    const projectPath = '/sandbox/opencode-picker-test';
    const scopeKey = getCliProviderStatusScopeKey('opencode', projectPath);
    const cached = {
      ...partial,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: undefined,
      modelCatalogRefreshState: 'ready',
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'opencode',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-09-27T00:00:00.000Z',
        staleAt: '2026-09-27T00:05:00.000Z',
        defaultModelId: null,
        defaultLaunchModel: null,
        models: [],
        diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      },
    } as CliProviderStatus;
    store.setState({
      cliStatus: { ...createLoadingMultimodelCliStatus(), installed: true },
      cliProviderStatusByScope: { [scopeKey]: cached },
    });
    try {
      await store.getState().fetchCliProviderStatus('opencode', {
        projectPath,
      });
      expect(getProviderStatus).toHaveBeenCalledTimes(2);
      expect(store.getState().cliProviderStatusByScope[scopeKey]).toMatchObject({
        statusCheckOutcome: 'transient_error',
        statusCheckErrorCode: 'partial_response',
        modelCatalogRefreshState: 'error',
        modelCatalog: { status: 'stale' },
        capabilities: { teamLaunch: false },
      });
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });

  it('clears fenced provider loading without allowing the old request to settle it later', async () => {
    let resolveStatus!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveStatus = resolve;
    });
    const previousApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: { getProviderStatus: vi.fn(() => pending), verifyProviderModels: vi.fn() },
      },
    });
    const store = createCliInstallerStore();
    store.setState({ cliStatus: { ...createLoadingMultimodelCliStatus(), installed: true } });
    try {
      const request = store.getState().fetchCliProviderStatus('codex');
      expect(store.getState().cliProviderStatusLoading.codex).toBe(true);
      store.getState().invalidateCliProviderModelCatalog();
      expect(store.getState().cliProviderStatusLoading.codex).toBeUndefined();
      expect(store.getState().cliStatus?.authStatusChecking).toBe(false);
      resolveStatus({
        providerId: 'codex',
        models: [],
        supported: true,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        statusCheckOutcome: 'authoritative',
        modelCatalogRefreshState: 'ready',
        capabilities: { teamLaunch: false, oneShot: false, extensions: {} },
      });
      await request;
      expect(store.getState().cliProviderStatusLoading.codex).toBeUndefined();
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
    }
  });
});

describe('codex catalog watchdog races', () => {
  it.each([false, true])(
    'retries a loading catalog with retained cache=%s',
    async (retainedCache) => {
      vi.useFakeTimers();
      const provider = {
        ...createLoadingMultimodelCliStatus().providers.find(
          (item) => item.providerId === 'codex'
        )!,
        modelCatalog: retainedCache
          ? {
              schemaVersion: 1 as const,
              providerId: 'codex',
              source: 'app-server' as const,
              status: 'stale' as const,
              fetchedAt: '2026-09-01T00:00:00.000Z',
              staleAt: '2026-09-01T00:05:00.000Z',
              defaultModelId: null,
              defaultLaunchModel: null,
              models: [],
              diagnostics: {
                configReadState: 'skipped' as const,
                appServerState: 'healthy' as const,
              },
            }
          : null,
        modelCatalogRefreshState: 'loading' as const,
        runtimeCapabilities: { modelCatalog: { dynamic: true } },
      };
      const previousApi = window.electronAPI;
      const getProviderStatus = vi.fn().mockResolvedValue(provider);
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: {
          cliInstaller: { getProviderStatus, invalidateStatus: vi.fn(async () => undefined) },
        },
      });
      const store = createCliInstallerStore();
      store.setState({ cliStatus: { ...createLoadingMultimodelCliStatus(), installed: true } });
      try {
        await store.getState().fetchCliProviderStatus('codex');
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(getProviderStatus).toHaveBeenCalledTimes(7);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(getProviderStatus).toHaveBeenCalledTimes(7);
      } finally {
        store.setState({ cliStatus: null });
        await store.getState().invalidateCliStatus();
        Object.defineProperty(window, 'electronAPI', {
          configurable: true,
          writable: true,
          value: previousApi,
        });
        vi.useRealTimers();
      }
    }
  );

  it('keeps the newer retry timer when an older request rejects', async () => {
    vi.useFakeTimers();
    let rejectFirst!: (reason?: unknown) => void;
    const first = new Promise((_, reject) => {
      rejectFirst = reject;
    });
    let resolveSecond!: (value: unknown) => void;
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const previousApi = window.electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        cliInstaller: {
          getProviderStatus: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
          invalidateStatus: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
    const store = createCliInstallerStore();
    store.setState({ cliStatus: { ...createLoadingMultimodelCliStatus(), installed: true } });
    try {
      const oldRequest = store.getState().fetchCliProviderStatus('codex');
      store.getState().invalidateCliProviderModelCatalog();
      const newerRequest = store.getState().fetchCliProviderStatus('codex');
      const provider = {
        ...createLoadingMultimodelCliStatus().providers.find(
          (item) => item.providerId === 'codex'
        )!,
        modelCatalog: null,
        modelCatalogRefreshState: 'loading' as const,
        runtimeCapabilities: { modelCatalog: { dynamic: true } },
      };
      resolveSecond(provider);
      await newerRequest;
      expect(vi.getTimerCount()).toBe(1);
      rejectFirst(new Error('superseded'));
      await oldRequest;
      vi.mocked(console.error).mockClear();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      store.setState({ cliStatus: null });
      await store.getState().invalidateCliStatus();
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        writable: true,
        value: previousApi,
      });
      vi.useRealTimers();
    }
  });
});

describe('Codex catalog retry after main invalidation', () => {
  function installLoadingCodex() {
    vi.useFakeTimers();
    const status = createLoadingMultimodelCliStatus();
    const previousApi = window.electronAPI;
    const getProviderStatus = vi.fn((providerId: string) =>
      Promise.resolve({
        ...status.providers.find((provider) => provider.providerId === providerId)!,
        supported: true,
        statusCheckOutcome: 'authoritative' as const,
        modelCatalog: null,
        modelCatalogRefreshState:
          providerId === 'codex' ? ('loading' as const) : ('ready' as const),
        runtimeCapabilities: { modelCatalog: { dynamic: true } },
      })
    );
    const invalidateStatus = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { cliInstaller: { getProviderStatus, invalidateStatus } },
    });
    const store = createCliInstallerStore();
    store.setState({ cliStatus: status });
    return {
      store,
      getProviderStatus,
      invalidateStatus,
      cleanup: async () => {
        store.setState({ cliStatus: null });
        invalidateStatus.mockResolvedValue(undefined);
        await store.getState().invalidateCliStatus();
        Object.defineProperty(window, 'electronAPI', {
          configurable: true,
          writable: true,
          value: previousApi,
        });
        vi.useRealTimers();
      },
    };
  }

  it.each(['anthropic', 'opencode'] as const)(
    'restores a loading Codex retry after the main acknowledgement and %s refresh',
    async (providerId) => {
      const fixture = installLoadingCodex();
      let acknowledge!: () => void;
      const acknowledgement = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      try {
        await fixture.store.getState().fetchCliProviderStatus('codex');
        fixture.invalidateStatus.mockReturnValueOnce(acknowledgement);
        const invalidation = fixture.store.getState().invalidateCliStatus();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        acknowledge();
        await invalidation;
        await fixture.store.getState().fetchCliProviderStatus(providerId);
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.getProviderStatus.mock.calls.map(([id]) => id)).toEqual([
          'codex',
          providerId,
          'codex',
        ]);
      } finally {
        acknowledge();
        await fixture.cleanup();
      }
    }
  );

  it('does not restore retries after a rejected main invalidation', async () => {
    const fixture = installLoadingCodex();
    try {
      await fixture.store.getState().fetchCliProviderStatus('codex');
      fixture.invalidateStatus.mockRejectedValueOnce(new Error('Main invalidation failed'));
      await expect(fixture.store.getState().invalidateCliStatus()).rejects.toThrow(
        'Main invalidation failed'
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.getProviderStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['pending', 'rejected'] as const)(
    'does not let an old Codex success restore retries while main invalidation is %s',
    async (invalidationState) => {
      const fixture = installLoadingCodex();
      let resolveOldStatus!: (value: unknown) => void;
      const oldStatus = new Promise((resolve) => {
        resolveOldStatus = resolve;
      });
      let acknowledge!: () => void;
      let rejectAcknowledgement!: (error: Error) => void;
      const acknowledgement = new Promise<void>((resolve, reject) => {
        acknowledge = resolve;
        rejectAcknowledgement = reject;
      });
      try {
        await fixture.store.getState().fetchCliProviderStatus('codex');
        const retainedProvider = fixture.store
          .getState()
          .cliStatus!.providers.find((provider) => provider.providerId === 'codex')!;
        fixture.getProviderStatus.mockReturnValueOnce(oldStatus as never);
        const oldRefresh = fixture.store.getState().fetchCliProviderStatus('codex');
        fixture.invalidateStatus.mockReturnValueOnce(acknowledgement);
        const invalidation = fixture.store.getState().invalidateCliStatus();
        const settledInvalidation = invalidation.catch(() => undefined);
        if (invalidationState === 'rejected') {
          rejectAcknowledgement(new Error('Main invalidation failed'));
          await settledInvalidation;
        }

        resolveOldStatus(retainedProvider);
        await expect(oldRefresh).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);

        acknowledge();
        await settledInvalidation;
      } finally {
        acknowledge();
        await fixture.cleanup();
      }
    }
  );

  it.each(['pending', 'rejected'] as const)(
    'does not let old bootstrap metadata restore retries while main invalidation is %s',
    async (invalidationState) => {
      const fixture = installLoadingCodex();
      let resolveOldMetadata!: (value: unknown) => void;
      const oldMetadata = new Promise((resolve) => {
        resolveOldMetadata = resolve;
      });
      let acknowledge!: () => void;
      let rejectAcknowledgement!: (error: Error) => void;
      const acknowledgement = new Promise<void>((resolve, reject) => {
        acknowledge = resolve;
        rejectAcknowledgement = reject;
      });
      try {
        await fixture.store.getState().fetchCliProviderStatus('codex');
        const retainedMetadata = fixture.store.getState().cliStatus!;
        Object.assign(window.electronAPI.cliInstaller, {
          getStatus: vi.fn().mockReturnValueOnce(oldMetadata),
        });
        const oldBootstrap = fixture.store.getState().bootstrapCliStatus({
          multimodelEnabled: true,
          providerStatusMode: 'defer',
        });
        fixture.invalidateStatus.mockReturnValueOnce(acknowledgement);
        const invalidation = fixture.store.getState().invalidateCliStatus();
        const settledInvalidation = invalidation.catch(() => undefined);
        if (invalidationState === 'rejected') {
          rejectAcknowledgement(new Error('Main invalidation failed'));
          await settledInvalidation;
        }

        resolveOldMetadata(retainedMetadata);
        await oldBootstrap;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.getProviderStatus).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        acknowledge();
        await settledInvalidation;
      } finally {
        acknowledge();
        await fixture.cleanup();
      }
    }
  );

  it('does not restore retries while a newer main invalidation is pending', async () => {
    const fixture = installLoadingCodex();
    let acknowledgeOld!: () => void;
    let acknowledgeNew!: () => void;
    const oldAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeOld = resolve;
    });
    const newAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeNew = resolve;
    });
    try {
      await fixture.store.getState().fetchCliProviderStatus('codex');
      fixture.invalidateStatus
        .mockReturnValueOnce(oldAcknowledgement)
        .mockReturnValueOnce(newAcknowledgement);
      const oldInvalidation = fixture.store.getState().invalidateCliStatus();
      const newInvalidation = fixture.store.getState().invalidateCliStatus();
      acknowledgeOld();
      await oldInvalidation;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.getProviderStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      acknowledgeNew();
      await newInvalidation;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.getProviderStatus.mock.calls.map(([id]) => id)).toEqual(['codex', 'codex']);
    } finally {
      acknowledgeOld();
      acknowledgeNew();
      await fixture.cleanup();
    }
  });
});
