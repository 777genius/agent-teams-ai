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

export interface ProviderProbePublication {
  result: ProbeResult | null;
  cacheable: boolean;
}

export interface ProviderProbeCachePort {
  get(cacheKey: string): CachedProbeResult | null;
  invalidate(cacheKey: string): void;
  getOrCreate(
    cacheKey: string,
    create: () => Promise<ProviderProbePublication>
  ): Promise<ProbeResult | null>;
}

interface ProviderProbeAttempt {
  result?: ProbeResult | null;
  error?: unknown;
}

interface ProviderProbeInFlight {
  promise: Promise<ProviderProbeAttempt>;
}

interface ProviderProbeCacheState {
  epoch: number;
  cached: CachedProbeResult | null;
  inFlight: ProviderProbeInFlight | null;
  // New callers ignore this; it only carries the current epoch outcome to superseded callers.
  settledAttempt: ProviderProbeAttempt | null;
}

export function createInMemoryProviderProbeCachePort({
  ttlMs = PROBE_CACHE_TTL_MS,
  now = Date.now,
}: {
  ttlMs?: number;
  now?: () => number;
} = {}): ProviderProbeCachePort {
  const stateByCacheKey = new Map<string, ProviderProbeCacheState>();
  const activeCallCountByCacheKey = new Map<string, number>();

  const getCached = (
    cacheKey: string,
    state: ProviderProbeCacheState
  ): CachedProbeResult | null => {
    const cached = state.cached;
    if (!cached) return null;
    const ageMs = now() - cached.cachedAtMs;
    if (ageMs >= ttlMs) {
      state.cached = null;
      if (
        stateByCacheKey.get(cacheKey) === state &&
        !state.inFlight &&
        (activeCallCountByCacheKey.get(cacheKey) ?? 0) === 0
      ) {
        stateByCacheKey.delete(cacheKey);
      }
      return null;
    }
    return { ...cached };
  };

  const incrementActiveCallCount = (cacheKey: string): void => {
    activeCallCountByCacheKey.set(cacheKey, (activeCallCountByCacheKey.get(cacheKey) ?? 0) + 1);
  };

  const decrementActiveCallCount = (cacheKey: string): void => {
    const nextCount = (activeCallCountByCacheKey.get(cacheKey) ?? 0) - 1;
    if (nextCount > 0) {
      activeCallCountByCacheKey.set(cacheKey, nextCount);
      return;
    }
    activeCallCountByCacheKey.delete(cacheKey);

    const state = stateByCacheKey.get(cacheKey);
    if (state && !state.cached && !state.inFlight) {
      stateByCacheKey.delete(cacheKey);
    }
  };

  return {
    get(cacheKey) {
      const state = stateByCacheKey.get(cacheKey);
      return state ? getCached(cacheKey, state) : null;
    },
    invalidate(cacheKey) {
      const state = stateByCacheKey.get(cacheKey);
      if (!state) return;

      state.cached = null;
      if ((activeCallCountByCacheKey.get(cacheKey) ?? 0) === 0 && !state.inFlight) {
        stateByCacheKey.delete(cacheKey);
        return;
      }

      stateByCacheKey.set(cacheKey, {
        epoch: state.epoch + 1,
        cached: null,
        inFlight: null,
        settledAttempt: null,
      });
    },
    async getOrCreate(cacheKey, create) {
      incrementActiveCallCount(cacheKey);
      try {
        let crossedEpoch = false;
        while (true) {
          let state = stateByCacheKey.get(cacheKey);
          if (!state) {
            state = { epoch: 0, cached: null, inFlight: null, settledAttempt: null };
            stateByCacheKey.set(cacheKey, state);
          }

          const cached = getCached(cacheKey, state);
          if (cached) {
            return {
              claudePath: cached.claudePath,
              authSource: cached.authSource,
              warning: cached.warning,
            };
          }

          let inFlight = state.inFlight;
          if (!inFlight && crossedEpoch && state.settledAttempt) {
            const attempt = state.settledAttempt;
            if ('error' in attempt) {
              throw attempt.error;
            }
            return attempt.result ?? null;
          }
          if (!inFlight) {
            const promise: Promise<ProviderProbeAttempt> = Promise.resolve()
              .then(create)
              .then<ProviderProbeAttempt, ProviderProbeAttempt>(
                (publication) => {
                  if (stateByCacheKey.get(cacheKey) === state) {
                    state.cached =
                      publication.cacheable && publication.result
                        ? {
                            cacheKey,
                            ...publication.result,
                            cachedAtMs: now(),
                          }
                        : null;
                  }
                  return { result: publication.result };
                },
                (error: unknown) => ({ error })
              )
              .then((attempt) => {
                if (state.inFlight?.promise === promise) {
                  state.settledAttempt = attempt;
                  state.inFlight = null;
                }
                return attempt;
              });
            const createdInFlight = { promise };
            state.inFlight = createdInFlight;
            inFlight = createdInFlight;
          }

          const attempt = await inFlight.promise;
          if (stateByCacheKey.get(cacheKey) !== state) {
            crossedEpoch = true;
            continue;
          }
          if ('error' in attempt) {
            throw attempt.error;
          }
          return attempt.result ?? null;
        }
      } finally {
        decrementActiveCallCount(cacheKey);
      }
    },
  };
}
