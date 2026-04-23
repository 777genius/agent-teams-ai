import type { TeamProviderId } from '@shared/types';

import type { ProviderPrepareDiagnosticsModelResult } from './providerPrepareDiagnostics';

const OPENCODE_DEEP_VERIFY_SUCCESS_CACHE_TTL_MS = 45_000;

type ShortLivedProviderPrepareCacheEntry = {
  expiresAt: number;
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>;
};

const shortLivedProviderPrepareCache = new Map<string, ShortLivedProviderPrepareCacheEntry>();

function pruneExpiredEntries(now: number): void {
  for (const [cacheKey, entry] of shortLivedProviderPrepareCache.entries()) {
    if (entry.expiresAt <= now) {
      shortLivedProviderPrepareCache.delete(cacheKey);
    }
  }
}

export function getShortLivedProviderPrepareModelResults({
  providerId,
  cacheKey,
}: {
  providerId: TeamProviderId;
  cacheKey: string;
}): Record<string, ProviderPrepareDiagnosticsModelResult> {
  if (providerId !== 'opencode') {
    return {};
  }

  const now = Date.now();
  pruneExpiredEntries(now);
  const entry = shortLivedProviderPrepareCache.get(cacheKey);
  if (!entry) {
    return {};
  }

  return { ...entry.modelResultsById };
}

export function storeShortLivedProviderPrepareModelResults({
  providerId,
  cacheKey,
  modelResultsById,
}: {
  providerId: TeamProviderId;
  cacheKey: string;
  modelResultsById: Record<string, ProviderPrepareDiagnosticsModelResult>;
}): void {
  if (providerId !== 'opencode') {
    return;
  }

  const readyResultsById = Object.fromEntries(
    Object.entries(modelResultsById).filter(([, result]) => result.status === 'ready')
  );
  if (Object.keys(readyResultsById).length === 0) {
    return;
  }

  const now = Date.now();
  pruneExpiredEntries(now);
  const existingEntry = shortLivedProviderPrepareCache.get(cacheKey);
  shortLivedProviderPrepareCache.set(cacheKey, {
    expiresAt: now + OPENCODE_DEEP_VERIFY_SUCCESS_CACHE_TTL_MS,
    modelResultsById: {
      ...(existingEntry?.modelResultsById ?? {}),
      ...readyResultsById,
    },
  });
}

export function __resetShortLivedProviderPrepareCacheForTests(): void {
  shortLivedProviderPrepareCache.clear();
}
