import { resolve as resolvePath } from 'node:path';

import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
} from '@preload/constants/ipcChannels';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import {
  isCliProviderAuthorityProjectRoot,
  normalizeCliProviderAuthorityProjectPath,
} from '@shared/utils/cliProviderAuthority';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  captureAuthoritativeProofEpoch,
  issueAuthoritativeModelExecutionProof,
  verifyAuthoritativeModelExecutionProof,
} from '../services/team/TeamLaunchExecutionProofAuthority';

import {
  initializeCliInstallerHandlers,
  registerCliInstallerHandlers,
  removeCliInstallerHandlers,
} from './cliInstaller';

import type { CliInstallerService } from '@main/services';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusIpcRequest,
  CliProviderStatusIpcResponse,
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
    statusCheckOutcome: 'authoritative',
  };
}

let providerStatusRequestNonce = 0;
function createProviderStatusRequest(
  projectPath?: string,
  purpose: CliProviderStatusIpcRequest['purpose'] = 'passive'
): CliProviderStatusIpcRequest {
  providerStatusRequestNonce += 1;
  return {
    ...(projectPath ? { projectPath } : {}),
    purpose,
    requestNonce: `ipc-unit-${providerStatusRequestNonce}`,
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

describe('provider authority project scope normalization', () => {
  test.each([
    ['/tmp/project', '/tmp/project'],
    ['/Server//Share///Project', '/Server/Share/Project'],
    ['///Server//Share///Project', '/Server/Share/Project'],
    ['/tmp/./parent/../project/', '/tmp/project'],
    ['/../../tmp/project', '/tmp/project'],
    ['C:\\Work\\Project', 'c:/work/project'],
    ['c:/work/./parent/../project/', 'c:/work/project'],
    ['C:\\..\\Project', 'c:/project'],
    ['//Server/Share/Project', '\\\\server\\share\\project'],
    ['//SERVER//Share///folder/../Project/', '\\\\server\\share\\project'],
    ['\\\\Server\\Share\\Project', '\\\\server\\share\\project'],
    ['\\\\SERVER\\Share\\folder\\..\\Project', '\\\\server\\share\\project'],
    ['\\\\Server\\Share\\..\\..\\Project', '\\\\server\\share\\project'],
  ])('normalizes %s deterministically to %s', (input, expected) => {
    expect(normalizeCliProviderAuthorityProjectPath(input)).toBe(expected);
    expect(normalizeCliProviderAuthorityProjectPath(expected)).toBe(expected);
  });

  test('keeps forward-slash UNC and single-root POSIX identities distinct', () => {
    expect(normalizeCliProviderAuthorityProjectPath('//server/share/project')).toBe(
      '\\\\server\\share\\project'
    );
    expect(normalizeCliProviderAuthorityProjectPath('/server/share/project')).toBe(
      '/server/share/project'
    );
  });

  test.each(['project', './project', '../project', 'C:project', '', '\\\\server'])(
    'rejects non-absolute or incomplete input %s',
    (input) => {
      expect(() => normalizeCliProviderAuthorityProjectPath(input)).toThrow();
    }
  );

  test.each(['/', 'C:\\', '\\\\Server\\Share'])('recognizes authority roots %s', (input) => {
    expect(isCliProviderAuthorityProjectRoot(input)).toBe(true);
  });
});

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
        invoke<IpcResult<CliProviderStatusIpcResponse>>(
          CLI_INSTALLER_GET_PROVIDER_STATUS,
          providerId,
          createProviderStatusRequest()
        )
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
        invoke<IpcResult<CliProviderStatusIpcResponse>>(
          CLI_INSTALLER_GET_PROVIDER_STATUS,
          providerId,
          createProviderStatusRequest()
        )
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

    const firstRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest()
    );
    const secondRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest()
    );

    await flushMicrotasks();
    expect(getProviderStatus).toHaveBeenCalledTimes(1);

    const providerStatus = createProviderStatus('codex');
    deferred.resolve(providerStatus);

    const results = await Promise.all([firstRequest, secondRequest]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ success: true, data: { providerStatus } });
    expect(results[1]).toMatchObject({ success: true, data: { providerStatus } });
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
    const firstRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH)
    );
    const secondRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_B_PATH)
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

    const result = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest('relative/project')
    );

    expect(result.success).toBe(false);
    expect(getProviderStatus).not.toHaveBeenCalled();
  });

  test.each([
    ['//Server/Share/Project', '\\\\server\\share\\project'],
    ['/Server//Share///Project', '/Server/Share/Project'],
    ['/tmp/./parent/../project', '/tmp/project'],
    ['C:\\Work\\Project', 'c:/work/project'],
    ['\\\\Server\\Share\\folder\\..\\Project', '\\\\server\\share\\project'],
    ['\\\\Server\\Share\\..\\..\\Project', '\\\\server\\share\\project'],
  ])('forwards canonical project scope %s as %s', async (input, expected) => {
    const getProviderStatus = vi.fn(() => Promise.resolve(createProviderStatus('opencode')));
    const { invoke } = setupHandlers(createInstallerService({ getProviderStatus }));

    const result = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest(input)
    );

    expect(result.success).toBe(true);
    expect(getProviderStatus).toHaveBeenCalledWith('opencode', { projectPath: expected });
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

    const statusRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest()
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
        invoke<IpcResult<CliProviderStatusIpcResponse>>(
          CLI_INSTALLER_GET_PROVIDER_STATUS,
          providerId,
          createProviderStatusRequest()
        )
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
    expect(results.every((result) => !result.success)).toBe(true);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error: expect.stringContaining('invalidated') }),
      ])
    );

    const replacementResult = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'anthropic',
      createProviderStatusRequest()
    );
    expect(replacementResult.success).toBe(true);
    expect(replacementService.getProviderStatus).toHaveBeenCalledTimes(1);
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
        invoke<IpcResult<CliProviderStatusIpcResponse>>(
          CLI_INSTALLER_GET_PROVIDER_STATUS,
          providerId,
          createProviderStatusRequest()
        )
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

    const providerRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest()
    );
    await flushMicrotasks();

    const invalidateResult = await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);
    expect(invalidateResult.success).toBe(true);

    const freshStatus = await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(freshStatus).toEqual({ success: true, data: createCliStatus() });

    providerDeferred.resolve(createProviderStatus('codex'));
    await expect(providerRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('invalidated'),
    });

    const cachedStatusResult =
      await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(cachedStatusResult).toEqual({ success: true, data: createCliStatus() });
  });

  test('rejects a late project authentication after a newer aggregate logout completes', async () => {
    const projectDeferred = createDeferred<CliProviderStatus | null>();
    const aggregateDeferred = createDeferred<CliInstallationStatus>();
    const service = createInstallerService({
      getStatus: vi.fn(() => aggregateDeferred.promise),
      getProviderStatus: vi.fn(() => projectDeferred.promise),
    });
    const { invoke } = setupHandlers(service);
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);

    const projectRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    await flushMicrotasks();
    const aggregateRequest = invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);

    aggregateDeferred.resolve(
      createCliStatus([
        {
          ...createProviderStatus('codex'),
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusCheckOutcome: 'authoritative',
        },
      ])
    );
    await expect(aggregateRequest).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: false },
    });

    projectDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'authoritative',
    });
    await expect(projectRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('superseded'),
    });
  });

  test('rejects a late aggregate authentication after a newer project logout completes', async () => {
    const aggregateDeferred = createDeferred<CliInstallationStatus>();
    const service = createInstallerService({
      getStatus: vi.fn(() => aggregateDeferred.promise),
      getProviderStatus: vi.fn(() =>
        Promise.resolve<CliProviderStatus>({
          ...createProviderStatus('codex'),
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusCheckOutcome: 'authoritative' as const,
        })
      ),
    });
    const { invoke } = setupHandlers(service);
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);

    const aggregateRequest = invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    await flushMicrotasks();
    const projectResult = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    expect(projectResult.success).toBe(true);

    aggregateDeferred.resolve(
      createCliStatus([
        {
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative',
        },
      ])
    );
    await expect(aggregateRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('superseded'),
    });
  });

  test('accepts a completed project authentication followed by a later aggregate logout', async () => {
    const service = createInstallerService({
      getStatus: vi.fn(() =>
        Promise.resolve(
          createCliStatus([
            {
              ...createProviderStatus('codex'),
              authenticated: false,
              authMethod: null,
              verificationState: 'unknown',
              statusCheckOutcome: 'authoritative',
            },
          ])
        )
      ),
      getProviderStatus: vi.fn(() =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative' as const,
        })
      ),
    });
    const { invoke } = setupHandlers(service);
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);

    const projectResult = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    const aggregateResult =
      await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);

    expect(projectResult.success).toBe(true);
    expect(aggregateResult).toMatchObject({ success: true, data: { authLoggedIn: false } });
  });

  test('keeps unrelated provider observations current when one provider is superseded', async () => {
    const statusDeferredByProvider = new Map<CliProviderId, Deferred<CliProviderStatus | null>>();
    const service = createInstallerService({
      getStatus: vi.fn(() =>
        Promise.resolve(
          createCliStatus([
            {
              ...createProviderStatus('codex'),
              authenticated: false,
              authMethod: null,
              verificationState: 'unknown',
              statusCheckOutcome: 'authoritative',
            },
          ])
        )
      ),
      getProviderStatus: vi.fn((providerId: CliProviderId) => {
        const deferred = createDeferred<CliProviderStatus | null>();
        statusDeferredByProvider.set(providerId, deferred);
        return deferred.promise;
      }),
    });
    const { invoke } = setupHandlers(service);
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);

    const codexRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    const openCodeRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    await flushMicrotasks();

    const aggregateResult =
      await invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    expect(aggregateResult.success).toBe(true);

    statusDeferredByProvider.get('codex')?.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'authoritative',
    });
    statusDeferredByProvider.get('opencode')?.resolve({
      ...createProviderStatus('opencode'),
      statusCheckOutcome: 'authoritative',
    });

    await expect(codexRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('superseded'),
    });
    await expect(openCodeRequest).resolves.toMatchObject({ success: true });
  });

  test('rejects a late model verification after a newer aggregate logout', async () => {
    const verifyDeferred = createDeferred<CliProviderStatus | null>();
    const aggregateDeferred = createDeferred<CliInstallationStatus>();
    const service = createInstallerService({
      getStatus: vi.fn(() => aggregateDeferred.promise),
      verifyProviderModels: vi.fn(() => verifyDeferred.promise),
    });
    const { invoke } = setupHandlers(service);
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);

    const verifyRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'codex'
    );
    await flushMicrotasks();
    const aggregateRequest = invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    aggregateDeferred.resolve(
      createCliStatus([
        {
          ...createProviderStatus('codex'),
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusCheckOutcome: 'authoritative',
        },
      ])
    );
    await expect(aggregateRequest).resolves.toMatchObject({ success: true });

    verifyDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'model_only',
      models: ['late-model'],
    });
    await expect(verifyRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('superseded'),
    });

    await expect(
      invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS)
    ).resolves.toMatchObject({ success: true, data: { authLoggedIn: false } });
  });

  test('lets an older authoritative logout complete after a newer model-only result', async () => {
    const projectPath = resolvePath(process.cwd(), 'src');
    const aggregateDeferred = createDeferred<CliInstallationStatus>();
    const verifyDeferred = createDeferred<CliProviderStatus | null>();
    const service = createInstallerService({
      getStatus: vi.fn(() => aggregateDeferred.promise),
      getProviderStatus: vi.fn(() =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          models: ['authenticated-model'],
        })
      ),
      verifyProviderModels: vi.fn(() => verifyDeferred.promise),
    });
    const { invoke } = setupHandlers(service);

    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(projectPath, 'launch-proof')
    );
    const proof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectPath),
      cwd: projectPath,
      checks: [
        { providerId: 'codex', providerBackendId: 'codex-native', model: 'authenticated-model' },
      ],
    });

    const aggregateRequest = invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    await flushMicrotasks();
    const verifyRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'codex'
    );
    verifyDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'model_only',
      models: ['newer-catalog-model'],
    });
    await expect(verifyRequest).resolves.toMatchObject({ success: true });
    expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(true);

    aggregateDeferred.resolve(
      createCliStatus([
        {
          ...createProviderStatus('codex'),
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          models: [],
        },
      ])
    );
    await expect(aggregateRequest).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: false },
    });
    expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(false);
  });

  test('rejects an older model-only completion after a newer model-only completion', async () => {
    const verifyDeferred = createDeferred<CliProviderStatus | null>();
    const service = createInstallerService({
      getStatus: vi.fn(() =>
        Promise.resolve(
          createCliStatus([
            {
              ...createProviderStatus('codex'),
              statusCheckOutcome: 'model_only',
              models: ['newer-model'],
            },
          ])
        )
      ),
      verifyProviderModels: vi.fn(() => verifyDeferred.promise),
    });
    const { invoke } = setupHandlers(service);

    const olderRequest = invoke<IpcResult<CliProviderStatus | null>>(
      CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
      'codex'
    );
    await flushMicrotasks();
    await expect(
      invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS)
    ).resolves.toMatchObject({ success: true });

    verifyDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'model_only',
      models: ['older-model'],
    });
    await expect(olderRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('superseded'),
    });
    await expect(
      invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS)
    ).resolves.toMatchObject({
      success: true,
      data: { providers: [expect.objectContaining({ models: ['newer-model'] })] },
    });
  });

  test.each([
    ['partial legacy', { statusCheckOutcome: undefined, statusMessage: 'Checking...' }],
    [
      'deferred legacy',
      {
        statusCheckOutcome: undefined,
        statusMessage: CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
      },
    ],
    ['pending', { statusCheckOutcome: 'pending' as const }],
    ['transient', { statusCheckOutcome: 'transient_error' as const }],
  ])(
    'does not let a newer %s response suppress an older authority result',
    async (_label, statusOverrides) => {
      const aggregateDeferred = createDeferred<CliInstallationStatus>();
      const service = createInstallerService({
        getStatus: vi.fn(() => aggregateDeferred.promise),
        getProviderStatus: vi.fn(() =>
          Promise.resolve({
            ...createProviderStatus('codex'),
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown' as const,
            ...statusOverrides,
          })
        ),
      });
      const { invoke } = setupHandlers(service);

      const aggregateRequest = invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
      await flushMicrotasks();
      await expect(
        invoke<IpcResult<CliProviderStatusIpcResponse>>(
          CLI_INSTALLER_GET_PROVIDER_STATUS,
          'codex',
          createProviderStatusRequest()
        )
      ).resolves.toMatchObject({ success: true });

      aggregateDeferred.resolve(createCliStatus([createProviderStatus('codex')]));
      await expect(aggregateRequest).resolves.toMatchObject({ success: true });
    }
  );

  test('does not treat an incomplete legacy logout as provider authority', async () => {
    const projectPath = resolvePath(process.cwd(), 'src');
    let providerStatus: CliProviderStatus = createProviderStatus('codex');
    const service = createInstallerService({
      getProviderStatus: vi.fn(() => Promise.resolve(providerStatus)),
    });
    const { invoke } = setupHandlers(service);

    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(projectPath, 'launch-proof')
    );
    const proof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectPath),
      cwd: projectPath,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'test-model' }],
    });

    providerStatus = {
      ...createProviderStatus('codex'),
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: undefined,
    };
    await expect(
      invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'codex',
        createProviderStatusRequest(projectPath, 'launch-proof')
      )
    ).resolves.toMatchObject({ success: true, data: { authorityScope: null } });

    expect(verifyAuthoritativeModelExecutionProof(proof)).toBe(true);
  });

  test('resets observation fences when handlers are removed and registered again', async () => {
    const oldAggregateDeferred = createDeferred<CliInstallationStatus>();
    const service = createInstallerService({
      getStatus: vi
        .fn()
        .mockImplementationOnce(() => oldAggregateDeferred.promise)
        .mockImplementationOnce(() =>
          Promise.resolve(createCliStatus([createProviderStatus('codex')]))
        ),
    });
    const harness = setupHandlers(service);

    const staleRequest = harness.invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS);
    await flushMicrotasks();
    removeCliInstallerHandlers(harness.ipcMain);
    registerCliInstallerHandlers(harness.ipcMain);

    await expect(
      harness.invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS)
    ).resolves.toMatchObject({ success: true });
    oldAggregateDeferred.resolve(
      createCliStatus([
        {
          ...createProviderStatus('codex'),
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
        },
      ])
    );
    await expect(staleRequest).resolves.toMatchObject({
      success: true,
      data: { authLoggedIn: false },
    });

    await expect(
      harness.invoke<IpcResult<CliInstallationStatus>>(CLI_INSTALLER_GET_STATUS)
    ).resolves.toMatchObject({ success: true, data: { authLoggedIn: true } });
  });

  test('resets request ordering on explicit invalidation without accepting old completions', async () => {
    const oldDeferred = createDeferred<CliProviderStatus | null>();
    const freshDeferred = createDeferred<CliProviderStatus | null>();
    const getProviderStatus = vi
      .fn()
      .mockImplementationOnce(() => oldDeferred.promise)
      .mockImplementationOnce(() => freshDeferred.promise);
    const service = createInstallerService({ getProviderStatus });
    const { invoke } = setupHandlers(service);

    const oldRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );
    await flushMicrotasks();
    await invoke<IpcResult<void>>(CLI_INSTALLER_INVALIDATE_STATUS);
    const freshRequest = invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(LOCAL_MODEL_PROJECT_A_PATH, 'launch-proof')
    );

    oldDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'authoritative',
    });
    await expect(oldRequest).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('invalidated'),
    });
    await flushMicrotasks();
    expect(getProviderStatus).toHaveBeenCalledTimes(2);

    freshDeferred.resolve({
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'authoritative',
    });
    await expect(freshRequest).resolves.toMatchObject({ success: true });
  });

  test('invalidates only execution proofs that depend on a changed provider fingerprint', async () => {
    const statusByProvider = new Map<CliProviderId, CliProviderStatus>([
      ['anthropic', createProviderStatus('anthropic')],
      ['codex', createProviderStatus('codex')],
    ]);
    const service = createInstallerService({
      getProviderStatus: vi.fn((providerId: CliProviderId) =>
        Promise.resolve(statusByProvider.get(providerId) ?? null)
      ),
    });
    const { invoke } = setupHandlers(service);

    for (const providerId of ['anthropic', 'codex'] as const) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        providerId,
        createProviderStatusRequest(process.cwd(), 'launch-proof')
      );
    }

    const anthropicAttempt = captureAuthoritativeProofEpoch(process.cwd());
    const codexAttempt = captureAuthoritativeProofEpoch(process.cwd());
    const staleAnthropicAttempt = captureAuthoritativeProofEpoch(process.cwd());
    const anthropicProof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: anthropicAttempt,
      cwd: process.cwd(),
      checks: [{ providerId: 'anthropic', model: 'claude-test' }],
    });
    const codexProof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: codexAttempt,
      cwd: process.cwd(),
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-test' }],
    });

    statusByProvider.set('anthropic', {
      ...createProviderStatus('anthropic'),
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
    });
    const changedStatus = await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'anthropic',
      createProviderStatusRequest(process.cwd(), 'launch-proof')
    );

    expect(changedStatus.success).toBe(true);
    expect(verifyAuthoritativeModelExecutionProof(anthropicProof)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(codexProof)).toBe(true);
    expect(() =>
      issueAuthoritativeModelExecutionProof({
        authorityEpoch: staleAnthropicAttempt,
        cwd: process.cwd(),
        checks: [{ providerId: 'anthropic', model: 'claude-test' }],
      })
    ).toThrow('provider authority changed during preparation');
  });

  test('a scoped global logout invalidates provider proofs for projects A and B', async () => {
    let providerStatus: CliProviderStatus = {
      ...createProviderStatus('codex'),
      statusCheckOutcome: 'authoritative',
    };
    const service = createInstallerService({
      getProviderStatus: vi.fn(() => Promise.resolve(providerStatus)),
    });
    const { invoke } = setupHandlers(service);
    const projectA = resolvePath(process.cwd(), 'src');
    const projectB = resolvePath(process.cwd(), 'test');

    for (const projectPath of [projectA, projectB]) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'codex',
        createProviderStatusRequest(projectPath, 'launch-proof')
      );
    }
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-test' }],
    });
    const proofB = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectB),
      cwd: projectB,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-test' }],
    });

    providerStatus = {
      ...providerStatus,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
    };
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(projectA, 'launch-proof')
    );

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(proofB)).toBe(false);
  });

  test('a project A catalog change leaves the project B provider proof authoritative', async () => {
    const projectA = resolvePath(process.cwd(), 'src');
    const projectB = resolvePath(process.cwd(), 'test');
    let projectAModels = ['gpt-a-v1'];
    const service = createInstallerService({
      getProviderStatus: vi.fn((_providerId: CliProviderId, options) =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative' as const,
          models: options?.projectPath === projectA ? projectAModels : ['gpt-b-v1'],
        })
      ),
    });
    const { invoke } = setupHandlers(service);

    for (const projectPath of [projectA, projectB]) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'codex',
        createProviderStatusRequest(projectPath, 'launch-proof')
      );
    }
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-a-v1' }],
    });
    const proofB = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectB),
      cwd: projectB,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-b-v1' }],
    });

    projectAModels = ['gpt-a-v2'];
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(projectA, 'launch-proof')
    );

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(proofB)).toBe(true);
  });

  test('alternating project-local profiles do not invalidate another project proof', async () => {
    const projectA = resolvePath(process.cwd(), 'src');
    const projectB = resolvePath(process.cwd(), 'test');
    const service = createInstallerService({
      getProviderStatus: vi.fn((_providerId: CliProviderId, options) =>
        Promise.resolve({
          ...createProviderStatus('opencode'),
          statusCheckOutcome: 'authoritative' as const,
          selectedBackendId: options?.projectPath === projectA ? 'adapter' : 'opencode-cli',
          resolvedBackendId: options?.projectPath === projectA ? 'adapter' : 'opencode-cli',
          backend: {
            kind: 'opencode',
            label: 'OpenCode',
            projectId: options?.projectPath === projectA ? 'project-a' : 'project-b',
          },
        })
      ),
    });
    const { invoke } = setupHandlers(service);

    for (const projectPath of [projectA, projectB]) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'opencode',
        createProviderStatusRequest(projectPath, 'launch-proof')
      );
    }
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'opencode', providerBackendId: 'adapter', model: 'model-a' }],
    });
    const proofB = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectB),
      cwd: projectB,
      checks: [{ providerId: 'opencode', providerBackendId: 'opencode-cli', model: 'model-b' }],
    });

    for (const projectPath of [projectA, projectB, projectA, projectB]) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'opencode',
        createProviderStatusRequest(projectPath, 'launch-proof')
      );
    }

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(true);
    expect(verifyAuthoritativeModelExecutionProof(proofB)).toBe(true);
  });

  test('a matching project profile change invalidates only that scope and rejects a stale epoch', async () => {
    const projectA = resolvePath(process.cwd(), 'src');
    const projectB = resolvePath(process.cwd(), 'test');
    let projectABackend = 'adapter';
    const service = createInstallerService({
      getProviderStatus: vi.fn((_providerId: CliProviderId, options) => {
        const resolvedBackendId =
          options?.projectPath === projectA ? projectABackend : 'opencode-cli';
        return Promise.resolve({
          ...createProviderStatus('opencode'),
          statusCheckOutcome: 'authoritative' as const,
          selectedBackendId: resolvedBackendId,
          resolvedBackendId,
        });
      }),
    });
    const { invoke } = setupHandlers(service);

    for (const projectPath of [projectA, projectB]) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'opencode',
        createProviderStatusRequest(projectPath, 'launch-proof')
      );
    }
    const staleProjectAEpoch = captureAuthoritativeProofEpoch(projectA);
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'opencode', providerBackendId: 'adapter', model: 'model-a' }],
    });
    const proofB = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectB),
      cwd: projectB,
      checks: [{ providerId: 'opencode', providerBackendId: 'opencode-cli', model: 'model-b' }],
    });

    projectABackend = 'api';
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'opencode',
      createProviderStatusRequest(projectA, 'launch-proof')
    );

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(proofB)).toBe(true);
    expect(() =>
      issueAuthoritativeModelExecutionProof({
        authorityEpoch: staleProjectAEpoch,
        cwd: projectA,
        checks: [{ providerId: 'opencode', providerBackendId: 'api', model: 'model-a' }],
      })
    ).toThrow('provider authority changed during preparation');
  });

  test('a projectless catalog change does not invalidate project-scoped proofs', async () => {
    const projectA = resolvePath(process.cwd(), 'src');
    let projectlessModels = ['global-model-v1'];
    const service = createInstallerService({
      getProviderStatus: vi.fn((_providerId: CliProviderId, options) =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative' as const,
          models: options?.projectPath ? ['project-model'] : projectlessModels,
        })
      ),
    });
    const { invoke } = setupHandlers(service);

    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(undefined, 'passive')
    );
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(projectA, 'launch-proof')
    );
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'project-model' }],
    });

    projectlessModels = ['global-model-v2'];
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(undefined, 'passive')
    );

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(true);
  });

  test('a projectless profile change invalidates every project scope', async () => {
    const projectA = resolvePath(process.cwd(), 'src');
    const projectB = resolvePath(process.cwd(), 'test');
    let selectedBackendId = 'codex-native';
    const service = createInstallerService({
      getProviderStatus: vi.fn(() =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative' as const,
          selectedBackendId,
          resolvedBackendId: selectedBackendId,
        })
      ),
    });
    const { invoke } = setupHandlers(service);

    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(undefined, 'passive')
    );
    const proofA = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectA),
      cwd: projectA,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'model-a' }],
    });
    const proofB = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(projectB),
      cwd: projectB,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'model-b' }],
    });

    selectedBackendId = 'api';
    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(undefined, 'passive')
    );

    expect(verifyAuthoritativeModelExecutionProof(proofA)).toBe(false);
    expect(verifyAuthoritativeModelExecutionProof(proofB)).toBe(false);
  });

  test('bounded scope removal fails closed for the removed project proof', async () => {
    const removedProject = process.cwd();
    const service = createInstallerService({
      getProviderStatus: vi.fn(() =>
        Promise.resolve({
          ...createProviderStatus('codex'),
          statusCheckOutcome: 'authoritative' as const,
        })
      ),
    });
    const { invoke } = setupHandlers(service);

    await invoke<IpcResult<CliProviderStatusIpcResponse>>(
      CLI_INSTALLER_GET_PROVIDER_STATUS,
      'codex',
      createProviderStatusRequest(removedProject, 'launch-proof')
    );
    const removedProof = issueAuthoritativeModelExecutionProof({
      authorityEpoch: captureAuthoritativeProofEpoch(removedProject),
      cwd: removedProject,
      checks: [{ providerId: 'codex', providerBackendId: 'codex-native', model: 'model' }],
    });

    for (let index = 1; index <= 128; index += 1) {
      await invoke<IpcResult<CliProviderStatusIpcResponse>>(
        CLI_INSTALLER_GET_PROVIDER_STATUS,
        'codex',
        createProviderStatusRequest(
          resolvePath(process.cwd(), `bounded-project-${index}`),
          'launch-proof'
        )
      );
    }

    expect(verifyAuthoritativeModelExecutionProof(removedProof)).toBe(false);
  });
});
