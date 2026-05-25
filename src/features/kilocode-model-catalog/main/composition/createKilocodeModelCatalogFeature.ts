import { createHash } from 'node:crypto';

import { createStaticKilocodeModelCatalogModels } from '../../core/domain/kilocodeModelCatalogFallback';
import { InMemoryKilocodeModelCatalogCache } from '../infrastructure/InMemoryKilocodeModelCatalogCache';
import { KilocodeGatewayClient } from '../infrastructure/KilocodeGatewayClient';

import type { KilocodeModelCatalogDto, KilocodeModelCatalogItemDto } from '../../contracts';
import type { Logger } from '@shared/utils/logger';

type LoggerPort = Pick<Logger, 'warn'>;

const CATALOG_CACHE_TTL_MS = 10 * 60_000;
const CATALOG_STALE_TTL_MS = 24 * 60 * 60_000;

export interface KilocodeModelCatalogRequest {
  apiKey?: string | null;
  forceRefresh?: boolean;
}

export interface KilocodeModelCatalogFeatureFacade {
  getCatalog(options?: KilocodeModelCatalogRequest): Promise<KilocodeModelCatalogDto>;
  invalidate(): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function staleAtIso(): string {
  return new Date(Date.now() + CATALOG_CACHE_TTL_MS).toISOString();
}

function buildCacheKey(apiKey: string): string {
  return `kilocode:${createHash('sha256').update(apiKey).digest('hex')}`;
}

function normalizeGatewayModels(
  models: { id: string; displayName: string }[]
): KilocodeModelCatalogItemDto[] {
  return models.map((model, index) => ({
    id: model.id,
    launchModel: model.id,
    displayName: model.displayName,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: index === 0,
    upgrade: false,
    source: 'app-server' as const,
  }));
}

function createFallbackCatalog(options: {
  message: string;
  status?: KilocodeModelCatalogDto['status'];
  appServerState: KilocodeModelCatalogDto['diagnostics']['appServerState'];
}): KilocodeModelCatalogDto {
  const models = createStaticKilocodeModelCatalogModels();
  const defaultModel = models.find((m) => m.isDefault) ?? models[0] ?? null;
  return {
    schemaVersion: 1,
    providerId: 'kilocode',
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
      message: options.message,
      code: null,
    },
  };
}

export function createKilocodeModelCatalogFeature(options: {
  logger: LoggerPort;
}): KilocodeModelCatalogFeatureFacade {
  const cache = new InMemoryKilocodeModelCatalogCache();
  const inFlightRefreshes = new Map<string, Promise<KilocodeModelCatalogDto>>();
  const client = new KilocodeGatewayClient();

  async function getCatalog(
    request: KilocodeModelCatalogRequest = {}
  ): Promise<KilocodeModelCatalogDto> {
    const apiKey = request.apiKey?.trim() || process.env.KILO_API_KEY?.trim() || null;

    if (!apiKey) {
      return createFallbackCatalog({
        message: 'No KiloCode API key configured. Set KILO_API_KEY or configure an API key.',
        appServerState: 'runtime-missing',
        status: 'unavailable',
      });
    }

    const cacheKey = buildCacheKey(apiKey);

    if (request.forceRefresh !== true) {
      const cached = cache.get(cacheKey, CATALOG_CACHE_TTL_MS);
      if (cached) {
        return cached;
      }
    }

    const existing = inFlightRefreshes.get(cacheKey);
    if (existing) {
      return existing;
    }

    const refreshPromise = (async (): Promise<KilocodeModelCatalogDto> => {
      try {
        const gatewayModels = await client.listModels(apiKey);
        const models = normalizeGatewayModels(gatewayModels);

        if (models.length === 0) {
          throw new Error('KiloCode gateway returned no models.');
        }

        const defaultModel = models[0] ?? null;
        const catalog: KilocodeModelCatalogDto = {
          schemaVersion: 1,
          providerId: 'kilocode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: nowIso(),
          staleAt: staleAtIso(),
          defaultModelId: defaultModel?.id ?? null,
          defaultLaunchModel: defaultModel?.launchModel ?? null,
          models,
          diagnostics: {
            configReadState: 'skipped',
            appServerState: 'healthy',
            message: null,
            code: null,
          },
        };

        cache.set(cacheKey, catalog);
        return catalog;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stale = cache.getLatest(cacheKey);
        if (stale && Date.parse(stale.fetchedAt) + CATALOG_STALE_TTL_MS > Date.now()) {
          return {
            ...stale,
            status: 'stale',
            diagnostics: {
              configReadState: 'skipped',
              appServerState: 'degraded',
              message,
              code: null,
            },
          };
        }

        options.logger.warn('KiloCode model catalog refresh failed', { error: message });
        return createFallbackCatalog({
          message,
          appServerState: 'degraded',
        });
      }
    })();

    inFlightRefreshes.set(cacheKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (inFlightRefreshes.get(cacheKey) === refreshPromise) {
        inFlightRefreshes.delete(cacheKey);
      }
    }
  }

  return {
    getCatalog,
    invalidate: () => {
      cache.clear();
      inFlightRefreshes.clear();
    },
  };
}
