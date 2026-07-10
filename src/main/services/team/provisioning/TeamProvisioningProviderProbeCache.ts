import type { ProvisioningAuthSource } from './TeamProvisioningEnvBuilder';

const PROBE_CACHE_TTL_MS = 36 * 60 * 60 * 1000;

export interface CachedProbeResult {
  cacheKey: string;
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
  cachedAtMs: number;
}

export interface ProbeResult {
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
}

export interface ProviderProbeCachePort {
  get(cacheKey: string): CachedProbeResult | null;
  set(cacheKey: string, result: ProbeResult): void;
  delete(cacheKey: string): void;
  getOrCreateInFlight(
    inFlightKey: string,
    create: () => Promise<ProbeResult | null>,
    options?: { probeCacheKey?: string }
  ): Promise<ProbeResult | null>;
  hasInFlightForProbeCacheKey(probeCacheKey: string): boolean;
}

export function createInMemoryProviderProbeCachePort({
  ttlMs = PROBE_CACHE_TTL_MS,
  now = Date.now,
}: {
  ttlMs?: number;
  now?: () => number;
} = {}): ProviderProbeCachePort {
  const cachedProbeResults = new Map<string, CachedProbeResult>();
  const probeInFlightByKey = new Map<string, Promise<ProbeResult | null>>();
  const inFlightCountByProbeCacheKey = new Map<string, number>();

  const incrementInFlightCount = (probeCacheKey: string | undefined): void => {
    if (!probeCacheKey) return;
    inFlightCountByProbeCacheKey.set(
      probeCacheKey,
      (inFlightCountByProbeCacheKey.get(probeCacheKey) ?? 0) + 1
    );
  };

  const decrementInFlightCount = (probeCacheKey: string | undefined): void => {
    if (!probeCacheKey) return;
    const nextCount = (inFlightCountByProbeCacheKey.get(probeCacheKey) ?? 0) - 1;
    if (nextCount > 0) {
      inFlightCountByProbeCacheKey.set(probeCacheKey, nextCount);
      return;
    }
    inFlightCountByProbeCacheKey.delete(probeCacheKey);
  };

  return {
    get(cacheKey) {
      const cached = cachedProbeResults.get(cacheKey);
      if (!cached) return null;
      const ageMs = now() - cached.cachedAtMs;
      if (ageMs >= ttlMs) {
        cachedProbeResults.delete(cacheKey);
        return null;
      }
      return { ...cached };
    },
    set(cacheKey, result) {
      cachedProbeResults.set(cacheKey, { cacheKey, ...result, cachedAtMs: now() });
    },
    delete(cacheKey) {
      cachedProbeResults.delete(cacheKey);
    },
    getOrCreateInFlight(inFlightKey, create, options) {
      const existingProbe = probeInFlightByKey.get(inFlightKey);
      if (existingProbe) {
        return existingProbe;
      }

      const probeCacheKey = options?.probeCacheKey;
      const probePromise = create().finally(() => {
        if (probeInFlightByKey.get(inFlightKey) === probePromise) {
          probeInFlightByKey.delete(inFlightKey);
          decrementInFlightCount(probeCacheKey);
        }
      });
      probeInFlightByKey.set(inFlightKey, probePromise);
      incrementInFlightCount(probeCacheKey);
      return probePromise;
    },
    hasInFlightForProbeCacheKey(probeCacheKey) {
      return (inFlightCountByProbeCacheKey.get(probeCacheKey) ?? 0) > 0;
    },
  };
}
