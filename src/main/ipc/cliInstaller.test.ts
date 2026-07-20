import { resolve as resolvePath } from 'node:path';

import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
} from '@preload/constants/ipcChannels';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { initializeCliInstallerHandlers, registerCliInstallerHandlers } from './cliInstaller';

import type { CliInstallerService } from '@main/services';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const PARALLEL_PROVIDER_STATUS_ENV = 'CLAUDE_TEAM_PARALLEL_PROVIDER_STATUS';
const LOCAL_MODEL_PROJECT_A_PATH = resolvePath(
  process.cwd(),
  'test-fixtures/local-model-project-a'
);
const LOCAL_MODEL_PROJECT_B_PATH = resolvePath(
  process.cwd(),
  'test-fixtures/local-model-project-b'
);

afterEach(() => {
  vi.unstubAllEnvs();
});

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function createProviderStatus(providerId: CliProviderId): CliProviderStatus {
  return {
    providerId,
    displayName: providerId,
    supported: true,
    authenticated: true,
    authMethod: 'test',
    verificationState: 'verified',
    models: [],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
  };
}

function createCliStatus(providers: CliProviderStatus[] = []): CliInstallationStatus {
  const authenticatedProvider = providers.find((provider) => provider.authenticated) ?? null;
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Agent Teams Runtime',
    supportsSelfUpdate: false,
    showVersionDetails: true,
    showBinaryPath: true,
    installed: true,
    installedVersion: '1.0.0',
    binaryPath: '/usr/local/bin/claude',
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: authenticatedProvider !== null,
    authStatusChecking: false,
    authMethod: authenticatedProvider?.authMethod ?? null,
    providers,
  };
}

function createIpcMainHarness(): {
  ipcMain: IpcMain;
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
} {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  } as unknown as IpcMain;

  return {
    ipcMain,
    invoke: async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`Missing IPC handler: ${channel}`);
      }
      return (await handler({} as IpcMainInvokeEvent, ...args)) as T;
    },
  };
}

function createInstallerService(overrides: Partial<CliInstallerService>): CliInstallerService {
  return {
    getStatus: vi.fn(() => Promise.resolve(createCliStatus())),
    getLatestStatusSnapshot: vi.fn(() => null),
    getProviderStatus: vi.fn(),
    install: vi.fn(() => Promise.resolve()),
    invalidateStatusCache: vi.fn(),
    verifyProviderModels: vi.fn(),
    ...overrides,
  } as unknown as CliInstallerService;
}

function setupHandlers(service: CliInstallerService): ReturnType<typeof createIpcMainHarness> {
  const harness = createIpcMainHarness();
  initializeCliInstallerHandlers(service);
  registerCliInstallerHandlers(harness.ipcMain);
  return harness;
}

