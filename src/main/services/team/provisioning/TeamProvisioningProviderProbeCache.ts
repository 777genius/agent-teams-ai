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
    cacheKey: string,
    create: () => Promise<ProbeResult | null>
  ): Promise<ProbeResult | null>;
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
    getOrCreateInFlight(cacheKey, create) {
      const existingProbe = probeInFlightByKey.get(cacheKey);
      if (existingProbe) {
        return existingProbe;
      }

      const probePromise = create().finally(() => {
        if (probeInFlightByKey.get(cacheKey) === probePromise) {
          probeInFlightByKey.delete(cacheKey);
        }
      });
      probeInFlightByKey.set(cacheKey, probePromise);
      return probePromise;
    },
  };
}
