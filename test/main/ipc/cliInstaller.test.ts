import { beforeEach, describe, expect, it, vi } from 'vitest';

const claudeBinaryResolverClearCacheMock = vi.hoisted(() => vi.fn());
const codexBinaryResolverClearCacheMock = vi.hoisted(() => vi.fn());

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    clearCache: claudeBinaryResolverClearCacheMock,
  },
}));

vi.mock('@main/services/infrastructure/codexAppServer', () => ({
  CodexBinaryResolver: {
    clearCache: codexBinaryResolverClearCacheMock,
  },
}));

import {
  initializeCliInstallerHandlers,
  registerCliInstallerHandlers,
} from '@main/ipc/cliInstaller';
import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
} from '@preload/constants/ipcChannels';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliInstallerService } from '@main/services';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createMockIpcMain(): IpcMain & {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for ${channel}`);
      }
      return await Promise.resolve(handler({} as IpcMainInvokeEvent, ...args));
    },
  };
  return ipcMain as unknown as IpcMain & {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

function provider(overrides: Partial<CliProviderStatus> & { providerId: CliProviderId }): CliProviderStatus {
  const { providerId, ...rest } = overrides;
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    modelVerificationState: 'idle',
    modelCatalogRefreshState: 'idle',
    statusMessage: null,
    detailMessage: null,
    models: [],
    modelAvailability: [],
    canLoginFromUi: providerId !== 'opencode',
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: null,
    modelCatalog: null,
    runtimeCapabilities: null,
    subscriptionRateLimits: null,
    ...rest,
  };
}

function status(providers: CliProviderStatus[]): CliInstallationStatus {
  const authenticatedProvider = providers.find((entry) => entry.authenticated) ?? null;
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: '0.0.3',
    binaryPath: '/mock/agent_teams_orchestrator',
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: authenticatedProvider !== null,
    authStatusChecking: false,
    authMethod: authenticatedProvider?.authMethod ?? null,
    providers,
  };
}

describe('cliInstaller IPC handlers', () => {
  let ipcMain: ReturnType<typeof createMockIpcMain>;
  let service: {
    getLatestStatusSnapshot: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getProviderStatus: ReturnType<typeof vi.fn>;
    verifyProviderModels: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    invalidateStatusCache: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ipcMain = createMockIpcMain();
    service = {
      getLatestStatusSnapshot: vi.fn(() => null),
      getStatus: vi.fn(),
      getProviderStatus: vi.fn(),
      verifyProviderModels: vi.fn(),
      install: vi.fn(),
      invalidateStatusCache: vi.fn(),
    };
    initializeCliInstallerHandlers(service as unknown as CliInstallerService);
    registerCliInstallerHandlers(ipcMain);
    await ipcMain.invoke(CLI_INSTALLER_INVALIDATE_STATUS);
    vi.clearAllMocks();
  });

  it('does not let explicit hidden Gemini refresh poison cached frontend auth status', async () => {
    service.getStatus.mockResolvedValue(
      status([
        provider({ providerId: 'anthropic' }),
        provider({ providerId: 'codex' }),
        provider({ providerId: 'opencode', canLoginFromUi: false }),
      ])
    );
    service.getProviderStatus.mockResolvedValue(
      provider({
        providerId: 'gemini',
        authenticated: true,
        authMethod: 'gemini_api_key',
        models: ['gemini-2.5-pro'],
      })
    );

    const initial = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    expect(initial.success).toBe(true);
    expect(initial.data?.providers.map((entry) => entry.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);

    const gemini = (await ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'gemini'
    )) as IpcResult<CliProviderStatus | null>;
    expect(gemini.success).toBe(true);
    expect(gemini.data?.authenticated).toBe(true);

    const cached = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    expect(service.getStatus).toHaveBeenCalledTimes(1);
    expect(cached.success).toBe(true);
    expect(cached.data?.providers.map((entry) => entry.providerId)).toEqual([
      'anthropic',
      'codex',
      'opencode',
    ]);
    expect(cached.data?.authLoggedIn).toBe(false);
    expect(cached.data?.authMethod).toBeNull();
  });

  it('clears Claude and Codex binary resolver caches when status is invalidated', async () => {
    const result = (await ipcMain.invoke(CLI_INSTALLER_INVALIDATE_STATUS)) as IpcResult<void>;

    expect(result.success).toBe(true);
    expect(claudeBinaryResolverClearCacheMock).toHaveBeenCalledTimes(1);
    expect(codexBinaryResolverClearCacheMock).toHaveBeenCalledTimes(1);
    expect(service.invalidateStatusCache).toHaveBeenCalledTimes(1);
  });

  it('serializes non-OpenCode provider runtime status requests to avoid startup memory spikes', async () => {
    const anthropicRequest = deferred<CliProviderStatus>();
    const codexRequest = deferred<CliProviderStatus>();
    const startedProviders: CliProviderId[] = [];
    service.getProviderStatus.mockImplementation((providerId: CliProviderId) => {
      startedProviders.push(providerId);
      return providerId === 'anthropic' ? anthropicRequest.promise : codexRequest.promise;
    });

    const anthropicInvoke = ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'anthropic'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await vi.waitFor(() => expect(service.getProviderStatus).toHaveBeenCalledTimes(1));

    const codexInvoke = ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await Promise.resolve();
    await Promise.resolve();

    expect(startedProviders).toEqual(['anthropic']);
    expect(service.getProviderStatus).toHaveBeenCalledTimes(1);

    anthropicRequest.resolve(provider({ providerId: 'anthropic', authenticated: true }));
    await expect(anthropicInvoke).resolves.toMatchObject({
      success: true,
      data: { providerId: 'anthropic' },
    });
    await vi.waitFor(() => expect(service.getProviderStatus).toHaveBeenCalledTimes(2));

    expect(startedProviders).toEqual(['anthropic', 'codex']);
    codexRequest.resolve(provider({ providerId: 'codex', authenticated: true }));
    await expect(codexInvoke).resolves.toMatchObject({
      success: true,
      data: { providerId: 'codex' },
    });
  });

  it('runs OpenCode outside the serialized provider runtime queue', async () => {
    const codexRequest = deferred<CliProviderStatus>();
    const opencodeRequest = deferred<CliProviderStatus>();
    const startedProviders: CliProviderId[] = [];
    service.getProviderStatus.mockImplementation((providerId: CliProviderId) => {
      startedProviders.push(providerId);
      return providerId === 'codex' ? codexRequest.promise : opencodeRequest.promise;
    });

    const codexInvoke = ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await vi.waitFor(() => expect(service.getProviderStatus).toHaveBeenCalledTimes(1));

    const opencodeInvoke = ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await vi.waitFor(() => expect(service.getProviderStatus).toHaveBeenCalledTimes(2));

    expect(startedProviders).toEqual(['codex', 'opencode']);
    opencodeRequest.resolve(provider({ providerId: 'opencode', authenticated: true }));
    await expect(opencodeInvoke).resolves.toMatchObject({
      success: true,
      data: { providerId: 'opencode' },
    });

    codexRequest.resolve(provider({ providerId: 'codex', authenticated: true }));
    await expect(codexInvoke).resolves.toMatchObject({
      success: true,
      data: { providerId: 'codex' },
    });
  });

  it('does not reuse or recache a status request that was in flight before invalidation', async () => {
    const staleStatus = status([
      provider({
        providerId: 'codex',
        verificationState: 'error',
        statusMessage: 'Codex CLI not found',
      }),
    ]);
    const freshStatus = status([
      provider({
        providerId: 'codex',
        authenticated: true,
        authMethod: 'chatgpt',
        verificationState: 'verified',
        statusMessage: 'ChatGPT account ready',
      }),
    ]);
    const staleRequest = deferred<CliInstallationStatus>();
    const freshRequest = deferred<CliInstallationStatus>();
    service.getStatus
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(freshRequest.promise);

    const firstInvoke = ipcMain.invoke(CLI_INSTALLER_GET_STATUS) as Promise<
      IpcResult<CliInstallationStatus>
    >;
    await vi.waitFor(() => expect(service.getStatus).toHaveBeenCalledTimes(1));

    await ipcMain.invoke(CLI_INSTALLER_INVALIDATE_STATUS);
    const secondInvoke = ipcMain.invoke(CLI_INSTALLER_GET_STATUS) as Promise<
      IpcResult<CliInstallationStatus>
    >;
    await vi.waitFor(() => expect(service.getStatus).toHaveBeenCalledTimes(2));

    staleRequest.resolve(staleStatus);
    freshRequest.resolve(freshStatus);

    await expect(firstInvoke).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: false },
    });
    await expect(secondInvoke).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: true, authMethod: 'chatgpt' },
    });

    const cached = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(cached.success).toBe(true);
    expect(cached.data?.authLoggedIn).toBe(true);
    expect(cached.data?.providers[0]?.statusMessage).toBe('ChatGPT account ready');
  });

  it('keeps lightweight startup status cache separate from full provider status cache', async () => {
    const deferredStartupStatus = status([
      provider({
        providerId: 'anthropic',
        supported: false,
        statusMessage: 'Provider status will refresh when needed.',
      }),
      provider({
        providerId: 'codex',
        supported: false,
        statusMessage: 'Provider status will refresh when needed.',
      }),
    ]);
    const fullStatus = status([
      provider({
        providerId: 'anthropic',
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        statusMessage: 'Connected',
      }),
      provider({
        providerId: 'codex',
        authenticated: true,
        authMethod: 'chatgpt',
        verificationState: 'verified',
        statusMessage: 'ChatGPT account ready',
      }),
    ]);
    const startupRequest = deferred<CliInstallationStatus>();
    const fullRequest = deferred<CliInstallationStatus>();
    service.getStatus.mockImplementation((options?: { providerStatusMode?: string }) =>
      options?.providerStatusMode === 'defer' ? startupRequest.promise : fullRequest.promise
    );

    const startupInvoke = ipcMain.invoke(CLI_INSTALLER_GET_STATUS, {
      providerStatusMode: 'defer',
    }) as Promise<IpcResult<CliInstallationStatus>>;
    const fullInvoke = ipcMain.invoke(CLI_INSTALLER_GET_STATUS) as Promise<
      IpcResult<CliInstallationStatus>
    >;
    await vi.waitFor(() => expect(service.getStatus).toHaveBeenCalledTimes(2));

    startupRequest.resolve(deferredStartupStatus);
    fullRequest.resolve(fullStatus);

    await expect(startupInvoke).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: false },
    });
    await expect(fullInvoke).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: true, authMethod: 'oauth_token' },
    });

    const cachedStartup = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS, {
      providerStatusMode: 'defer',
    })) as IpcResult<CliInstallationStatus>;
    const cachedFull = (await ipcMain.invoke(
      CLI_INSTALLER_GET_STATUS
    )) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(cachedStartup.data?.authLoggedIn).toBe(false);
    expect(cachedStartup.data?.providers[0]?.statusMessage).toBe(
      'Provider status will refresh when needed.'
    );
    expect(cachedFull.data?.authLoggedIn).toBe(true);
    expect(cachedFull.data?.providers[1]?.statusMessage).toBe('ChatGPT account ready');
  });

  it('does not replace a cached full provider status with a deferred startup snapshot', async () => {
    const fullStatus = status([
      provider({
        providerId: 'anthropic',
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        statusMessage: 'Connected',
      }),
    ]);
    const deferredStartupStatus = status([
      provider({
        providerId: 'anthropic',
        supported: false,
        verificationState: 'unknown',
        statusMessage: 'Provider status will refresh when needed.',
      }),
    ]);
    service.getStatus.mockResolvedValueOnce(fullStatus);

    const first = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    expect(first.success).toBe(true);
    expect(first.data?.providers[0]?.statusMessage).toBe('Connected');

    service.getLatestStatusSnapshot.mockReturnValue(deferredStartupStatus);
    const cached = (await ipcMain.invoke(
      CLI_INSTALLER_GET_STATUS
    )) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(1);
    expect(cached.success).toBe(true);
    expect(cached.data?.authLoggedIn).toBe(true);
    expect(cached.data?.providers[0]?.statusMessage).toBe('Connected');
  });

  it('does not cache incomplete full provider status responses', async () => {
    const incompleteFullStatus = status([
      provider({
        providerId: 'anthropic',
        supported: false,
        verificationState: 'unknown',
        statusMessage: 'Provider status will refresh when needed.',
      }),
      provider({
        providerId: 'codex',
        supported: false,
        verificationState: 'unknown',
        statusMessage: 'Checking...',
      }),
    ]);
    const freshFullStatus = status([
      provider({
        providerId: 'anthropic',
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        statusMessage: 'Connected',
      }),
      provider({
        providerId: 'codex',
        authenticated: true,
        authMethod: 'chatgpt',
        verificationState: 'verified',
        statusMessage: 'ChatGPT account ready',
      }),
    ]);
    incompleteFullStatus.authStatusChecking = true;
    service.getStatus
      .mockResolvedValueOnce(incompleteFullStatus)
      .mockResolvedValueOnce(freshFullStatus);

    const first = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    const second = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(first.success).toBe(true);
    expect(first.data?.providers[0]?.statusMessage).toBe(
      'Provider status will refresh when needed.'
    );
    expect(second.success).toBe(true);
    expect(second.data?.authLoggedIn).toBe(true);
    expect(second.data?.providers[0]?.statusMessage).toBe('Connected');
  });

  it('does not let a stale in-flight provider refresh patch the cache after invalidation', async () => {
    const staleProviderRequest = deferred<CliProviderStatus | null>();
    service.getStatus
      .mockResolvedValueOnce(
        status([
          provider({ providerId: 'anthropic' }),
          provider({ providerId: 'codex', statusMessage: 'Checking...' }),
        ])
      )
      .mockResolvedValueOnce(
        status([
          provider({ providerId: 'anthropic' }),
          provider({
            providerId: 'codex',
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            statusMessage: 'ChatGPT account ready',
          }),
        ])
      );
    service.getProviderStatus.mockReturnValueOnce(staleProviderRequest.promise);

    const initial = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    expect(initial.success).toBe(true);
    expect(initial.data?.authLoggedIn).toBe(false);

    const staleProviderInvoke = ipcMain.invoke(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await vi.waitFor(() => expect(service.getProviderStatus).toHaveBeenCalledTimes(1));

    await ipcMain.invoke(CLI_INSTALLER_INVALIDATE_STATUS);
    const fresh = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;
    expect(fresh.success).toBe(true);
    expect(fresh.data?.authLoggedIn).toBe(true);

    staleProviderRequest.resolve(
      provider({
        providerId: 'codex',
        verificationState: 'error',
        statusMessage: 'Codex CLI not found',
      })
    );
    await expect(staleProviderInvoke).resolves.toMatchObject({
      success: true,
      data: { statusMessage: 'Codex CLI not found' },
    });

    const cached = (await ipcMain.invoke(CLI_INSTALLER_GET_STATUS)) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(cached.success).toBe(true);
    expect(cached.data?.authLoggedIn).toBe(true);
    expect(cached.data?.providers.find((entry) => entry.providerId === 'codex')?.statusMessage).toBe(
      'ChatGPT account ready'
    );
  });

  it('does not let a stale model verification patch the cache after invalidation', async () => {
    const staleVerificationRequest = deferred<CliProviderStatus | null>();
    service.getStatus
      .mockResolvedValueOnce(
        status([
          provider({ providerId: 'anthropic' }),
          provider({ providerId: 'codex', statusMessage: 'Checking...' }),
        ])
      )
      .mockResolvedValueOnce(
        status([
          provider({ providerId: 'anthropic' }),
          provider({
            providerId: 'codex',
            authenticated: true,
            authMethod: 'chatgpt',
            verificationState: 'verified',
            statusMessage: 'ChatGPT account ready',
          }),
        ])
      );
    service.verifyProviderModels.mockReturnValueOnce(staleVerificationRequest.promise);

    const initial = (await ipcMain.invoke(
      CLI_INSTALLER_GET_STATUS
    )) as IpcResult<CliInstallationStatus>;
    expect(initial.success).toBe(true);
    expect(initial.data?.authLoggedIn).toBe(false);

    const staleVerificationInvoke = ipcMain.invoke(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'codex'
    ) as Promise<IpcResult<CliProviderStatus | null>>;
    await vi.waitFor(() => expect(service.verifyProviderModels).toHaveBeenCalledTimes(1));

    await ipcMain.invoke(CLI_INSTALLER_INVALIDATE_STATUS);
    const fresh = (await ipcMain.invoke(
      CLI_INSTALLER_GET_STATUS
    )) as IpcResult<CliInstallationStatus>;
    expect(fresh.success).toBe(true);
    expect(fresh.data?.authLoggedIn).toBe(true);

    staleVerificationRequest.resolve(
      provider({
        providerId: 'codex',
        verificationState: 'error',
        statusMessage: 'Stale model verification failed',
      })
    );
    await expect(staleVerificationInvoke).resolves.toMatchObject({
      success: true,
      data: { statusMessage: 'Stale model verification failed' },
    });

    const cached = (await ipcMain.invoke(
      CLI_INSTALLER_GET_STATUS
    )) as IpcResult<CliInstallationStatus>;

    expect(service.getStatus).toHaveBeenCalledTimes(2);
    expect(cached.success).toBe(true);
    expect(cached.data?.authLoggedIn).toBe(true);
    expect(cached.data?.providers.find((entry) => entry.providerId === 'codex')?.statusMessage).toBe(
      'ChatGPT account ready'
    );
  });
});
