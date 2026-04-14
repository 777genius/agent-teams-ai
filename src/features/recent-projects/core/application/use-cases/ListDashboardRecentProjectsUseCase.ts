import { mergeRecentProjectCandidates } from '../../domain/policies/mergeRecentProjectCandidates';

import type { RecentProjectCandidate } from '../../domain/models/RecentProjectCandidate';
import type { ListDashboardRecentProjectsResponse } from '../models/ListDashboardRecentProjectsResponse';
import type { ClockPort } from '../ports/ClockPort';
import type { ListDashboardRecentProjectsOutputPort } from '../ports/ListDashboardRecentProjectsOutputPort';
import type { LoggerPort } from '../ports/LoggerPort';
import type { RecentProjectsCachePort } from '../ports/RecentProjectsCachePort';
import type { RecentProjectsSourcePort } from '../ports/RecentProjectsSourcePort';

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_DEGRADED_CACHE_TTL_MS = 1_500;

interface SourceLoadResult {
  candidates: RecentProjectCandidate[];
  degraded: boolean;
}

export interface ListDashboardRecentProjectsDeps<TViewModel> {
  sources: RecentProjectsSourcePort[];
  cache: RecentProjectsCachePort<TViewModel>;
  output: ListDashboardRecentProjectsOutputPort<TViewModel>;
  clock: ClockPort;
  logger: LoggerPort;
  cacheTtlMs?: number;
  degradedCacheTtlMs?: number;
}

export class ListDashboardRecentProjectsUseCase<TViewModel> {
  readonly #cacheTtlMs: number;
  readonly #degradedCacheTtlMs: number;
  readonly #inFlightByCacheKey = new Map<string, Promise<TViewModel>>();

  constructor(private readonly deps: ListDashboardRecentProjectsDeps<TViewModel>) {
    this.#cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#degradedCacheTtlMs = deps.degradedCacheTtlMs ?? DEFAULT_DEGRADED_CACHE_TTL_MS;
  }

  async execute(cacheKey: string): Promise<TViewModel> {
    const cached = await this.deps.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const inFlight = this.#inFlightByCacheKey.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const execution = this.#executeUncached(cacheKey).finally(() => {
      this.#inFlightByCacheKey.delete(cacheKey);
    });

    this.#inFlightByCacheKey.set(cacheKey, execution);
    return execution;
  }

  async #executeUncached(cacheKey: string): Promise<TViewModel> {
    const startedAt = this.deps.clock.now();
    const stale = await this.deps.cache.getStale(cacheKey);
    const results = await Promise.all(
      this.deps.sources.map((source, index) => this.#loadSource(source, index))
    );

    const successful = results.flatMap((result) => result.candidates);
    const hasDegradedSources = results.some((result) => result.degraded);

    if (hasDegradedSources && stale) {
      await this.deps.cache.set(cacheKey, stale, this.#degradedCacheTtlMs);
      this.deps.logger.info('recent-projects served stale cache', {
        cacheKey,
        degradedSources: results.filter((result) => result.degraded).length,
        cacheTtlMs: this.#degradedCacheTtlMs,
        durationMs: this.deps.clock.now() - startedAt,
      });
      return stale;
    }

    const response: ListDashboardRecentProjectsResponse = {
      projects: mergeRecentProjectCandidates(successful),
    };
    const viewModel = this.deps.output.present(response);
    const cacheTtlMs = hasDegradedSources
      ? Math.min(this.#cacheTtlMs, this.#degradedCacheTtlMs)
      : this.#cacheTtlMs;

    await this.deps.cache.set(cacheKey, viewModel, cacheTtlMs);
    this.deps.logger.info('recent-projects loaded', {
      cacheKey,
      count: response.projects.length,
      degradedSources: results.filter((result) => result.degraded).length,
      cacheTtlMs,
      durationMs: this.deps.clock.now() - startedAt,
    });

    return viewModel;
  }

  async #loadSource(
    source: RecentProjectsSourcePort,
    sourceIndex: number
  ): Promise<SourceLoadResult> {
    const sourceId = source.sourceId ?? `source-${sourceIndex}`;
    if (!source.timeoutMs || source.timeoutMs <= 0) {
      return this.#loadSourceWithoutTimeout(source, sourceId, sourceIndex);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        source
          .list()
          .then(
            (candidates) =>
              ({
                kind: 'success',
                candidates,
              }) as const
          )
          .catch(
            (error: unknown) =>
              ({
                kind: 'error',
                error,
              }) as const
          ),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), source.timeoutMs);
        }),
      ]);

      if (result.kind === 'success') {
        return { candidates: result.candidates, degraded: false };
      }

      if (result.kind === 'timeout') {
        this.deps.logger.warn('recent-projects source timed out', {
          sourceId,
          sourceIndex,
          timeoutMs: source.timeoutMs,
        });
        return { candidates: [], degraded: true };
      }

      this.deps.logger.warn('recent-projects source failed', {
        sourceId,
        sourceIndex,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
      return { candidates: [], degraded: true };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async #loadSourceWithoutTimeout(
    source: RecentProjectsSourcePort,
    sourceId: string,
    sourceIndex: number
  ): Promise<SourceLoadResult> {
    try {
      return {
        candidates: await source.list(),
        degraded: false,
      };
    } catch (error) {
      this.deps.logger.warn('recent-projects source failed', {
        sourceId,
        sourceIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      return { candidates: [], degraded: true };
    }
  }
}
