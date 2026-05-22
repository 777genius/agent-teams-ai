import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexAccountFeature } from '../../../../src/features/codex-account/main/composition/createCodexAccountFeature';

import type {
  CodexAccountLoginStatus,
  CodexAccountSnapshotDto,
  CodexLoginStateDto,
} from '@features/codex-account/contracts';

const {
  apiKeyHasPreferredMock,
  apiKeyLookupMock,
  binaryClearCacheMock,
  binaryResolveMock,
  detectLocalAccountStateMock,
  getCachedShellEnvMock,
  loginCancelMock,
  loginDisposeMock,
  loginSettledListeners,
  loginStartMock,
  loginStateContainer,
  loginStateListeners,
  logoutMock,
  readAccountMock,
  readAccountSnapshotMock,
  readRateLimitsMock,
  resolveInteractiveShellEnvBestEffortMock,
} = vi.hoisted(() => ({
  binaryResolveMock: vi.fn(),
  binaryClearCacheMock: vi.fn(),
  apiKeyHasPreferredMock: vi.fn(),
  apiKeyLookupMock: vi.fn(),
  detectLocalAccountStateMock: vi.fn(),
  getCachedShellEnvMock: vi.fn(),
  resolveInteractiveShellEnvBestEffortMock: vi.fn(),
  readAccountMock: vi.fn(),
  readAccountSnapshotMock: vi.fn(),
  readRateLimitsMock: vi.fn(),
  logoutMock: vi.fn(),
  loginStartMock: vi.fn(),
  loginCancelMock: vi.fn(),
  loginDisposeMock: vi.fn(),
  loginStateContainer: {
    current: {
      status: 'idle' as CodexAccountLoginStatus,
      error: null as string | null,
      startedAt: null as string | null,
      authUrl: null as string | null,
    } as CodexLoginStateDto,
  },
  loginStateListeners: new Set<() => void>(),
  loginSettledListeners: new Set<() => void>(),
}));

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCodexApiKey = process.env.CODEX_API_KEY;

function emitLoginState(nextState: CodexLoginStateDto): void {
  loginStateContainer.current = structuredClone(nextState);
  for (const listener of loginStateListeners) {
    listener();
  }
}

vi.mock('../../../../src/main/services/extensions', () => ({
  ApiKeyService: class MockApiKeyService {
    hasPreferred = apiKeyHasPreferredMock;
    lookupPreferred = apiKeyLookupMock;
  },
}));

vi.mock('../../../../src/main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/shellEnv')>();
  return {
    ...actual,
    getCachedShellEnv: getCachedShellEnvMock,
    resolveInteractiveShellEnvBestEffort: resolveInteractiveShellEnvBestEffortMock,
  };
});

vi.mock('../../../../src/main/services/infrastructure/codexAppServer', () => ({
  CodexBinaryResolver: {
    resolve: binaryResolveMock,
    clearCache: binaryClearCacheMock,
  },
  CodexAppServerSessionFactory: class MockCodexAppServerSessionFactory {},
  JsonRpcStdioClient: class MockJsonRpcStdioClient {},
}));

vi.mock(
  '../../../../src/features/codex-account/main/infrastructure/detectCodexLocalAccountArtifacts',
  () => ({
    detectCodexLocalAccountState: detectLocalAccountStateMock,
    detectCodexLocalAccountArtifacts: async () =>
      (await detectLocalAccountStateMock()).hasArtifacts,
    ensureCodexLegacyAuthFromActiveAccount: vi.fn().mockResolvedValue(null),
  })
);

vi.mock(
  '../../../../src/features/codex-account/main/infrastructure/CodexAccountAppServerClient',
  () => ({
    CodexAccountAppServerClient: class MockCodexAccountAppServerClient {
      readAccountSnapshot = readAccountSnapshotMock;
      readAccount = readAccountMock;
      readRateLimits = readRateLimitsMock;
      logout = logoutMock;
    },
  })
);

