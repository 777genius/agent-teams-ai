import {
  type CodexAccountAuthMode,
  type CodexAccountSnapshotDto,
  type CodexApiKeyAvailabilityDto,
  type CodexCreditsSnapshotDto,
  type CodexLoginStateDto,
  type CodexManagedAccountDto,
  type CodexRateLimitSnapshotDto,
  type CodexRateLimitWindowDto,
} from '@features/codex-account/contracts';
import {
  type CodexLaunchReadinessResult,
  evaluateCodexLaunchReadiness,
} from '@features/codex-account/core/domain/evaluateCodexLaunchReadiness';
import { ApiKeyService } from '@main/services/extensions';
import {
  type CodexAppServerGetAccountRateLimitsResponse,
  type CodexAppServerGetAccountResponse,
  type CodexAppServerRateLimitSnapshot,
  CodexAppServerSessionFactory,
  CodexBinaryResolver,
  JsonRpcStdioClient,
} from '@main/services/infrastructure/codexAppServer';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import { CodexAccountSnapshotPresenter } from '../adapters/output/presenters/CodexAccountSnapshotPresenter';
import { CodexAccountAppServerClient } from '../infrastructure/CodexAccountAppServerClient';
import { CodexAccountEnvBuilder } from '../infrastructure/CodexAccountEnvBuilder';
import { CodexLoginSessionManager } from '../infrastructure/CodexLoginSessionManager';
import { detectCodexLocalAccountState } from '../infrastructure/detectCodexLocalAccountArtifacts';

import type { Logger } from '@shared/utils/logger';
import type { BrowserWindow } from 'electron';

type LoggerPort = Pick<Logger, 'info' | 'warn' | 'error'>;

const SNAPSHOT_CACHE_TTL_MS = 5_000;
const RATE_LIMITS_CACHE_TTL_MS = 45_000;
const LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS = 60_000;

interface CodexLastKnownAccount {
  payload: CodexAppServerGetAccountResponse;
  observedAt: number;
}

interface CodexLastKnownRateLimits {
  payload: CodexAppServerGetAccountRateLimitsResponse;
  observedAt: number;
}

interface CodexSnapshotRefreshOptions {
  includeRateLimits: boolean;
  forceRefreshToken: boolean;
}

function hasChatgptManagedAccount(
  payload: CodexAppServerGetAccountResponse | null | undefined
): boolean {
  return payload?.account?.type === 'chatgpt';
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function asCodexManagedAccount(
  account: CodexAppServerGetAccountResponse['account']
): CodexManagedAccountDto | null {
  if (!account) {
    return null;
  }

  if (account.type === 'apiKey') {
    return {
      type: 'api_key',
      email: null,
      planType: null,
    };
  }

  return {
    type: 'chatgpt',
    email: account.email,
    planType: account.planType,
  };
}

function asRateLimitWindow(
  window: CodexAppServerRateLimitSnapshot['primary']
): CodexRateLimitWindowDto | null {
  if (!window) {
    return null;
  }

  return {
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
  };
}

function asCreditsSnapshot(
  credits: CodexAppServerRateLimitSnapshot['credits']
): CodexCreditsSnapshotDto | null {
  if (!credits) {
    return null;
  }

  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: credits.balance,
  };
}

function asRateLimits(
  snapshot: CodexAppServerRateLimitSnapshot | null
): CodexRateLimitSnapshotDto | null {
  if (!snapshot) {
    return null;
  }

  return {
    limitId: snapshot.limitId,
    limitName: snapshot.limitName,
    primary: asRateLimitWindow(snapshot.primary),
    secondary: asRateLimitWindow(snapshot.secondary),
    credits: asCreditsSnapshot(snapshot.credits),
    planType: snapshot.planType,
  };
}

function getPreferredAuthMode(configManager: {
  getConfig: () => {
    providerConnections: {
      codex: {
        preferredAuthMode?: CodexAccountAuthMode;
      };
    };
  };
}): CodexAccountAuthMode {
  return configManager.getConfig().providerConnections.codex.preferredAuthMode ?? 'auto';
}

