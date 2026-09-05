import { isAbsoluteExistingFile } from '@main/utils/runtimePathBinaryResolver';

export type OpenCodeBinaryVersionProbe =
  | { ok: true; version: string | null }
  | { ok: false; error: string };

export type VerifiedOpenCodeBinaryProbe =
  | { ok: true; binaryPath: string; version: string | null }
  | { ok: false; firstFailure: { binaryPath: string; error: string } | null };

interface CachedResult<T> {
  result: T;
  cachedAt: number;
  ttlMs: number;
}

interface CachedRuntimeBinaryResolve {
  binaryPath: string | null;
  cachedAt: number;
  ttlMs: number;
}

export const versionProbeCache = new Map<string, CachedResult<OpenCodeBinaryVersionProbe>>();
export const versionProbeInFlight = new Map<string, Promise<OpenCodeBinaryVersionProbe>>();
export const pathProbeCache = new Map<string, CachedResult<VerifiedOpenCodeBinaryProbe>>();
export const pathProbeInFlight = new Map<string, Promise<VerifiedOpenCodeBinaryProbe>>();
export const runtimeBinaryResolveCache = new Map<string, CachedRuntimeBinaryResolve>();
export const runtimeBinaryResolveInFlight = new Map<string, Promise<string | null>>();

let generation = 0;

export function getOpenCodeRuntimeResolverCacheGeneration(): number {
  return generation;
}

export function clearOpenCodeRuntimeResolverCache(): void {
  generation += 1;
  versionProbeCache.clear();
  versionProbeInFlight.clear();
  pathProbeCache.clear();
  pathProbeInFlight.clear();
  runtimeBinaryResolveCache.clear();
  runtimeBinaryResolveInFlight.clear();
}

/** Reuses only a fresh path that an earlier active probe already verified. */
export function resolveCachedVerifiedOpenCodeRuntimeBinaryPath(): string | null {
  const now = Date.now();
  const candidates: Array<{ binaryPath: string; cachedAt: number }> = [];
  for (const cached of runtimeBinaryResolveCache.values()) {
    if (
      cached.binaryPath &&
      now - cached.cachedAt < cached.ttlMs &&
      isAbsoluteExistingFile(cached.binaryPath)
    ) {
      candidates.push({ binaryPath: cached.binaryPath, cachedAt: cached.cachedAt });
    }
  }
  for (const cached of pathProbeCache.values()) {
    if (
      cached.result.ok &&
      now - cached.cachedAt < cached.ttlMs &&
      isAbsoluteExistingFile(cached.result.binaryPath)
    ) {
      candidates.push({ binaryPath: cached.result.binaryPath, cachedAt: cached.cachedAt });
    }
  }
  return (
    candidates.toSorted((left, right) => right.cachedAt - left.cachedAt)[0]?.binaryPath ?? null
  );
}
