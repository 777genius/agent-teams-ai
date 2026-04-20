import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCodexAccountFeature } from '../../../../src/features/codex-account/main/composition/createCodexAccountFeature';

import type {
  CodexAccountLoginStatus,
  CodexAccountSnapshotDto,
  CodexLoginStateDto,
} from '@features/codex-account/contracts';

const {
  apiKeyLookupMock,
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
  readRateLimitsMock,
} = vi.hoisted(() => ({
  binaryResolveMock: vi.fn(),
  apiKeyLookupMock: vi.fn(),
  detectLocalAccountStateMock: vi.fn(),
  getCachedShellEnvMock: vi.fn(),
  readAccountMock: vi.fn(),
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
    },
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
    lookupPreferred = apiKeyLookupMock;
  },
}));

vi.mock('../../../../src/main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/utils/shellEnv')>();
  return {
    ...actual,
    getCachedShellEnv: getCachedShellEnvMock,
  };
});

vi.mock('../../../../src/main/services/infrastructure/codexAppServer', () => ({
  CodexBinaryResolver: {
    resolve: binaryResolveMock,
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
  })
);

vi.mock(
  '../../../../src/features/codex-account/main/infrastructure/CodexAccountAppServerClient',
  () => ({
    CodexAccountAppServerClient: class MockCodexAccountAppServerClient {
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

function createAccountResponse(overrides?: Partial<{
  requiresOpenaiAuth: boolean;
  account: { type: 'chatgpt'; email: string; planType: 'pro' | 'plus' } | null;
}>) {
  return {
    account:
      overrides && 'account' in overrides
        ? overrides.account ?? null
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

describe('createCodexAccountFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    binaryResolveMock.mockResolvedValue('/usr/local/bin/codex');
    apiKeyLookupMock.mockResolvedValue(null);
    detectLocalAccountStateMock.mockResolvedValue({
      hasArtifacts: false,
      hasActiveChatgptAccount: false,
    });
    getCachedShellEnvMock.mockReturnValue({});
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
    };
    loginStateListeners.clear();
    loginSettledListeners.clear();
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

    try {
      const firstSnapshot = await feature.refreshSnapshot();
      const secondSnapshot = await feature.refreshSnapshot();

      expect(firstSnapshot.managedAccount?.email).toBe('user@example.com');
      expect(secondSnapshot.managedAccount).toMatchObject({
        type: 'chatgpt',
        email: 'user@example.com',
      });
      expect(secondSnapshot.launchAllowed).toBe(true);
      expect(secondSnapshot.launchReadinessState).toBe('ready_chatgpt');
      expect(secondSnapshot.launchIssueMessage).toBeNull();
    } finally {
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
    });
    loginCancelMock.mockImplementation(() => {
      emitLoginState({
        status: 'cancelled',
        error: null,
        startedAt: null,
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