function classifyAppServerFailure(error: unknown): {
  appServerState: CodexAccountSnapshotDto['appServerState'];
  appServerStatusMessage: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('unknown method') ||
    lower.includes('method not found') ||
    lower.includes('unknown command') ||
    lower.includes('no such command')
  ) {
    return {
      appServerState: 'incompatible',
      appServerStatusMessage:
        'The installed Codex binary does not support app-server account management yet.',
    };
  }

  return {
    appServerState: 'degraded',
    appServerStatusMessage: message,
  };
}

function normalizeRefreshOptions(options?: {
  includeRateLimits?: boolean;
  forceRefreshToken?: boolean;
}): CodexSnapshotRefreshOptions {
  return {
    includeRateLimits: options?.includeRateLimits === true,
    forceRefreshToken: options?.forceRefreshToken === true,
  };
}

function mergeRefreshOptions(
  current: CodexSnapshotRefreshOptions | null,
  next: CodexSnapshotRefreshOptions
): CodexSnapshotRefreshOptions {
  if (!current) {
    return next;
  }

  return {
    includeRateLimits: current.includeRateLimits || next.includeRateLimits,
    forceRefreshToken: current.forceRefreshToken || next.forceRefreshToken,
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });

  if (!resolve) {
    throw new Error('Failed to create deferred promise.');
  }

  return {
    promise,
    resolve,
  };
}

export interface CodexAccountFeatureFacade {
  getSnapshot(): Promise<CodexAccountSnapshotDto>;
  refreshSnapshot(options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<CodexAccountSnapshotDto>;
  startChatgptLogin(): Promise<CodexAccountSnapshotDto>;
  cancelLogin(): Promise<CodexAccountSnapshotDto>;
  logout(): Promise<CodexAccountSnapshotDto>;
  subscribe(listener: (snapshot: CodexAccountSnapshotDto) => void): () => void;
  setMainWindow(window: BrowserWindow | null): void;
  getLaunchReadiness(): Promise<CodexLaunchReadinessResult>;
  dispose(): Promise<void>;
}

class CodexAccountFeatureFacadeImpl implements CodexAccountFeatureFacade {
  private readonly listeners = new Set<(snapshot: CodexAccountSnapshotDto) => void>();
  private readonly presenter = new CodexAccountSnapshotPresenter();
  private readonly envBuilder = new CodexAccountEnvBuilder();
  private readonly appServerClient: CodexAccountAppServerClient;
  private readonly loginSessionManager: CodexLoginSessionManager;

  private snapshotCache: CodexAccountSnapshotDto | null = null;
  private snapshotObservedAt = 0;
  private refreshPromise: Promise<CodexAccountSnapshotDto> | null = null;
  private pendingRefreshOptions: CodexSnapshotRefreshOptions | null = null;
  private lastKnownAccount: CodexLastKnownAccount | null = null;
  private lastKnownRateLimits: CodexLastKnownRateLimits | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationQueueRelease: (() => void) | null = null;
  private activeMutationCount = 0;

  constructor(
    private readonly logger: LoggerPort,
    private readonly configManager: {
      getConfig: () => {
        providerConnections: {
          codex: {
            preferredAuthMode?: CodexAccountAuthMode;
          };
        };
      };
    },
    private readonly apiKeyService = new ApiKeyService()
  ) {
    const sessionFactory = new CodexAppServerSessionFactory(new JsonRpcStdioClient(logger));
    this.appServerClient = new CodexAccountAppServerClient(sessionFactory);
    this.loginSessionManager = new CodexLoginSessionManager(sessionFactory, logger);

    this.loginSessionManager.subscribe(() => {
      void this.emitCurrentSnapshot();
    });
    this.loginSessionManager.onSettled(() => {
      void this.refreshSnapshot({
        includeRateLimits: true,
        forceRefreshToken: true,
      });
    });
  }

  async getSnapshot(): Promise<CodexAccountSnapshotDto> {
    if (this.snapshotCache && Date.now() - this.snapshotObservedAt <= SNAPSHOT_CACHE_TTL_MS) {
      return deepClone(this.snapshotCache);
    }

    return this.refreshSnapshot();
  }

