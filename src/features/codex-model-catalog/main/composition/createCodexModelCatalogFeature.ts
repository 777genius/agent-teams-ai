import { createHash, randomBytes } from 'node:crypto';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CodexAccountFeatureFacade } from '@features/codex-account/main';
import { CodexAccountEnvBuilder } from '@features/codex-account/main/infrastructure/CodexAccountEnvBuilder';
import { createStaticCodexModelCatalogModels } from '@features/codex-model-catalog/core/domain/codexModelCatalogFallback';
import { normalizeCodexAppServerModels } from '@features/codex-model-catalog/core/domain/normalizeCodexAppServerModel';
import {
  CodexAppServerSessionFactory,
  CodexBinaryResolver,
  JsonRpcRequestError,
  JsonRpcStdioClient,
} from '@main/services/infrastructure/codexAppServer';

import { CodexModelCatalogAppServerClient } from '../infrastructure/CodexModelCatalogAppServerClient';
import { InMemoryCodexModelCatalogCache } from '../infrastructure/InMemoryCodexModelCatalogCache';

import type { CodexModelCatalogDto } from '@features/codex-model-catalog/contracts';
import type { Logger } from '@shared/utils/logger';

type LoggerPort = Pick<Logger, 'warn'>;

const CATALOG_CACHE_TTL_MS = 10 * 60_000;
const CATALOG_STALE_TTL_MS = 24 * 60 * 60_000;
const HASH_SALT = randomBytes(16).toString('hex');

export interface CodexModelCatalogRequest {
  cwd?: string | null;
  profile?: string | null;
  includeHidden?: boolean;
  forceRefresh?: boolean;
}

export interface CodexModelCatalogFeatureFacade {
  getCatalog(options?: CodexModelCatalogRequest): Promise<CodexModelCatalogDto>;
  invalidate(): void;
  dispose(): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function staleAtIso(): string {
  return new Date(Date.now() + CATALOG_CACHE_TTL_MS).toISOString();
}

function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(HASH_SALT)
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16);
}

function classifyAppServerFailure(error: unknown): {
  appServerState: CodexModelCatalogDto['diagnostics']['appServerState'];
  message: string;
  code: string | null;
} {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const rpcCode =
    error instanceof JsonRpcRequestError && error.code !== null ? String(error.code) : null;

  if (
    lower.includes('unknown method') ||
    lower.includes('method not found') ||
    lower.includes('unknown command') ||
    lower.includes('no such command') ||
    rpcCode === '-32601'
  ) {
    return {
      appServerState: 'incompatible',
      message: 'The installed Codex binary does not support app-server model/list yet.',
      code: rpcCode ?? 'method-not-found',
    };
  }

  return {
    appServerState: 'degraded',
    message,
    code: rpcCode,
  };
}

function createCacheKey(options: {
  binaryPath: string | null;
  binaryVersion: string | null;
  accountSnapshot: CodexAccountSnapshotDto;
  cwd?: string | null;
  profile?: string | null;
  configFingerprint?: string | null;
  includeHidden?: boolean;
}): string {
  return hashValue({
    binaryPath: options.binaryPath,
    binaryVersion: options.binaryVersion,
    preferredAuthMode: options.accountSnapshot.preferredAuthMode,
    effectiveAuthMode: options.accountSnapshot.effectiveAuthMode,
    managedAccount: options.accountSnapshot.managedAccount
      ? {
          type: options.accountSnapshot.managedAccount.type,
          planType: options.accountSnapshot.managedAccount.planType,
          emailHash: hashValue(options.accountSnapshot.managedAccount.email),
        }
      : null,
    apiKeySource: options.accountSnapshot.apiKey.source,
    cwd: options.cwd?.trim() || null,
    profile: options.profile?.trim() || null,
    configFingerprint: options.configFingerprint ?? null,
    includeHidden: options.includeHidden === true,
    codexHome: process.env.CODEX_HOME?.trim() || null,
  });
}

function setCatalogCacheEntries(
  cache: InMemoryCodexModelCatalogCache,
  keys: readonly string[],
  catalog: CodexModelCatalogDto
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    cache.set(key, catalog);
  }
}

function createFallbackCatalog(options: {
  sourceMessage: string;
  appServerState: CodexModelCatalogDto['diagnostics']['appServerState'];
  status?: CodexModelCatalogDto['status'];
  code?: string | null;
}): CodexModelCatalogDto {
  const models = createStaticCodexModelCatalogModels();
  const defaultModel = models.find((model) => model.isDefault) ?? models[0] ?? null;
  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'static-fallback',
    status: options.status ?? 'degraded',
    fetchedAt: nowIso(),
    staleAt: staleAtIso(),
    defaultModelId: defaultModel?.id ?? null,
    defaultLaunchModel: defaultModel?.launchModel ?? null,
    models,
    diagnostics: {
      configReadState: 'skipped',
      appServerState: options.appServerState,
      message: options.sourceMessage,
      code: options.code ?? null,
    },
  };
}

function markCatalogStale(
  catalog: CodexModelCatalogDto,
  diagnostics: CodexModelCatalogDto['diagnostics']
): CodexModelCatalogDto {
  return {
    ...catalog,
    status: 'stale',
    diagnostics,
  };
}

