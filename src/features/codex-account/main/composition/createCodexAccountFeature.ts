import {
  type CodexAccountAuthMode,
  type CodexAccountSnapshotDto,
  type CodexApiKeyAvailabilityDto,
  type CodexChatgptLoginMode,
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
import { getCachedShellEnv, resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

import { CodexAccountSnapshotPresenter } from '../adapters/output/presenters/CodexAccountSnapshotPresenter';
import { CodexAccountAppServerClient } from '../infrastructure/CodexAccountAppServerClient';
import { CodexAccountEnvBuilder } from '../infrastructure/CodexAccountEnvBuilder';
import { CodexLoginSessionManager } from '../infrastructure/CodexLoginSessionManager';
import {
  detectCodexLocalAccountState,
  ensureCodexLegacyAuthFromActiveAccount,
} from '../infrastructure/detectCodexLocalAccountArtifacts';

import type { Logger } from '@shared/utils/logger';
import type { BrowserWindow } from 'electron';

type LoggerPort = Pick<Logger, 'info' | 'warn' | 'error'>;

const SNAPSHOT_CACHE_TTL_MS = 5_000;
const RATE_LIMITS_CACHE_TTL_MS = 45_000;
const LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS = 60_000;
const CODEX_BINARY_COLD_RETRY_TIMEOUT_MS = 12_000;
const CODEX_CLI_NOT_FOUND_MESSAGE =
  'Codex CLI not found. Install Codex to use native account management.';
const CODEX_ACCOUNT_FEATURE_DISPOSED_MESSAGE = 'Codex account feature has been disposed.';

interface CodexLastKnownAccount {
  payload: CodexAppServerGetAccountResponse;
  observedAt: number;
}

interface CodexLastKnownRateLimits {
  payload: CodexAppServerGetAccountRateLimitsResponse;
  observedAt: number;
  accountSignature: string | null;
}

interface CodexRuntimeContext {
  binaryPath: string | null;
  codexHome: string | null;
}

interface CodexLastKnownRuntimeContext {
  payload: CodexRuntimeContext;
  observedAt: number;
}

interface CodexSnapshotRefreshOptions {
  includeRateLimits: boolean;
  forceRefreshToken: boolean;
}

interface CodexSnapshotRefreshBatch {
  acceptingRequests: boolean;
  initialOptions: CodexSnapshotRefreshOptions | null;
  activeOptions: CodexSnapshotRefreshOptions | null;
  pendingOptions: CodexSnapshotRefreshOptions | null;
  promise: Promise<CodexAccountSnapshotDto>;
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

function getCodexAccountSignature(
  account: CodexAppServerGetAccountResponse['account']
): string | null {
  if (!account) {
    return null;
  }

  if (account.type === 'apiKey') {
    return 'api_key';
  }

  return `chatgpt:${account.email ?? 'unknown'}:${account.planType ?? 'unknown'}`;
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

function hasVisibleRateLimitData(snapshot: CodexRateLimitSnapshotDto | null): boolean {
  return Boolean(snapshot?.primary || snapshot?.secondary || snapshot?.credits);
}

function createRuntimeContext(
  binaryPath: string | null | undefined,
  codexHome: string | null | undefined
): CodexRuntimeContext {
  return {
    binaryPath: binaryPath?.trim() || null,
    codexHome: codexHome?.trim() || null,
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

function doRefreshOptionsCover(
  current: CodexSnapshotRefreshOptions | null,
  requested: CodexSnapshotRefreshOptions
): boolean {
  return Boolean(
    current &&
    (!requested.includeRateLimits || current.includeRateLimits) &&
    (!requested.forceRefreshToken || current.forceRefreshToken)
  );
}

async function resolveCodexBinaryForAccountSnapshot(): Promise<string | null> {
  const binaryPath = await CodexBinaryResolver.resolve();
  if (binaryPath) {
    return binaryPath;
  }

  await resolveInteractiveShellEnvBestEffort({
    timeoutMs: CODEX_BINARY_COLD_RETRY_TIMEOUT_MS,
    fallbackEnv: process.env,
    background: true,
    source: 'codex-account-binary-discovery',
  });
  CodexBinaryResolver.clearCache();
  return CodexBinaryResolver.resolve();
}

export interface CodexAccountFeatureFacade {
  getSnapshot(): Promise<CodexAccountSnapshotDto>;
  refreshSnapshot(options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<CodexAccountSnapshotDto>;
  startChatgptLogin(options?: { mode?: CodexChatgptLoginMode }): Promise<CodexAccountSnapshotDto>;
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
  private readonly unsubscribeLoginState: () => void;
  private readonly unsubscribeLoginSettled: () => void;

  private snapshotCache: CodexAccountSnapshotDto | null = null;
  private snapshotObservedAt = 0;
  private lastPublishedSnapshotUpdatedAtMs = 0;
  private refreshBatch: CodexSnapshotRefreshBatch | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private lastKnownAccount: CodexLastKnownAccount | null = null;
  private lastKnownRateLimits: CodexLastKnownRateLimits | null = null;
  private lastKnownRuntimeContext: CodexLastKnownRuntimeContext | null = null;
  private queuedMutationCount = 0;
  private activeMutationCount = 0;
  private disposed = false;

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

    this.unsubscribeLoginState = this.loginSessionManager.subscribe(() => {
      void this.emitCurrentSnapshot().catch((error) => {
        this.logBackgroundFailure('codex account login-state snapshot refresh failed', error);
      });
    });
    this.unsubscribeLoginSettled = this.loginSessionManager.onSettled(() => {
      void this.refreshSnapshot({ includeRateLimits: true, forceRefreshToken: true }).catch(
        (error) => {
          this.logBackgroundFailure('codex account settled snapshot refresh failed', error);
        }
      );
    });
  }

  async getSnapshot(): Promise<CodexAccountSnapshotDto> {
    return this.refreshSnapshot();
  }

  async refreshSnapshot(options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }): Promise<CodexAccountSnapshotDto> {
    this.ensureActive();
    const normalizedOptions = normalizeRefreshOptions(options);
    if (this.refreshBatch?.acceptingRequests) {
      if (
        doRefreshOptionsCover(this.refreshBatch.initialOptions, normalizedOptions) ||
        doRefreshOptionsCover(this.refreshBatch.activeOptions, normalizedOptions) ||
        doRefreshOptionsCover(this.refreshBatch.pendingOptions, normalizedOptions)
      ) {
        return this.refreshBatch.promise;
      }
      this.refreshBatch.pendingOptions = mergeRefreshOptions(
        this.refreshBatch.pendingOptions,
        normalizedOptions
      );
      return this.refreshBatch.promise;
    }

    const cached = this.getCachedSnapshotForOptions(normalizedOptions);
    if (cached) {
      return cached;
    }

    const previousOperation = this.operationQueue.catch(() => undefined);
    const batch = {
      acceptingRequests: true,
      initialOptions: normalizedOptions,
      activeOptions: null,
      pendingOptions: null,
      promise: Promise.resolve(null as unknown as CodexAccountSnapshotDto),
    } satisfies CodexSnapshotRefreshBatch;
    const batchPromise = previousOperation.then(() => this.drainRefreshBatch(batch));
    batch.promise = batchPromise;
    this.refreshBatch = batch;
    this.operationQueue = batchPromise.then(
      () => undefined,
      () => undefined
    );
    void batchPromise.then(
      () => {
        if (this.refreshBatch === batch) {
          this.refreshBatch = null;
        }
      },
      () => {
        if (this.refreshBatch === batch) {
          this.refreshBatch = null;
        }
      }
    );

    return batchPromise;
  }

  async startChatgptLogin(options?: {
    mode?: CodexChatgptLoginMode;
  }): Promise<CodexAccountSnapshotDto> {
    let binaryMissing = false;
    await this.runSerializedMutation(async () => {
      const binaryPath = await resolveCodexBinaryForAccountSnapshot();
      if (!binaryPath) {
        binaryMissing = true;
        return;
      }

      const env = this.envBuilder.buildControlPlaneEnv({ binaryPath });
      await this.loginSessionManager.start({ binaryPath, env, mode: options?.mode });
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

      const binaryPath = await resolveCodexBinaryForAccountSnapshot();
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
    this.ensureActive();
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
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unsubscribeLoginState();
    this.unsubscribeLoginSettled();
    await this.loginSessionManager.dispose();
    this.listeners.clear();
    this.snapshotCache = null;
    this.refreshBatch = null;
    this.operationQueue = Promise.resolve();
    this.lastKnownAccount = null;
    this.lastKnownRateLimits = null;
    this.lastKnownRuntimeContext = null;
    this.lastPublishedSnapshotUpdatedAtMs = 0;
    this.queuedMutationCount = 0;
    this.activeMutationCount = 0;
  }

  private async drainRefreshBatch(
    batch: CodexSnapshotRefreshBatch
  ): Promise<CodexAccountSnapshotDto> {
    let lastSnapshot: CodexAccountSnapshotDto | null = null;
    let nextOptions = batch.initialOptions;
    batch.initialOptions = null;

    while (nextOptions) {
      this.ensureActive();
      batch.activeOptions = nextOptions;
      lastSnapshot =
        this.getCachedSnapshotForOptions(nextOptions) ?? (await this.loadSnapshot(nextOptions));
      batch.activeOptions = null;
      nextOptions = batch.pendingOptions;
      batch.pendingOptions = null;
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
    this.ensureActive();
    const preferredAuthMode = getPreferredAuthMode(this.configManager);
    const apiKey = await this.loadApiKeyAvailability();
    const localAccountState = await detectCodexLocalAccountState();
    const localAccountArtifactsPresent = localAccountState.hasArtifacts;
    const localActiveChatgptAccountPresent = localAccountState.hasActiveChatgptAccount;
    const binaryPath = await resolveCodexBinaryForAccountSnapshot();
    const now = Date.now();

    if (!binaryPath) {
      const freshRuntimeContext = this.getFreshLastKnownRuntimeContext(now);
      if (freshRuntimeContext) {
        const freshAccountPayload = this.getFreshLastKnownAccount(now);
        const accountPayload = freshAccountPayload ?? null;
        const managedAccount = asCodexManagedAccount(accountPayload?.account ?? null);
        const readiness = evaluateCodexLaunchReadiness({
          preferredAuthMode,
          managedAccount,
          apiKey,
          appServerState: 'healthy',
          appServerStatusMessage: null,
          localActiveChatgptAccountPresent,
        });
        const snapshot = this.setSnapshot({
          preferredAuthMode,
          effectiveAuthMode: readiness.effectiveAuthMode,
          launchAllowed: readiness.launchAllowed,
          launchIssueMessage: readiness.issueMessage,
          launchReadinessState: readiness.state,
          appServerState: 'healthy',
          appServerStatusMessage: null,
          managedAccount,
          apiKey,
          requiresOpenaiAuth: accountPayload?.requiresOpenaiAuth ?? null,
          localAccountArtifactsPresent,
          localActiveChatgptAccountPresent,
          runtimeContext: freshRuntimeContext,
          login: this.loginSessionManager.getState(),
          rateLimits: this.snapshotCache?.rateLimits ?? null,
          updatedAt: new Date().toISOString(),
        });
        return snapshot;
      }

      const snapshot = this.setSnapshot({
        preferredAuthMode,
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: CODEX_CLI_NOT_FOUND_MESSAGE,
        launchReadinessState: 'runtime_missing',
        appServerState: 'runtime-missing',
        appServerStatusMessage: CODEX_CLI_NOT_FOUND_MESSAGE,
        managedAccount: null,
        apiKey,
        requiresOpenaiAuth: null,
        localAccountArtifactsPresent,
        localActiveChatgptAccountPresent,
        login: this.loginSessionManager.getState(),
        rateLimits: null,
        updatedAt: new Date().toISOString(),
      });
      return snapshot;
    }

    if (localActiveChatgptAccountPresent) {
      await ensureCodexLegacyAuthFromActiveAccount().catch((error) => {
        this.logger.warn('codex account legacy auth compatibility sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const env = this.envBuilder.buildControlPlaneEnv({ binaryPath });
    let appServerState: CodexAccountSnapshotDto['appServerState'] = 'healthy';
    let appServerStatusMessage: string | null = null;
    let accountPayload = this.lastKnownAccount?.payload ?? null;
    let requiresOpenaiAuth: boolean | null = accountPayload?.requiresOpenaiAuth ?? null;
    const previousRuntimeContext = this.getFreshLastKnownRuntimeContext(now);
    let runtimeContext = createRuntimeContext(
      binaryPath,
      previousRuntimeContext?.binaryPath === binaryPath ? previousRuntimeContext.codexHome : null
    );
    this.lastKnownRuntimeContext = {
      payload: runtimeContext,
      observedAt: now,
    };
    const cachedRateLimitsAreFresh =
      this.hasFreshRateLimits(now) &&
      this.lastKnownRateLimits?.accountSignature ===
        getCodexAccountSignature(accountPayload?.account ?? null);
    const shouldRequestRateLimits =
      options?.includeRateLimits === true &&
      (options.forceRefreshToken === true || !cachedRateLimitsAreFresh);
    let rateLimitsReadFailure: unknown | null = null;
    let rateLimitsReadReturnedEmpty = false;

    try {
      const accountResult = await this.appServerClient.readAccountSnapshot({
        binaryPath,
        env,
        refreshToken: options?.forceRefreshToken ?? false,
        includeRateLimits: shouldRequestRateLimits,
      });
      runtimeContext = createRuntimeContext(binaryPath, accountResult.initialize.codexHome);
      if (runtimeContext.codexHome) {
        this.lastKnownRuntimeContext = {
          payload: runtimeContext,
          observedAt: now,
        };
      }
      const canReuseLastKnownManagedAccount =
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
      if (accountResult.rateLimits?.ok) {
        const nextRateLimits = asRateLimits(accountResult.rateLimits.payload.rateLimits);
        if (hasVisibleRateLimitData(nextRateLimits)) {
          this.lastKnownRateLimits = {
            payload: accountResult.rateLimits.payload,
            observedAt: now,
            accountSignature:
              getCodexAccountSignature(accountResult.account.account) ??
              getCodexAccountSignature(accountPayload?.account ?? null),
          };
        } else {
          rateLimitsReadReturnedEmpty = true;
        }
      } else if (accountResult.rateLimits) {
        rateLimitsReadFailure = accountResult.rateLimits.error;
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

      if (
        this.lastKnownRuntimeContext &&
        now - this.lastKnownRuntimeContext.observedAt <= LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS &&
        this.lastKnownRuntimeContext.payload.binaryPath === binaryPath
      ) {
        runtimeContext = this.lastKnownRuntimeContext.payload;
      }
    }

    let rateLimits: CodexRateLimitSnapshotDto | null = null;
    const shouldLoadRateLimits =
      options?.includeRateLimits === true || this.hasFreshRateLimits(now);
    const currentAccountSignature = getCodexAccountSignature(accountPayload?.account ?? null);
    const reusableLastKnownRateLimits =
      this.lastKnownRateLimits?.accountSignature === currentAccountSignature
        ? this.lastKnownRateLimits
        : null;

    if (shouldLoadRateLimits) {
      if (this.hasFreshRateLimits(now) && reusableLastKnownRateLimits) {
        rateLimits = asRateLimits(reusableLastKnownRateLimits.payload.rateLimits);
      } else if (rateLimitsReadFailure || rateLimitsReadReturnedEmpty) {
        if (rateLimitsReadFailure) {
          this.logger.warn('codex account rate limits refresh failed', {
            error:
              rateLimitsReadFailure instanceof Error
                ? rateLimitsReadFailure.message
                : String(rateLimitsReadFailure),
          });
        }
        if (reusableLastKnownRateLimits) {
          rateLimits = asRateLimits(reusableLastKnownRateLimits.payload.rateLimits);
        }
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
      runtimeContext,
      login: this.loginSessionManager.getState(),
      rateLimits,
      updatedAt: new Date().toISOString(),
    });

    return snapshot;
  }

  private setSnapshot(nextSnapshot: CodexAccountSnapshotDto): CodexAccountSnapshotDto {
    const publishedAtMs = Math.max(Date.now(), this.lastPublishedSnapshotUpdatedAtMs + 1);
    this.lastPublishedSnapshotUpdatedAtMs = publishedAtMs;
    const publishedSnapshot = {
      ...nextSnapshot,
      updatedAt: new Date(publishedAtMs).toISOString(),
    };

    if (this.disposed) {
      return deepClone(publishedSnapshot);
    }

    this.snapshotCache = deepClone(publishedSnapshot);
    this.snapshotObservedAt = Date.now();
    const snapshot = deepClone(publishedSnapshot);
    this.presenter.publish(snapshot);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private getCachedSnapshotForOptions(
    options: CodexSnapshotRefreshOptions
  ): CodexAccountSnapshotDto | null {
    if (
      this.hasPendingMutation() ||
      options.forceRefreshToken ||
      !this.snapshotCache ||
      Date.now() - this.snapshotObservedAt > SNAPSHOT_CACHE_TTL_MS
    ) {
      return null;
    }

    if (options.includeRateLimits) {
      const cachedAccountSignature = this.getSnapshotAccountSignature(this.snapshotCache);
      if (
        !this.hasFreshRateLimits(Date.now()) ||
        this.lastKnownRateLimits?.accountSignature !== cachedAccountSignature ||
        this.snapshotCache.rateLimits === null
      ) {
        return null;
      }
    }

    return deepClone(this.snapshotCache);
  }

  private hasPendingMutation(): boolean {
    return this.queuedMutationCount > 0;
  }

  private getSnapshotAccountSignature(snapshot: CodexAccountSnapshotDto): string | null {
    if (!snapshot.managedAccount) {
      return null;
    }

    if (snapshot.managedAccount.type === 'api_key') {
      return 'api_key';
    }

    return `chatgpt:${snapshot.managedAccount.email ?? 'unknown'}:${snapshot.managedAccount.planType ?? 'unknown'}`;
  }

  private hasFreshRateLimits(now: number): boolean {
    return (
      this.lastKnownRateLimits !== null &&
      now - this.lastKnownRateLimits.observedAt <= RATE_LIMITS_CACHE_TTL_MS
    );
  }

  private getFreshLastKnownRuntimeContext(now: number): CodexRuntimeContext | null {
    if (
      !this.lastKnownRuntimeContext ||
      now - this.lastKnownRuntimeContext.observedAt > LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS ||
      !this.lastKnownRuntimeContext.payload.binaryPath
    ) {
      return null;
    }

    return this.lastKnownRuntimeContext.payload;
  }

  private getFreshLastKnownAccount(now: number): CodexAppServerGetAccountResponse | null {
    if (
      !this.lastKnownAccount ||
      now - this.lastKnownAccount.observedAt > LAST_KNOWN_GOOD_MANAGED_ACCOUNT_TTL_MS
    ) {
      return null;
    }

    return this.lastKnownAccount.payload;
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
      authUrl: null,
      userCode: null,
    };
  }

  private runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureActive();
    if (this.refreshBatch) {
      this.refreshBatch.acceptingRequests = false;
    }

    const previousOperation = this.operationQueue.catch(() => undefined);
    this.queuedMutationCount += 1;
    const mutationPromise = previousOperation.then(async () => {
      this.ensureActive();
      this.activeMutationCount += 1;
      try {
        return await operation();
      } finally {
        this.activeMutationCount = Math.max(0, this.activeMutationCount - 1);
        this.queuedMutationCount = Math.max(0, this.queuedMutationCount - 1);
      }
    });
    this.operationQueue = mutationPromise.then(
      () => undefined,
      () => undefined
    );
    return mutationPromise;
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new Error(CODEX_ACCOUNT_FEATURE_DISPOSED_MESSAGE);
    }
  }

  private logBackgroundFailure(message: string, error: unknown): void {
    if (this.disposed) {
      return;
    }

    this.logger.warn(message, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async loadApiKeyAvailability(): Promise<CodexApiKeyAvailabilityDto> {
    if (await this.apiKeyService.hasPreferred('OPENAI_API_KEY')) {
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