vi.mock(
  '../../../../src/features/codex-account/main/infrastructure/CodexLoginSessionManager',
  () => ({
    CodexLoginSessionManager: class MockCodexLoginSessionManager {
      subscribe(listener: () => void): () => void {
        loginStateListeners.add(listener);
        return (): void => {
          loginStateListeners.delete(listener);
        };
      }

      onSettled(listener: () => void): () => void {
        loginSettledListeners.add(listener);
        return (): void => {
          loginSettledListeners.delete(listener);
        };
      }

      getState(): CodexLoginStateDto {
        return structuredClone(loginStateContainer.current);
      }

      async start(): Promise<void> {
        await loginStartMock();
      }

      async cancel(): Promise<void> {
        await loginCancelMock();
      }

      async dispose(): Promise<void> {
        await loginDisposeMock();
      }
    },
  })
);

function createLoggerPort() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createConfigManager(preferredAuthMode: 'auto' | 'chatgpt' | 'api_key' = 'auto') {
  return {
    getConfig: () => ({
      providerConnections: {
        codex: {
          preferredAuthMode,
        },
      },
    }),
  };
}

function createAccountResponse(
  overrides?: Partial<{
    requiresOpenaiAuth: boolean;
    account: { type: 'chatgpt'; email: string; planType: 'pro' | 'plus' } | null;
  }>
) {
  return {
    account:
      overrides && 'account' in overrides
        ? (overrides.account ?? null)
        : {
            type: 'chatgpt' as const,
            email: 'user@example.com',
            planType: 'pro' as const,
          },
    requiresOpenaiAuth: overrides?.requiresOpenaiAuth ?? true,
  };
}

function createRateLimitsResponse() {
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: {
        usedPercent: 77,
        windowDurationMins: 300,
        resetsAt: 1_776_678_034,
      },
      secondary: null,
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: '0',
      },
      planType: 'pro' as const,
    },
    rateLimitsByLimitId: null,
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });

  if (!resolve || !reject) {
    throw new Error('Failed to create deferred promise.');
  }

  return {
    promise,
    resolve,
    reject,
  };
}