export function createCodexModelCatalogFeature(options: {
  logger: LoggerPort;
  codexAccountFeature: Pick<CodexAccountFeatureFacade, 'getSnapshot'>;
}): CodexModelCatalogFeatureFacade {
  const envBuilder = new CodexAccountEnvBuilder();
  const cache = new InMemoryCodexModelCatalogCache();
  const inFlightRefreshes = new Map<string, Promise<CodexModelCatalogDto>>();
  let cacheGeneration = 0;
  const client = new CodexModelCatalogAppServerClient(
    new CodexAppServerSessionFactory(new JsonRpcStdioClient(options.logger))
  );

  async function getCatalog(request: CodexModelCatalogRequest = {}): Promise<CodexModelCatalogDto> {
    const accountSnapshot = await options.codexAccountFeature.getSnapshot();
    const binaryPath = await CodexBinaryResolver.resolve();
    const binaryVersion = await CodexBinaryResolver.resolveVersion(binaryPath);

    if (!binaryPath) {
      return createFallbackCatalog({
        sourceMessage: 'Codex CLI was not found. Showing static fallback model list.',
        appServerState: 'runtime-missing',
        status: 'unavailable',
      });
    }

    const env = envBuilder.buildControlPlaneEnv({ binaryPath });
    const preflightCacheKey = createCacheKey({
      binaryPath,
      binaryVersion,
      accountSnapshot,
      cwd: request.cwd,
      profile: request.profile,
      configFingerprint: null,
      includeHidden: request.includeHidden,
    });

    if (request.forceRefresh !== true) {
      const cached = cache.get(preflightCacheKey, CATALOG_CACHE_TTL_MS);
      if (cached) {
        return cached;
      }
    }

    const existingRefresh = inFlightRefreshes.get(preflightCacheKey);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshGeneration = cacheGeneration;
    const refreshPromise = (async (): Promise<CodexModelCatalogDto> => {
      let configFingerprint: string | null = null;
      let configReadState: CodexModelCatalogDto['diagnostics']['configReadState'] = 'skipped';
      let configReadMessage: string | null = null;
      let cacheKey = preflightCacheKey;

      try {
        const payload = await client.readModelCatalogWithConfig({
          binaryPath,
          env,
          includeHidden: request.includeHidden,
          cwd: request.cwd,
          profile: request.profile,
        });

        if (payload.config.ok) {
          configReadState = 'ready';
          configFingerprint = hashValue(payload.config.value);
        } else {
          configReadState =
            payload.config.error instanceof JsonRpcRequestError &&
            payload.config.error.code === -32601
              ? 'unsupported'
              : 'failed';
          configReadMessage =
            payload.config.error instanceof Error
              ? payload.config.error.message
              : String(payload.config.error);
        }

        cacheKey = createCacheKey({
          binaryPath,
          binaryVersion,
          accountSnapshot,
          cwd: request.cwd,
          profile: request.profile,
          configFingerprint,
          includeHidden: request.includeHidden,
        });

        const normalized = normalizeCodexAppServerModels(
          payload.modelCatalog.models ?? payload.modelCatalog.data,
          {
            includeHidden: request.includeHidden,
          }
        );

        const defaultModel =
          normalized.models.find((model) => model.id === normalized.defaultModelId) ??
          normalized.models.find((model) => model.isDefault) ??
          normalized.models[0] ??
          null;
        const diagnostics = [
          ...normalized.diagnostics,
          configReadMessage ? `config/read: ${configReadMessage}` : null,
          payload.modelCatalog.truncated
            ? 'model/list pagination reached the safety page limit; some Codex models may be omitted.'
            : null,
        ].filter(Boolean);
        const catalog: CodexModelCatalogDto = {
          schemaVersion: 1,
          providerId: 'codex',
          source: 'app-server',
          status: 'ready',
          fetchedAt: nowIso(),
          staleAt: staleAtIso(),
          defaultModelId: defaultModel?.id ?? null,
          defaultLaunchModel: defaultModel?.launchModel ?? null,
          models: normalized.models,
          diagnostics: {
            configReadState,
            appServerState: 'healthy',
            message: diagnostics.length > 0 ? diagnostics.join(' ') : null,
            code: null,
          },
        };

        if (normalized.models.length === 0) {
          throw new Error('Codex app-server model/list returned no visible models.');
        }

        if (refreshGeneration === cacheGeneration) {
          setCatalogCacheEntries(cache, [preflightCacheKey, cacheKey], catalog);
        }
        return catalog;
      } catch (error) {
        const failure = classifyAppServerFailure(error);
        const stale =
          cache.getLatest(cacheKey) ??
          (cacheKey === preflightCacheKey ? null : cache.getLatest(preflightCacheKey));
        if (stale && Date.parse(stale.fetchedAt) + CATALOG_STALE_TTL_MS > Date.now()) {
          return markCatalogStale(stale, {
            configReadState,
            appServerState: failure.appServerState,
            message: failure.message,
            code: failure.code,
          });
        }

        options.logger.warn('codex model catalog refresh failed', {
          error: failure.message,
          code: failure.code,
        });
        const fallback = createFallbackCatalog({
          sourceMessage: failure.message,
          appServerState: failure.appServerState,
          code: failure.code,
        });
        if (refreshGeneration === cacheGeneration) {
          setCatalogCacheEntries(cache, [preflightCacheKey, cacheKey], fallback);
        }
        return fallback;
      }
    })();

    inFlightRefreshes.set(preflightCacheKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (inFlightRefreshes.get(preflightCacheKey) === refreshPromise) {
        inFlightRefreshes.delete(preflightCacheKey);
      }
    }
  }

  return {
    getCatalog,
    invalidate: () => {
      cacheGeneration += 1;
      cache.clear();
      inFlightRefreshes.clear();
    },
    dispose: async () => {
      cacheGeneration += 1;
      cache.clear();
      inFlightRefreshes.clear();
    },
  };
}
