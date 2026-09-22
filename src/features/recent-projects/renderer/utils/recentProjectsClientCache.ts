import { normalizeDashboardRecentProjectsPayload } from '@features/recent-projects/contracts';

import type {
  DashboardRecentProjectsPayload,
  DashboardRecentProjectsPayloadLike,
} from '@features/recent-projects/contracts';

const RECENT_PROJECTS_CLIENT_CACHE_TTL_MS = 15_000;
const RECENT_PROJECTS_CLIENT_DEGRADED_CACHE_TTL_MS = 30_000;

let cachedPayload: DashboardRecentProjectsPayloadLike = null;
let cachedKey: string | null = null;
let cachedAt = 0;
let inFlightLoad: { key: string; promise: Promise<DashboardRecentProjectsPayload> } | null = null;

export interface RecentProjectsClientSnapshot {
  payload: DashboardRecentProjectsPayload;
  fetchedAt: number;
  isStale: boolean;
}

export function getRecentProjectsClientSnapshot(
  cacheKey: string
): RecentProjectsClientSnapshot | null {
  if (cachedKey !== cacheKey) {
    return null;
  }

  const normalizedPayload = normalizeDashboardRecentProjectsPayload(cachedPayload);
  if (!normalizedPayload) {
    return null;
  }

  if (cachedPayload !== normalizedPayload) {
    cachedPayload = normalizedPayload;
  }

  const ttlMs = normalizedPayload.degraded
    ? RECENT_PROJECTS_CLIENT_DEGRADED_CACHE_TTL_MS
    : RECENT_PROJECTS_CLIENT_CACHE_TTL_MS;

  return {
    payload: normalizedPayload,
    fetchedAt: cachedAt,
    isStale: Date.now() - cachedAt > ttlMs,
  };
}

export async function loadRecentProjectsWithClientCache(
  cacheKey: string,
  loader: () => Promise<DashboardRecentProjectsPayloadLike>,
  options?: { force?: boolean }
): Promise<DashboardRecentProjectsPayload> {
  const force = options?.force ?? false;
  const snapshot = getRecentProjectsClientSnapshot(cacheKey);

  if (!force && snapshot && !snapshot.isStale) {
    return snapshot.payload;
  }

  if (inFlightLoad?.key === cacheKey) {
    return inFlightLoad.promise;
  }

  const request = loader()
    .then((payloadLike) => {
      const normalizedPayload = normalizeDashboardRecentProjectsPayload(payloadLike);
      if (inFlightLoad?.key === cacheKey && inFlightLoad.promise === request) {
        cachedKey = normalizedPayload ? cacheKey : null;
        cachedPayload = normalizedPayload;
        cachedAt = Date.now();
      }
      return normalizedPayload ?? { projects: [], degraded: true };
    })
    .finally(() => {
      if (inFlightLoad?.promise === request) {
        inFlightLoad = null;
      }
    });

  inFlightLoad = { key: cacheKey, promise: request };
  return request;
}

export function __resetRecentProjectsClientCacheForTests(): void {
  cachedPayload = null;
  cachedKey = null;
  cachedAt = 0;
  inFlightLoad = null;
}
