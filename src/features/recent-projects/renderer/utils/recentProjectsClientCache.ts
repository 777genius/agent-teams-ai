import { normalizeDashboardRecentProjectsPayload } from '@features/recent-projects/contracts';

import type {
  DashboardRecentProjectsPayload,
  DashboardRecentProjectsPayloadLike,
} from '@features/recent-projects/contracts';

const RECENT_PROJECTS_CLIENT_CACHE_TTL_MS = 15_000;
const RECENT_PROJECTS_CLIENT_DEGRADED_CACHE_TTL_MS = 1_500;

let cachedPayload: DashboardRecentProjectsPayloadLike = null;
let cachedAt = 0;
let inFlightLoad: Promise<DashboardRecentProjectsPayload> | null = null;

export interface RecentProjectsClientSnapshot {
  payload: DashboardRecentProjectsPayload;
  fetchedAt: number;
  isStale: boolean;
}

export function getRecentProjectsClientSnapshot(): RecentProjectsClientSnapshot | null {
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
  loader: () => Promise<DashboardRecentProjectsPayloadLike>,
  options?: { force?: boolean }
): Promise<DashboardRecentProjectsPayload> {
  const force = options?.force ?? false;
  const snapshot = getRecentProjectsClientSnapshot();

  if (!force && snapshot && !snapshot.isStale) {
    return snapshot.payload;
  }

  if (inFlightLoad) {
    return inFlightLoad;
  }

  const request = loader()
    .then((payloadLike) => {
      const normalizedPayload = normalizeDashboardRecentProjectsPayload(payloadLike);
      cachedPayload = normalizedPayload;
      cachedAt = Date.now();
      return normalizedPayload ?? { projects: [], degraded: true };
    })
    .finally(() => {
      if (inFlightLoad === request) {
        inFlightLoad = null;
      }
    });

  inFlightLoad = request;
  return request;
}

export function __resetRecentProjectsClientCacheForTests(): void {
  cachedPayload = null;
  cachedAt = 0;
  inFlightLoad = null;
}