  async refreshSnapshot(options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<CodexAccountSnapshotDto> {
    this.pendingRefreshOptions = mergeRefreshOptions(
      this.pendingRefreshOptions,
      normalizeRefreshOptions(options)
    );

    if (!this.refreshPromise) {
      this.refreshPromise = this.drainRefreshQueue().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  async startChatgptLogin(): Promise<CodexAccountSnapshotDto> {
    let binaryMissing = false;
    await this.runSerializedMutation(async () => {
      const binaryPath = await CodexBinaryResolver.resolve();
      if (!binaryPath) {
        binaryMissing = true;
        return;
      }

      const env = this.envBuilder.buildControlPlaneEnv({ binaryPath });
      await this.loginSessionManager.start({ binaryPath, env });
    });

    if (binaryMissing) {
      return this.loadSnapshot();
    }

    return this.emitCurrentSnapshot();
  }

  async cancelLogin(): Promise<CodexAccountSnapshotDto> {
    await this.runSerializedMutation(async () => {
      await this.loginSessionManager.cancel();
    });

    return this.emitCurrentSnapshot();
  }

  async logout(): Promise<CodexAccountSnapshotDto> {
    await this.runSerializedMutation(async () => {
      await this.loginSessionManager.cancel().catch(() => undefined);

      const binaryPath = await CodexBinaryResolver.resolve();
      if (!binaryPath) {
        throw new Error('Codex CLI is not available, so logout cannot be completed.');
      }

      const env = this.envBuilder.buildControlPlaneEnv({ binaryPath });
      await this.appServerClient.logout({ binaryPath, env });
      this.lastKnownAccount = null;
      this.lastKnownRateLimits = null;
      await this.publishLoggedOutSnapshot();
    });

    return this.refreshSnapshot({ includeRateLimits: true, forceRefreshToken: true });
  }

  subscribe(listener: (snapshot: CodexAccountSnapshotDto) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.presenter.setMainWindow(window);
  }

  async getLaunchReadiness(): Promise<CodexLaunchReadinessResult> {
    const snapshot = await this.getSnapshot();
    return evaluateCodexLaunchReadiness({
      preferredAuthMode: snapshot.preferredAuthMode,
      managedAccount: snapshot.managedAccount,
      apiKey: snapshot.apiKey,
      appServerState: snapshot.appServerState,
      appServerStatusMessage: snapshot.appServerStatusMessage,
      localActiveChatgptAccountPresent: snapshot.localActiveChatgptAccountPresent,
    });
  }

  async dispose(): Promise<void> {
    await this.loginSessionManager.dispose();
    this.listeners.clear();
    this.snapshotCache = null;
    this.refreshPromise = null;
    this.pendingRefreshOptions = null;
    this.lastKnownAccount = null;
    this.lastKnownRateLimits = null;
    this.activeMutationCount = 0;
    if (this.mutationQueueRelease) {
      this.mutationQueueRelease();
      this.mutationQueueRelease = null;
    }
    this.mutationQueue = Promise.resolve();
  }

  private async drainRefreshQueue(): Promise<CodexAccountSnapshotDto> {
    let lastSnapshot: CodexAccountSnapshotDto | null = null;

    while (this.pendingRefreshOptions) {
      const nextOptions = this.pendingRefreshOptions;
      this.pendingRefreshOptions = null;
      await this.mutationQueue.catch(() => undefined);

      lastSnapshot = await this.loadSnapshot(nextOptions);
    }

    if (!lastSnapshot) {
      if (this.snapshotCache) {
        return deepClone(this.snapshotCache);
      }
      return this.loadSnapshot();
    }

    return lastSnapshot;
  }

  private async loadSnapshot(options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<CodexAccountSnapshotDto> {
    const preferredAuthMode = getPreferredAuthMode(this.configManager);
    const apiKey = await this.loadApiKeyAvailability();
    const localAccountState = await detectCodexLocalAccountState();
    const localAccountArtifactsPresent = localAccountState.hasArtifacts;
    const localActiveChatgptAccountPresent = localAccountState.hasActiveChatgptAccount;
    const binaryPath = await CodexBinaryResolver.resolve();
    const login = this.loginSessionManager.getState();
    const now = Date.now();

    if (!binaryPath) {
      const snapshot = this.setSnapshot({
        preferredAuthMode,
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Codex CLI not found. Install Codex to use native account management.',
        launchReadinessState: 'runtime_missing',
        appServerState: 'runtime-missing',
        appServerStatusMessage:
          'Codex CLI not found. Install Codex to use native account management.',
        managedAccount: null,
        apiKey,
        requiresOpenaiAuth: null,
        localAccountArtifactsPresent,
        localActiveChatgptAccountPresent,
        login,
        rateLimits: null,
        updatedAt: new Date(now).toISOString(),
      });
      return snapshot;
    }

    const env = this.envBuilder.buildControlPlaneEnv({ binaryPath });
    let appServerState: CodexAccountSnapshotDto['appServerState'] = 'healthy';
    let appServerStatusMessage: string | null = null;
    let accountPayload = this.lastKnownAccount?.payload ?? null;
    let requiresOpenaiAuth: boolean | null = accountPayload?.requiresOpenaiAuth ?? null;

    try {
      const accountResult = await this.appServerClient.readAccount({
        binaryPath,
        env,
        refreshToken: options?.forceRefreshToken ?? false,
      });
      const canReuseLastKnownManagedAccount =
        options?.forceRefreshToken !== true &&
        localActiveChatgptAccountPresent &&
        accountResult.account.account == null &&
        accountResult.account.requiresOpenaiAuth === true &&
        this.lastKnownAccount !== null &&
        now - this.lastKnownAccount.observedAt <= LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS &&
        hasChatgptManagedAccount(this.lastKnownAccount.payload);

      if (canReuseLastKnownManagedAccount) {
        accountPayload = this.lastKnownAccount!.payload;
        requiresOpenaiAuth = this.lastKnownAccount!.payload.requiresOpenaiAuth;
      } else {
        accountPayload = accountResult.account;
        requiresOpenaiAuth = accountResult.account.requiresOpenaiAuth;
        this.lastKnownAccount = {
          payload: accountResult.account,
          observedAt: now,
        };
      }
    } catch (error) {
      const failure = classifyAppServerFailure(error);
      appServerState = failure.appServerState;
      appServerStatusMessage = failure.appServerStatusMessage;

      if (
        !this.lastKnownAccount ||
        now - this.lastKnownAccount.observedAt > LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS
      ) {
        accountPayload = null;
        requiresOpenaiAuth = null;
      } else {
        accountPayload = this.lastKnownAccount.payload;
        requiresOpenaiAuth = this.lastKnownAccount.payload.requiresOpenaiAuth;
      }
    }

    let rateLimits: CodexRateLimitSnapshotDto | null = null;
    const shouldLoadRateLimits =
      options?.includeRateLimits === true ||
      (this.lastKnownRateLimits !== null &&
        now - this.lastKnownRateLimits.observedAt <= RATE_LIMITS_CACHE_TTL_MS);

    if (shouldLoadRateLimits) {
      try {
        if (
          this.lastKnownRateLimits &&
          now - this.lastKnownRateLimits.observedAt <= RATE_LIMITS_CACHE_TTL_MS
        ) {
          rateLimits = asRateLimits(this.lastKnownRateLimits.payload.rateLimits);
        } else {
          const rateLimitsPayload = await this.appServerClient.readRateLimits({
            binaryPath,
            env,
          });
          this.lastKnownRateLimits = {
            payload: rateLimitsPayload,
            observedAt: now,
          };
          rateLimits = asRateLimits(rateLimitsPayload.rateLimits);
        }
      } catch (error) {
        this.logger.warn('codex account rate limits refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        rateLimits = this.lastKnownRateLimits
          ? asRateLimits(this.lastKnownRateLimits.payload.rateLimits)
          : null;
      }
    }

    const managedAccount = asCodexManagedAccount(accountPayload?.account ?? null);
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode,
      managedAccount,
      apiKey,
      appServerState,
      appServerStatusMessage,
      localActiveChatgptAccountPresent,
    });

    const snapshot = this.setSnapshot({
      preferredAuthMode,
      effectiveAuthMode: readiness.effectiveAuthMode,
      launchAllowed: readiness.launchAllowed,
      launchIssueMessage: readiness.issueMessage,
      launchReadinessState: readiness.state,
      appServerState,
      appServerStatusMessage,
      managedAccount,
      apiKey,
      requiresOpenaiAuth,
      localAccountArtifactsPresent,
      localActiveChatgptAccountPresent,
      login,
      rateLimits,
      updatedAt: new Date(now).toISOString(),
    });

    return snapshot;
  }

  private setSnapshot(nextSnapshot: CodexAccountSnapshotDto): CodexAccountSnapshotDto {
    this.snapshotCache = deepClone(nextSnapshot);
    this.snapshotObservedAt = Date.now();
    const snapshot = deepClone(nextSnapshot);
    this.presenter.publish(snapshot);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async emitCurrentSnapshot(): Promise<CodexAccountSnapshotDto> {
    if (!this.snapshotCache) {
      return this.refreshSnapshot();
    }

    return this.setSnapshot({
      ...this.snapshotCache,
      login: this.loginSessionManager.getState(),
      updatedAt: new Date().toISOString(),
    });
  }

  private async publishLoggedOutSnapshot(): Promise<CodexAccountSnapshotDto> {
    const preferredAuthMode = getPreferredAuthMode(this.configManager);
    const apiKey = this.snapshotCache?.apiKey ?? (await this.loadApiKeyAvailability());
    const localAccountState = await detectCodexLocalAccountState();
    const localAccountArtifactsPresent = localAccountState.hasArtifacts;
    const localActiveChatgptAccountPresent = localAccountState.hasActiveChatgptAccount;
    const readiness = evaluateCodexLaunchReadiness({
      preferredAuthMode,
      managedAccount: null,
      apiKey,
      appServerState: 'healthy',
      appServerStatusMessage: null,
      localActiveChatgptAccountPresent,
    });
    const login = this.asIdleLoginState(this.loginSessionManager.getState());

    return this.setSnapshot({
      preferredAuthMode,
      effectiveAuthMode: readiness.effectiveAuthMode,
      launchAllowed: readiness.launchAllowed,
      launchIssueMessage: readiness.issueMessage,
      launchReadinessState: readiness.state,
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey,
      requiresOpenaiAuth: false,
      localAccountArtifactsPresent,
      localActiveChatgptAccountPresent,
      login,
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    });
  }

  private asIdleLoginState(loginState: CodexLoginStateDto): CodexLoginStateDto {
    return {
      status: 'idle',
      error: loginState.status === 'failed' ? loginState.error : null,
      startedAt: null,
    };
  }

  private async runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previousMutation = this.mutationQueue.catch(() => undefined);
    const deferred = createDeferred();
    this.mutationQueue = deferred.promise;
    this.mutationQueueRelease = deferred.resolve;

    await previousMutation;
    await this.refreshPromise?.catch(() => undefined);

    this.activeMutationCount += 1;
    try {
      return await operation();
    } finally {
      this.activeMutationCount = Math.max(0, this.activeMutationCount - 1);
      deferred.resolve();
      if (this.mutationQueueRelease === deferred.resolve) {
        this.mutationQueueRelease = null;
      }
    }
  }

  private async loadApiKeyAvailability(): Promise<CodexApiKeyAvailabilityDto> {
    const storedKey = await this.apiKeyService.lookupPreferred('OPENAI_API_KEY');
    if (storedKey?.value.trim()) {
      return {
        available: true,
        source: 'stored',
        sourceLabel: 'Stored in app',
      };
    }

    const shellEnv = getCachedShellEnv() ?? {};
    const envSources = [shellEnv, process.env];
    for (const envSource of envSources) {
      const codexKey = envSource.CODEX_API_KEY;
      if (typeof codexKey === 'string' && codexKey.trim()) {
        return {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from CODEX_API_KEY',
        };
      }

      const openAiKey = envSource.OPENAI_API_KEY;
      if (typeof openAiKey === 'string' && openAiKey.trim()) {
        return {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        };
      }
    }

    return {
      available: false,
      source: null,
      sourceLabel: null,
    };
  }
}

export function createCodexAccountFeature(deps: {
  logger: LoggerPort;
  configManager: {
    getConfig: () => {
      providerConnections: {
        codex: {
          preferredAuthMode?: CodexAccountAuthMode;
        };
      };
    };
  };
}): CodexAccountFeatureFacade {
  return new CodexAccountFeatureFacadeImpl(deps.logger, deps.configManager);
}
