import type { ProvisioningAuthSource } from './TeamProvisioningEnvBuilder';

const PROBE_CACHE_TTL_MS = 36 * 60 * 60 * 1000;

export interface ProbeResult {
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
  [field: string]: unknown;
}

export interface CachedProbeResult {
  cacheKey: string;
  cachedAtMs: number;
  result: ProbeResult;
}

function deepCloneProviderProbeValue<T>(value: T): T {
  const clones = new WeakMap<object, object>();

  const cloneOwnDataProperties = (
    source: object,
    target: object,
    shouldSkip?: (key: PropertyKey) => boolean
  ): void => {
    for (const key of Reflect.ownKeys(source)) {
      if (shouldSkip?.(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !('value' in descriptor)) continue;
      Object.defineProperty(target, key, {
        ...descriptor,
        value: clone(descriptor.value),
      });
    }
  };

  const clone = (candidate: unknown): unknown => {
    if (typeof candidate !== 'object' || candidate === null) {
      if (typeof candidate === 'function' || typeof candidate === 'symbol') {
        return structuredClone(candidate);
      }
      return candidate;
    }

    const existing = clones.get(candidate);
    if (existing) return existing;

    if (typeof SharedArrayBuffer !== 'undefined' && candidate instanceof SharedArrayBuffer) {
      const isolatedBuffer = new SharedArrayBuffer(candidate.byteLength);
      clones.set(candidate, isolatedBuffer);
      new Uint8Array(isolatedBuffer).set(new Uint8Array(candidate));
      cloneOwnDataProperties(candidate, isolatedBuffer);
      return isolatedBuffer;
    }

    if (candidate instanceof ArrayBuffer) {
      const isolatedBuffer = structuredClone(candidate);
      clones.set(candidate, isolatedBuffer);
      cloneOwnDataProperties(candidate, isolatedBuffer);
      return isolatedBuffer;
    }

    if (ArrayBuffer.isView(candidate)) {
      const isolatedBuffer = clone(candidate.buffer) as ArrayBufferLike;
      const isolatedView =
        candidate instanceof DataView
          ? new DataView(isolatedBuffer, candidate.byteOffset, candidate.byteLength)
          : new (structuredClone(candidate).constructor as new (
              buffer: ArrayBufferLike,
              byteOffset: number,
              length: number
            ) => ArrayBufferView)(
              isolatedBuffer,
              candidate.byteOffset,
              (candidate as ArrayBufferView & { length: number }).length
            );
      clones.set(candidate, isolatedView);
      const viewLength =
        candidate instanceof DataView
          ? 0
          : (candidate as ArrayBufferView & { length: number }).length;
      cloneOwnDataProperties(
        candidate,
        isolatedView,
        (key) => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < viewLength
      );
      return isolatedView;
    }

    if (candidate instanceof Map) {
      const isolatedMap = new Map<unknown, unknown>();
      clones.set(candidate, isolatedMap);
      for (const [key, entryValue] of Map.prototype.entries.call(candidate)) {
        isolatedMap.set(clone(key), clone(entryValue));
      }
      cloneOwnDataProperties(candidate, isolatedMap);
      return isolatedMap;
    }

    if (candidate instanceof Set) {
      const isolatedSet = new Set<unknown>();
      clones.set(candidate, isolatedSet);
      for (const entry of Set.prototype.values.call(candidate)) {
        isolatedSet.add(clone(entry));
      }
      cloneOwnDataProperties(candidate, isolatedSet);
      return isolatedSet;
    }

    if (candidate instanceof Date) {
      const isolatedDate = new Date(candidate.getTime());
      clones.set(candidate, isolatedDate);
      cloneOwnDataProperties(candidate, isolatedDate);
      return isolatedDate;
    }

    if (candidate instanceof RegExp) {
      const isolatedRegExp = new RegExp(candidate.source, candidate.flags);
      clones.set(candidate, isolatedRegExp);
      cloneOwnDataProperties(candidate, isolatedRegExp);
      return isolatedRegExp;
    }

    if (candidate instanceof Error) {
      const isolatedError = structuredClone(candidate);
      clones.set(candidate, isolatedError);
      cloneOwnDataProperties(candidate, isolatedError);
      return isolatedError;
    }

    const isolatedObject: object = Array.isArray(candidate) ? [] : {};
    if (!Array.isArray(candidate) && Object.getPrototypeOf(candidate) === null) {
      Object.setPrototypeOf(isolatedObject, null);
    }
    clones.set(candidate, isolatedObject);
    cloneOwnDataProperties(candidate, isolatedObject);
    return isolatedObject;
  };

  return clone(value) as T;
}

export function cloneProviderProbeResult<T extends ProbeResult>(result: T): T {
  return deepCloneProviderProbeValue(result);
}

export function cloneCachedProviderProbeResult<T extends CachedProbeResult>(cached: T): T {
  return deepCloneProviderProbeValue(cached);
}

export function cachedProviderProbeResultToProbeResult(cached: CachedProbeResult): ProbeResult {
  return cloneProviderProbeResult(cached.result);
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
    return cloneCachedProviderProbeResult(cached);
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
        let supersededAttempt: ProviderProbeAttempt | null = null;
        while (true) {
          let state = stateByCacheKey.get(cacheKey);
          if (!state) {
            state = { epoch: 0, cached: null, inFlight: null, settledAttempt: null };
            stateByCacheKey.set(cacheKey, state);
          }

          const cached = getCached(cacheKey, state);
          if (cached) {
            return cachedProviderProbeResultToProbeResult(cached);
          }

          let inFlight = state.inFlight;
          if (!inFlight && supersededAttempt) {
            const attempt = state.settledAttempt ?? supersededAttempt;
            if ('error' in attempt) {
              throw attempt.error;
            }
            return attempt.result ? cloneProviderProbeResult(attempt.result) : null;
          }
          if (!inFlight) {
            const promise: Promise<ProviderProbeAttempt> = Promise.resolve()
              .then(create)
              .then<ProviderProbeAttempt>((publication) => {
                const result = publication.result
                  ? cloneProviderProbeResult(publication.result)
                  : null;
                if (stateByCacheKey.get(cacheKey) === state) {
                  state.cached =
                    publication.cacheable && result
                      ? {
                          cacheKey,
                          cachedAtMs: now(),
                          result: cloneProviderProbeResult(result),
                        }
                      : null;
                }
                return { result };
              })
              .then<ProviderProbeAttempt, ProviderProbeAttempt>(
                (attempt) => attempt,
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
            supersededAttempt = attempt;
            continue;
          }
          if ('error' in attempt) {
            throw attempt.error;
          }
          return attempt.result ? cloneProviderProbeResult(attempt.result) : null;
        }
      } finally {
        decrementActiveCallCount(cacheKey);
      }
    },
  };
}