describe('cliInstaller IPC provider runtime scheduling', () => {
  test('runs shared provider status requests sequentially while OpenCode stays independent', async () => {
    const started: CliProviderId[] = [];
    const deferredByProvider = new Map<CliProviderId, Deferred<CliProviderStatus | null>>();
    const service = createInstallerService({
      getProviderStatus: vi.fn((providerId: CliProviderId) => {
        started.push(providerId);
        const deferred = createDeferred<CliProviderStatus | null>();
        deferredByProvider.set(providerId, deferred);
        return deferred.promise;
      }),
    });
    const { invoke } = setupHandlers(service);

    const requests = (['anthropic', 'codex', 'opencode', 'gemini'] as CliProviderId[]).map(
      (providerId) =>
        invoke<IpcResult<CliProviderStatus | null>>(CLI_INSTALLER_GET_PROVIDER_STATUS, providerId)
    );

    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode']));
    deferredByProvider.get('opencode')?.resolve(createProviderStatus('opencode'));

    deferredByProvider.get('anthropic')?.resolve(createProviderStatus('anthropic'));
    await flushMicrotasks();
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex']));

    deferredByProvider.get('codex')?.resolve(createProviderStatus('codex'));
    await flushMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex', 'gemini']));

    deferredByProvider.get('gemini')?.resolve(createProviderStatus('gemini'));

    const results = await Promise.all(requests);
    expect(results.every((result) => result.success)).toBe(true);
  });

  test('runs different provider status requests concurrently when the parallel flag is enabled', async () => {
    vi.stubEnv(PARALLEL_PROVIDER_STATUS_ENV, '1');

    const started: CliProviderId[] = [];
    const deferredByProvider = new Map<CliProviderId, Deferred<CliProviderStatus | null>>();
    const service = createInstallerService({
      getProviderStatus: vi.fn((providerId: CliProviderId) => {
        started.push(providerId);
        const deferred = createDeferred<CliProviderStatus | null>();
        deferredByProvider.set(providerId, deferred);
        return deferred.promise;
      }),
    });
    const { invoke } = setupHandlers(service);

    const requests = (['anthropic', 'codex', 'opencode', 'gemini'] as CliProviderId[]).map(
      (providerId) =>
        invoke<IpcResult<CliProviderStatus | null>>(CLI_INSTALLER_GET_PROVIDER_STATUS, providerId)
    );

    await flushMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'codex', 'opencode', 'gemini']));

    deferredByProvider.get('anthropic')?.resolve(createProviderStatus('anthropic'));
    deferredByProvider.get('codex')?.resolve(createProviderStatus('codex'));
    deferredByProvider.get('opencode')?.resolve(createProviderStatus('opencode'));
    deferredByProvider.get('gemini')?.resolve(createProviderStatus('gemini'));

    const results = await Promise.all(requests);
    expect(results.every((result) => result.success)).toBe(true);
  });

  test('dedupes concurrent status requests for the same provider', async () => {
    const deferred = createDeferred<CliProviderStatus | null>();
    const getProviderStatus = vi.fn(() => deferred.promise);
    const service = createInstallerService({ getProviderStatus });
    const { invoke } = setupHandlers(service);

    const firstRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    );
    const secondRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    );

    await flushMicrotasks();
    expect(getProviderStatus).toHaveBeenCalledTimes(1);

    const providerStatus = createProviderStatus('codex');
    deferred.resolve(providerStatus);

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      { success: true, data: providerStatus },
      { success: true, data: providerStatus },
    ]);
  });

  test('keeps project-scoped OpenCode status requests distinct and forwards their paths', async () => {
    const firstDeferred = createDeferred<CliProviderStatus | null>();
    const secondDeferred = createDeferred<CliProviderStatus | null>();
    const getProviderStatus = vi
      .fn()
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);
    const service = createInstallerService({ getProviderStatus });
    const { invoke } = setupHandlers(service);
    const firstRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      { projectPath: LOCAL_MODEL_PROJECT_A_PATH }
    );
    const secondRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      { projectPath: LOCAL_MODEL_PROJECT_B_PATH }
    );

    await flushMicrotasks();
    expect(getProviderStatus).toHaveBeenCalledTimes(1);
    expect(getProviderStatus).toHaveBeenNthCalledWith(1, 'opencode', {
      projectPath: LOCAL_MODEL_PROJECT_A_PATH,
    });

    firstDeferred.resolve(createProviderStatus('opencode'));
    await flushMicrotasks();
    expect(getProviderStatus).toHaveBeenCalledTimes(2);
    expect(getProviderStatus).toHaveBeenNthCalledWith(2, 'opencode', {
      projectPath: LOCAL_MODEL_PROJECT_B_PATH,
    });

    secondDeferred.resolve(createProviderStatus('opencode'));
    const results = await Promise.all([firstRequest, secondRequest]);
    expect(results.every((result) => result.success)).toBe(true);
  });

  test('rejects relative provider status project paths at the IPC boundary', async () => {
    const getProviderStatus = vi.fn();
    const service = createInstallerService({ getProviderStatus });
    const { invoke } = setupHandlers(service);

    const result = await invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      { projectPath: 'relative/project' }
    );

    expect(result.success).toBe(false);
    expect(getProviderStatus).not.toHaveBeenCalled();
  });

  test('keeps status and model verification sequential for the same provider', async () => {
    const started: string[] = [];
    const statusDeferred = createDeferred<CliProviderStatus | null>();
    const verifyDeferred = createDeferred<CliProviderStatus | null>();
    const service = createInstallerService({
      getProviderStatus: vi.fn(() => {
        started.push('status');
        return statusDeferred.promise;
      }),
      verifyProviderModels: vi.fn(() => {
        started.push('verify');
        return verifyDeferred.promise;
      }),
    });
    const { invoke } = setupHandlers(service);

    const statusRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode'
    );
    const verifyRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'opencode'
    );

    await flushMicrotasks();
    expect(started).toEqual(['status']);

    statusDeferred.resolve(createProviderStatus('opencode'));
    await flushMicrotasks();
    expect(started).toEqual(['status', 'verify']);

    verifyDeferred.resolve(createProviderStatus('opencode'));

    const [statusResult, verifyResult] = await Promise.all([statusRequest, verifyRequest]);
    expect(statusResult.success).toBe(true);
    expect(verifyResult.success).toBe(true);
  });

  test('does not strand queued provider requests if handlers are reinitialized', async () => {
    const started: CliProviderId[] = [];
    const deferredByProvider = new Map<CliProviderId, Deferred<CliProviderStatus | null>>();
    const originalService = createInstallerService({
      getProviderStatus: vi.fn((providerId: CliProviderId) => {
        started.push(providerId);
        const deferred = createDeferred<CliProviderStatus | null>();
        deferredByProvider.set(providerId, deferred);
        return deferred.promise;
      }),
    });
    const replacementService = createInstallerService({
      getProviderStatus: vi.fn(() => Promise.resolve(createProviderStatus('anthropic'))),
    });
    const { invoke } = setupHandlers(originalService);

    const requests = (['anthropic', 'codex', 'opencode', 'gemini'] as CliProviderId[]).map(
      (providerId) =>
        invoke<IpcResult<CliProviderStatus | null>>(CLI_INSTALLER_GET_PROVIDER_STATUS, providerId)
    );

    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode']));

    initializeCliInstallerHandlers(replacementService);
    deferredByProvider.get('opencode')?.resolve(createProviderStatus('opencode'));

    deferredByProvider.get('anthropic')?.resolve(createProviderStatus('anthropic'));
    await flushMicrotasks();
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex']));

    deferredByProvider.get('codex')?.resolve(createProviderStatus('codex'));
    await flushMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex', 'gemini']));
    expect(replacementService.getProviderStatus).not.toHaveBeenCalled();

    deferredByProvider.get('gemini')?.resolve(createProviderStatus('gemini'));
    const results = await Promise.all(requests);
    expect(results.every((result) => result.success)).toBe(true);
  });

  test('releases a provider runtime slot after a failed request', async () => {
    const started: CliProviderId[] = [];
    const deferredByProvider = new Map<CliProviderId, Deferred<CliProviderStatus | null>>();
    const service = createInstallerService({
      getProviderStatus: vi.fn((providerId: CliProviderId) => {
        started.push(providerId);
        const deferred = createDeferred<CliProviderStatus | null>();
        deferredByProvider.set(providerId, deferred);
        return deferred.promise;
      }),
    });
    const { invoke } = setupHandlers(service);

    const requests = (['anthropic', 'codex', 'opencode', 'gemini'] as CliProviderId[]).map(
      (providerId) =>
        invoke<IpcResult<CliProviderStatus | null>>(CLI_INSTALLER_GET_PROVIDER_STATUS, providerId)
    );

    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode']));
    deferredByProvider.get('opencode')?.resolve(createProviderStatus('opencode'));

    deferredByProvider.get('anthropic')?.reject(new Error('provider failed'));
    await flushMicrotasks();
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex']));

    deferredByProvider.get('codex')?.resolve(createProviderStatus('codex'));
    await flushMicrotasks();
    expect(started).toHaveLength(4);
    expect(started).toEqual(expect.arrayContaining(['anthropic', 'opencode', 'codex', 'gemini']));

    deferredByProvider.get('gemini')?.resolve(createProviderStatus('gemini'));

    const results = await Promise.all(requests);
    expect(results[0]).toEqual({ success: false, error: 'provider failed' });
    expect(results.slice(1).every((result) => result.success)).toBe(true);
  });

  test('does not patch a fresh status cache with stale provider results after invalidation', async () => {
    const providerDeferred = createDeferred<CliProviderStatus | null>();
    const service = createInstallerService({
      getStatus: vi.fn(() => Promise.resolve(createCliStatus())),
      getProviderStatus: vi.fn(() => providerDeferred.promise),
    });
    const { invoke } = setupHandlers(service);

    const firstStatus = await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(firstStatus.success).toBe(true);

    const providerRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex'
    );
    await flushMicrotasks();

    const invalidateResult = await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);
    expect(invalidateResult.success).toBe(true);

    const freshStatus = await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(freshStatus).toEqual({ success: true, data: createCliStatus() });

    providerDeferred.resolve(createProviderStatus('codex'));
    await expect(providerRequest).resolves.toEqual({
      success: true,
      data: createProviderStatus('codex'),
    });

    const cachedStatusResult =
      await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(cachedStatusResult).toEqual({ success: true, data: createCliStatus() });
  });
});