describe('createCodexAccountFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    binaryResolveMock.mockResolvedValue('/usr/local/bin/codex');
    binaryClearCacheMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({});
    apiKeyHasPreferredMock.mockResolvedValue(false);
    apiKeyLookupMock.mockResolvedValue(null);
    detectLocalAccountStateMock.mockResolvedValue({
      hasArtifacts: false,
      hasActiveChatgptAccount: false,
    });
    getCachedShellEnvMock.mockReturnValue({});
    readAccountSnapshotMock.mockReset();
    readAccountMock.mockReset();
    readRateLimitsMock.mockReset();
    logoutMock.mockReset();
    loginStartMock.mockReset();
    loginCancelMock.mockReset();
    loginDisposeMock.mockReset();
    loginStateContainer.current = {
      status: 'idle',
      error: null,
      startedAt: null,
      authUrl: null,
    };
    loginStateListeners.clear();
    loginSettledListeners.clear();
    readAccountSnapshotMock.mockImplementation(
      async (options: {
        binaryPath: string;
        env: NodeJS.ProcessEnv;
        refreshToken?: boolean;
        includeRateLimits?: boolean;
      }) => {
        const account = await readAccountMock(options);
        if (options.includeRateLimits !== true) {
          return {
            ...account,
            rateLimits: null,
          };
        }

        try {
          return {
            ...account,
            rateLimits: {
              ok: true,
              payload: await readRateLimitsMock(options),
            },
          };
        } catch (error) {
          return {
            ...account,
            rateLimits: {
              ok: false,
              error,
            },
          };
        }
      }
    );
  });

  afterAll(() => {
    if (typeof originalOpenAiApiKey === 'string') {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    if (typeof originalCodexApiKey === 'string') {
      process.env.CODEX_API_KEY = originalCodexApiKey;
    } else {
      delete process.env.CODEX_API_KEY;
    }
  });

  it('builds a healthy snapshot from app-server account truth, API-key availability, and rate limits', async () => {
    getCachedShellEnvMock.mockReturnValue({
      OPENAI_API_KEY: 'env-openai-key',
    });
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('auto'),
    });

    try {
      const snapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(snapshot).toMatchObject<Partial<CodexAccountSnapshotDto>>({
        preferredAuthMode: 'auto',
        effectiveAuthMode: 'chatgpt',
        appServerState: 'healthy',
        managedAccount: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        },
        runtimeContext: {
          binaryPath: '/usr/local/bin/codex',
          codexHome: '/Users/test/.codex',
        },
        launchAllowed: true,
        launchReadinessState: 'ready_both',
      });
      expect(snapshot.rateLimits?.planType).toBe('pro');
      expect(snapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({
          binaryPath: '/usr/local/bin/codex',
          refreshToken: false,
        })
      );
      expect(readRateLimitsMock).toHaveBeenCalledTimes(1);
    } finally {
      await feature.dispose();
    }
  });

  it('retries Codex binary discovery after cold shell env resolves before publishing runtime-missing', async () => {
    binaryResolveMock.mockResolvedValueOnce(null).mockResolvedValue('/usr/local/bin/codex');
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: '/usr/local/bin:/usr/bin:/bin',
    });
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const snapshot = await feature.refreshSnapshot();

      expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 12_000,
          fallbackEnv: process.env,
        })
      );
      expect(binaryClearCacheMock).toHaveBeenCalledTimes(1);
      expect(binaryResolveMock).toHaveBeenCalledTimes(2);
      expect(snapshot.appServerState).toBe('healthy');
      expect(snapshot.launchReadinessState).toBe('ready_chatgpt');
      expect(snapshot.launchIssueMessage).toBeNull();
    } finally {
      await feature.dispose();
    }
  });

  it('still reports runtime-missing after the cold binary retry cannot find Codex', async () => {
    binaryResolveMock.mockResolvedValue(null);
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: '/usr/bin:/bin',
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const snapshot = await feature.refreshSnapshot();

      expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledTimes(1);
      expect(binaryClearCacheMock).toHaveBeenCalledTimes(1);
      expect(binaryResolveMock).toHaveBeenCalledTimes(2);
      expect(snapshot.appServerState).toBe('runtime-missing');
      expect(snapshot.launchReadinessState).toBe('runtime_missing');
      expect(snapshot.launchIssueMessage).toContain('Codex CLI not found');
    } finally {
      await feature.dispose();
    }
  });

  it('keeps the last known Codex account when binary discovery transiently misses after a healthy snapshot', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: '/usr/bin:/bin',
    });
    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot();

      binaryResolveMock.mockResolvedValue(null);
      dateNowSpy.mockReturnValue(1_776_000_020_000);
      const secondSnapshot = await feature.refreshSnapshot({ forceRefreshToken: true });

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.appServerState).toBe('healthy');
      expect(secondSnapshot.launchReadinessState).toBe('ready_chatgpt');
      expect(secondSnapshot.launchAllowed).toBe(true);
      expect(secondSnapshot.launchIssueMessage).toBeNull();
      expect(secondSnapshot.managedAccount).toMatchObject({
        type: 'chatgpt',
        email: 'user@example.com',
      });
      expect(secondSnapshot.runtimeContext).toEqual({
        binaryPath: '/usr/local/bin/codex',
        codexHome: '/Users/test/.codex',
      });
      expect(readAccountMock).toHaveBeenCalledTimes(1);
      expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledTimes(1);
      expect(binaryClearCacheMock).toHaveBeenCalledTimes(1);
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('reports runtime-missing once the last known Codex runtime is too old to trust', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: '/usr/bin:/bin',
    });
    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      await feature.refreshSnapshot();

      binaryResolveMock.mockResolvedValue(null);
      dateNowSpy.mockReturnValue(1_776_000_060_001);
      const snapshot = await feature.refreshSnapshot({ forceRefreshToken: true });

      expect(snapshot.appServerState).toBe('runtime-missing');
      expect(snapshot.launchReadinessState).toBe('runtime_missing');
      expect(snapshot.launchIssueMessage).toContain('Codex CLI not found');
      expect(snapshot.managedAccount).toBeNull();
      expect(readAccountMock).toHaveBeenCalledTimes(1);
      expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledTimes(1);
      expect(binaryClearCacheMock).toHaveBeenCalledTimes(1);
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('reuses a fresh refresh snapshot when the request does not need stronger data', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const firstSnapshot = await feature.refreshSnapshot();
      const secondSnapshot = await feature.refreshSnapshot();

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(readAccountMock).toHaveBeenCalledTimes(1);
      expect(readAccountSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      await feature.dispose();
    }
  });

  it('does not reuse a snapshot without rate limits for an includeRateLimits refresh', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const firstSnapshot = await feature.refreshSnapshot();
      const secondSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(firstSnapshot.rateLimits).toBeNull();
      expect(secondSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readAccountMock).toHaveBeenCalledTimes(2);
      expect(readRateLimitsMock).toHaveBeenCalledTimes(1);
      expect(readAccountSnapshotMock.mock.calls[1]?.[0]).toMatchObject({
        includeRateLimits: true,
      });
    } finally {
      await feature.dispose();
    }
  });

  it('force-refreshes account truth even when a fresh snapshot exists', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      await feature.refreshSnapshot();
      await feature.refreshSnapshot({ forceRefreshToken: true });

      expect(readAccountMock).toHaveBeenCalledTimes(2);
      expect(readAccountMock.mock.calls[1]?.[0]).toMatchObject({
        refreshToken: true,
      });
    } finally {
      await feature.dispose();
    }
  });

  it('does not serve stale cached auth state while logout mutation is active', async () => {
    const logoutDeferred = createDeferred<void>();
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockResolvedValue({
        account: createAccountResponse({ account: null, requiresOpenaiAuth: false }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    logoutMock.mockReturnValue(logoutDeferred.promise);
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const initialSnapshot = await feature.refreshSnapshot();
      expect(initialSnapshot.managedAccount?.email).toBe('user@example.com');

      const logoutPromise = feature.logout();
      await vi.waitFor(() => {
        expect(logoutMock).toHaveBeenCalledTimes(1);
      });

      let refreshSettled = false;
      const refreshDuringLogout = feature.refreshSnapshot().then((snapshot) => {
        refreshSettled = true;
        return snapshot;
      });
      await Promise.resolve();

      expect(refreshSettled).toBe(false);

      logoutDeferred.resolve();
      const [duringLogoutSnapshot, afterLogoutSnapshot] = await Promise.all([
        refreshDuringLogout,
        logoutPromise,
      ]);

      expect(duringLogoutSnapshot.managedAccount).toBeNull();
      expect(afterLogoutSnapshot.managedAccount).toBeNull();
      expect(afterLogoutSnapshot.requiresOpenaiAuth).toBe(false);
      expect(readAccountMock.mock.calls.at(-1)?.[0]).toMatchObject({
        refreshToken: true,
      });
    } finally {
      await feature.dispose();
    }
  });

  it('coalesces mixed snapshot callers and preserves auth truth across logout end-to-end', async () => {
    const firstRead = createDeferred<{
      account: ReturnType<typeof createAccountResponse>;
      initialize: { codexHome: string; platformFamily: string; platformOs: string };
    }>();
    const healthyRead = {
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    };
    readAccountMock
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(healthyRead)
      .mockResolvedValueOnce({
        account: createAccountResponse({ account: null, requiresOpenaiAuth: false }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());
    logoutMock.mockResolvedValue({});

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const passiveSnapshot = feature.getSnapshot();
      const rateLimitedSnapshot = feature.refreshSnapshot({ includeRateLimits: true });
      const launchReadiness = feature.getLaunchReadiness();

      await vi.waitFor(() => {
        expect(readAccountMock).toHaveBeenCalledTimes(1);
      });
      firstRead.resolve(healthyRead);

      const [passiveResult, rateLimitedResult, readinessResult] = await Promise.all([
        passiveSnapshot,
        rateLimitedSnapshot,
        launchReadiness,
      ]);

      expect(passiveResult.managedAccount?.email).toBe('user@example.com');
      expect(rateLimitedResult.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readinessResult.launchAllowed).toBe(true);
      expect(readAccountMock).toHaveBeenCalledTimes(2);
      expect(readRateLimitsMock).toHaveBeenCalledTimes(1);

      const cachedRateLimitedResult = await feature.refreshSnapshot({ includeRateLimits: true });
      expect(cachedRateLimitedResult.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readAccountMock).toHaveBeenCalledTimes(2);
      expect(readRateLimitsMock).toHaveBeenCalledTimes(1);

      const logoutResult = await feature.logout();
      expect(logoutResult.managedAccount).toBeNull();
      expect(logoutResult.requiresOpenaiAuth).toBe(false);
      expect(logoutResult.launchAllowed).toBe(false);
      expect(readAccountMock).toHaveBeenCalledTimes(3);
      expect(readAccountMock.mock.calls.at(-1)?.[0]).toMatchObject({
        refreshToken: true,
      });

      const cachedLoggedOutResult = await feature.getSnapshot();
      expect(cachedLoggedOutResult.managedAccount).toBeNull();
      expect(readAccountMock).toHaveBeenCalledTimes(3);
    } finally {
      await feature.dispose();
    }
  });

  it('keeps account snapshot healthy when the optional rate limits read fails', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock.mockRejectedValue(new Error('rate limit service unavailable'));
    const logger = createLoggerPort();

    const feature = createCodexAccountFeature({
      logger,
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const snapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(snapshot.appServerState).toBe('healthy');
      expect(snapshot.managedAccount?.email).toBe('user@example.com');
      expect(snapshot.rateLimits).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('codex account rate limits refresh failed', {
        error: 'rate limit service unavailable',
      });
    } finally {
      await feature.dispose();
    }
  });

  it('keeps last known rate limits visible during a transient optional rate limit refresh failure', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock
      .mockResolvedValueOnce(createRateLimitsResponse())
      .mockRejectedValueOnce(
        new Error('codex account authentication required to read rate limits')
      );
    const logger = createLoggerPort();
    const feature = createCodexAccountFeature({
      logger,
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });
      dateNowSpy.mockReturnValue(1_776_000_060_000);
      const secondSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(firstSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(secondSnapshot.appServerState).toBe('healthy');
      expect(secondSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(logger.warn).toHaveBeenCalledWith('codex account rate limits refresh failed', {
        error: 'codex account authentication required to read rate limits',
      });
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('keeps rate limits visible when account truth is temporarily reused from last known state', async () => {
    detectLocalAccountStateMock.mockResolvedValue({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockResolvedValueOnce({
        account: createAccountResponse({ account: null, requiresOpenaiAuth: true }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());
    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });
      dateNowSpy.mockReturnValue(1_776_000_060_000);
      const secondSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(firstSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(secondSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readRateLimitsMock).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('keeps last known rate limits visible during a transient empty rate limit response', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock.mockResolvedValueOnce(createRateLimitsResponse()).mockResolvedValueOnce({
      rateLimits: null,
      rateLimitsByLimitId: null,
    });
    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });
      dateNowSpy.mockReturnValue(1_776_000_060_000);
      const secondSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(firstSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(secondSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readRateLimitsMock).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('does not reuse stale rate limits after the active ChatGPT account changes', async () => {
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse({
          account: {
            type: 'chatgpt',
            email: 'first@example.com',
            planType: 'pro',
          },
        }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockResolvedValueOnce({
        account: createAccountResponse({
          account: {
            type: 'chatgpt',
            email: 'second@example.com',
            planType: 'pro',
          },
        }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    readRateLimitsMock
      .mockResolvedValueOnce(createRateLimitsResponse())
      .mockRejectedValueOnce(new Error('rate limit service unavailable'));
    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });
      dateNowSpy.mockReturnValue(1_776_000_060_000);
      const secondSnapshot = await feature.refreshSnapshot({ includeRateLimits: true });

      expect(firstSnapshot.managedAccount?.email).toBe('first@example.com');
      expect(firstSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(secondSnapshot.managedAccount?.email).toBe('second@example.com');
      expect(secondSnapshot.rateLimits).toBeNull();
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('keeps the last known managed account during a transient degraded read', async () => {
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockRejectedValueOnce(new Error('temporary app-server timeout'));

    const logger = createLoggerPort();
    const feature = createCodexAccountFeature({
      logger,
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const firstSnapshot = await feature.refreshSnapshot();
      const degradedSnapshot = await feature.refreshSnapshot({ forceRefreshToken: true });

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(degradedSnapshot.appServerState).toBe('degraded');
      expect(degradedSnapshot.appServerStatusMessage).toContain('temporary app-server timeout');
      expect(degradedSnapshot.managedAccount).toMatchObject({
        type: 'chatgpt',
        email: 'user@example.com',
      });
      expect(degradedSnapshot.runtimeContext).toEqual({
        binaryPath: '/usr/local/bin/codex',
        codexHome: '/Users/test/.codex',
      });
      expect(degradedSnapshot.launchAllowed).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('false logout'),
        expect.anything()
      );
    } finally {
      await feature.dispose();
    }
  });

  it('keeps the last known ChatGPT managed account during a transient empty account read after HMR-style reconnect flicker', async () => {
    detectLocalAccountStateMock.mockResolvedValue({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockResolvedValueOnce({
        account: createAccountResponse({ account: null, requiresOpenaiAuth: true }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });
    const dateNowSpy = vi.spyOn(Date, 'now');

    try {
      dateNowSpy.mockReturnValue(1_776_000_000_000);
      const firstSnapshot = await feature.refreshSnapshot();
      dateNowSpy.mockReturnValue(1_776_000_006_000);
      const secondSnapshot = await feature.refreshSnapshot({ forceRefreshToken: true });

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.managedAccount).toMatchObject({
        type: 'chatgpt',
        email: 'user@example.com',
      });
      expect(secondSnapshot.launchAllowed).toBe(true);
      expect(secondSnapshot.launchReadinessState).toBe('ready_chatgpt');
      expect(secondSnapshot.launchIssueMessage).toBeNull();
      expect(readAccountMock).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
      await feature.dispose();
    }
  });

  it('classifies a locally selected ChatGPT account without a usable managed session as reconnect-needed', async () => {
    detectLocalAccountStateMock.mockResolvedValue({
      hasArtifacts: true,
      hasActiveChatgptAccount: true,
    });
    readAccountMock.mockResolvedValue({
      account: createAccountResponse({ account: null, requiresOpenaiAuth: true }),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const snapshot = await feature.refreshSnapshot();

      expect(snapshot.localAccountArtifactsPresent).toBe(true);
      expect(snapshot.localActiveChatgptAccountPresent).toBe(true);
      expect(snapshot.launchAllowed).toBe(false);
      expect(snapshot.launchReadinessState).toBe('missing_auth');
      expect(snapshot.launchIssueMessage).toContain('Reconnect ChatGPT');
    } finally {
      await feature.dispose();
    }
  });

  it('runs a stronger queued refresh after a passive read is already in flight', async () => {
    let resolveFirstRead: ((value: unknown) => void) | null = null;
    readAccountMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          })
      )
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('auto'),
    });

    try {
      const firstRefresh = feature.refreshSnapshot();
      const strongerRefresh = feature.refreshSnapshot({
        includeRateLimits: true,
        forceRefreshToken: true,
      });

      await vi.waitFor(() => {
        expect(resolveFirstRead).not.toBeNull();
      });

      const completeFirstRead = resolveFirstRead as ((value: unknown) => void) | null;
      if (!completeFirstRead) {
        throw new Error('Expected the first account read to remain pending.');
      }

      completeFirstRead({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });

      const [firstSnapshot, strongerSnapshot] = await Promise.all([firstRefresh, strongerRefresh]);

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(strongerSnapshot.rateLimits?.primary?.usedPercent).toBe(77);
      expect(readAccountMock).toHaveBeenCalledTimes(2);
      expect(readAccountMock.mock.calls[0]?.[0]).toMatchObject({
        refreshToken: false,
      });
      expect(readAccountMock.mock.calls[1]?.[0]).toMatchObject({
        refreshToken: true,
      });
      expect(readRateLimitsMock).toHaveBeenCalledTimes(1);
    } finally {
      await feature.dispose();
    }
  });

  it('logs out and refreshes to the new logged-out truth instead of keeping stale account state', async () => {
    readAccountMock
      .mockResolvedValueOnce({
        account: createAccountResponse(),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      .mockResolvedValueOnce({
        account: createAccountResponse({ account: null, requiresOpenaiAuth: false }),
        initialize: {
          codexHome: '/Users/test/.codex',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());
    logoutMock.mockResolvedValue({});

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      const initialSnapshot = await feature.refreshSnapshot();
      const afterLogout = await feature.logout();

      expect(initialSnapshot.managedAccount?.type).toBe('chatgpt');
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(afterLogout.managedAccount).toBeNull();
      expect(afterLogout.requiresOpenaiAuth).toBe(false);
      expect(afterLogout.launchAllowed).toBe(false);
      expect(afterLogout.launchReadinessState).toBe('missing_auth');
      expect(readAccountMock.mock.calls.at(-1)?.[0]).toMatchObject({
        refreshToken: true,
      });
    } finally {
      await feature.dispose();
    }
  });

  it('publishes the pending login state immediately after login start without waiting for a full refresh', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    loginStartMock.mockImplementation(() => {
      emitLoginState({
        status: 'pending',
        error: null,
        startedAt: '2026-04-20T12:00:00.000Z',
        authUrl: 'https://chatgpt.com/auth',
      });
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      await feature.refreshSnapshot();
      const pendingSnapshot = await feature.startChatgptLogin();

      expect(pendingSnapshot.login).toMatchObject({
        status: 'pending',
        startedAt: '2026-04-20T12:00:00.000Z',
        authUrl: 'https://chatgpt.com/auth',
      });
      expect(loginStartMock).toHaveBeenCalledTimes(1);
    } finally {
      await feature.dispose();
    }
  });

  it('publishes a cancelled login snapshot immediately and then forces a settled refresh', async () => {
    readAccountMock.mockResolvedValue({
      account: createAccountResponse(),
      initialize: {
        codexHome: '/Users/test/.codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    readRateLimitsMock.mockResolvedValue(createRateLimitsResponse());
    emitLoginState({
      status: 'pending',
      error: null,
      startedAt: '2026-04-20T12:00:00.000Z',
      authUrl: 'https://chatgpt.com/auth',
    });
    loginCancelMock.mockImplementation(() => {
      emitLoginState({
        status: 'cancelled',
        error: null,
        startedAt: null,
        authUrl: null,
      });
      for (const listener of loginSettledListeners) {
        listener();
      }
    });

    const feature = createCodexAccountFeature({
      logger: createLoggerPort(),
      configManager: createConfigManager('chatgpt'),
    });

    try {
      await feature.refreshSnapshot();
      const cancelledSnapshot = await feature.cancelLogin();

      expect(loginCancelMock).toHaveBeenCalledTimes(1);
      expect(cancelledSnapshot.login).toMatchObject({
        status: 'cancelled',
        error: null,
        startedAt: null,
      });

      await vi.waitFor(() => {
        expect(
          readAccountMock.mock.calls.some(
            (call) => (call[0] as { refreshToken?: boolean } | undefined)?.refreshToken === true
          )
        ).toBe(true);
      });
    } finally {
      await feature.dispose();
    }
  });
});
