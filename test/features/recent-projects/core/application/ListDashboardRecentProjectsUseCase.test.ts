import { describe, expect, it, vi } from 'vitest';

import { ListDashboardRecentProjectsUseCase } from '@features/recent-projects/core/application/use-cases/ListDashboardRecentProjectsUseCase';

import type { ListDashboardRecentProjectsResponse } from '@features/recent-projects/core/application/models/ListDashboardRecentProjectsResponse';
import type { ListDashboardRecentProjectsOutputPort } from '@features/recent-projects/core/application/ports/ListDashboardRecentProjectsOutputPort';
import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
import type { RecentProjectsCachePort } from '@features/recent-projects/core/application/ports/RecentProjectsCachePort';
import type { RecentProjectsSourcePort } from '@features/recent-projects/core/application/ports/RecentProjectsSourcePort';
import type { RecentProjectCandidate } from '@features/recent-projects/core/domain/models/RecentProjectCandidate';

interface TestViewModel {
  ids: string[];
  sources: string[];
}

function makeCandidate(overrides: Partial<RecentProjectCandidate> = {}): RecentProjectCandidate {
  return {
    identity: 'repo:alpha',
    displayName: 'alpha',
    primaryPath: '/workspace/alpha',
    associatedPaths: ['/workspace/alpha'],
    lastActivityAt: 1_000,
    providerIds: ['anthropic'],
    sourceKind: 'claude',
    openTarget: {
      type: 'existing-worktree',
      repositoryId: 'repo-alpha',
      worktreeId: 'wt-alpha',
    },
    branchName: 'main',
    ...overrides,
  };
}

function createLogger(): LoggerPort & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('ListDashboardRecentProjectsUseCase', () => {
  it('returns cached data without calling sources or presenter', async () => {
    const cached: TestViewModel = { ids: ['cached'], sources: ['cached'] };
    const cache: RecentProjectsCachePort<TestViewModel> = {
      get: vi.fn().mockResolvedValue(cached),
      getStale: vi.fn().mockResolvedValue(cached),
      set: vi.fn(),
    };
    const output: ListDashboardRecentProjectsOutputPort<TestViewModel> = {
      present: vi.fn(),
    };
    const source: RecentProjectsSourcePort = {
      list: vi.fn(),
    };
    const logger = createLogger();

    const useCase = new ListDashboardRecentProjectsUseCase({
      sources: [source],
      cache,
      output,
      clock: { now: () => 1_000 },
      logger,
    });

    await expect(useCase.execute('recent-projects:cache')).resolves.toEqual(cached);
    expect(source.list).not.toHaveBeenCalled();
    expect(output.present).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('merges successful sources, degrades failed sources, and caches presenter output', async () => {
    const cache: RecentProjectsCachePort<TestViewModel> = {
      get: vi.fn().mockResolvedValue(null),
      getStale: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const output: ListDashboardRecentProjectsOutputPort<TestViewModel> = {
      present: vi.fn((response: ListDashboardRecentProjectsResponse) => ({
        ids: response.projects.map((project) => project.identity),
        sources: response.projects.map((project) => project.source),
      })),
    };
    const sources: RecentProjectsSourcePort[] = [
      {
        list: vi.fn().mockResolvedValue([
          makeCandidate({
            identity: 'repo:alpha',
            lastActivityAt: 2_000,
            providerIds: ['anthropic'],
            sourceKind: 'claude',
          }),
        ]),
      },
      {
        list: vi.fn().mockRejectedValue(new Error('codex unavailable')),
      },
      {
        list: vi.fn().mockResolvedValue([
          makeCandidate({
            identity: 'repo:alpha',
            lastActivityAt: 4_000,
            providerIds: ['codex'],
            sourceKind: 'codex',
            openTarget: {
              type: 'synthetic-path',
              path: '/workspace/alpha',
            },
          }),
        ]),
      },
    ];
    const logger = createLogger();
    let now = 10_000;

    const useCase = new ListDashboardRecentProjectsUseCase({
      sources,
      cache,
      output,
      clock: {
        now: () => {
          const current = now;
          now += 250;
          return current;
        },
      },
      logger,
    });

    const result = await useCase.execute('recent-projects:fresh');

    expect(result).toEqual({
      ids: ['repo:alpha'],
      sources: ['mixed'],
    });
    expect(output.present).toHaveBeenCalledWith({
      projects: [
        expect.objectContaining({
          identity: 'repo:alpha',
          source: 'mixed',
          providerIds: ['anthropic', 'codex'],
          lastActivityAt: 4_000,
          openTarget: {
            type: 'existing-worktree',
            repositoryId: 'repo-alpha',
            worktreeId: 'wt-alpha',
          },
        }),
      ],
    });
    expect(cache.set).toHaveBeenCalledWith('recent-projects:fresh', result, 1_500);
    expect(logger.warn).toHaveBeenCalledWith('recent-projects source failed', {
      sourceId: 'source-1',
      sourceIndex: 1,
      error: 'codex unavailable',
    });
    expect(logger.info).toHaveBeenCalledWith('recent-projects loaded', {
      cacheKey: 'recent-projects:fresh',
      count: 1,
      degradedSources: 1,
      cacheTtlMs: 1_500,
      durationMs: 250,
    });
  });

  it('returns fast sources without waiting for a timed out source', async () => {
    vi.useFakeTimers();
    try {
      const cache: RecentProjectsCachePort<TestViewModel> = {
        get: vi.fn().mockResolvedValue(null),
        getStale: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const output: ListDashboardRecentProjectsOutputPort<TestViewModel> = {
        present: vi.fn((response: ListDashboardRecentProjectsResponse) => ({
          ids: response.projects.map((project) => project.identity),
          sources: response.projects.map((project) => project.source),
        })),
      };
      const slowSource: RecentProjectsSourcePort = {
        sourceId: 'codex',
        timeoutMs: 50,
        list: vi.fn(
          () =>
            new Promise<RecentProjectCandidate[]>((resolve) => {
              setTimeout(
                () =>
                  resolve([
                    makeCandidate({
                      identity: 'repo:codex-only',
                      providerIds: ['codex'],
                      sourceKind: 'codex',
                      openTarget: {
                        type: 'synthetic-path',
                        path: '/workspace/codex-only',
                      },
                    }),
                  ]),
                500
              );
            })
        ),
      };
      const fastSource: RecentProjectsSourcePort = {
        sourceId: 'claude',
        list: vi.fn().mockResolvedValue([
          makeCandidate({
            identity: 'repo:fast',
            providerIds: ['anthropic'],
            sourceKind: 'claude',
          }),
        ]),
      };
      const logger = createLogger();
      const useCase = new ListDashboardRecentProjectsUseCase({
        sources: [fastSource, slowSource],
        cache,
        output,
        clock: { now: () => 2_000 },
        logger,
      });

      const execution = useCase.execute('recent-projects:timeout');
      await vi.advanceTimersByTimeAsync(60);

      await expect(execution).resolves.toEqual({
        ids: ['repo:fast'],
        sources: ['claude'],
      });
      expect(logger.warn).toHaveBeenCalledWith('recent-projects source timed out', {
        sourceId: 'codex',
        sourceIndex: 1,
        timeoutMs: 50,
      });
      expect(cache.set).toHaveBeenCalledWith(
        'recent-projects:timeout',
        { ids: ['repo:fast'], sources: ['claude'] },
        1_500
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns stale cached data when a source degrades after cache expiry', async () => {
    const stale: TestViewModel = { ids: ['repo:stale'], sources: ['mixed'] };
    const cache: RecentProjectsCachePort<TestViewModel> = {
      get: vi.fn().mockResolvedValue(null),
      getStale: vi.fn().mockResolvedValue(stale),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const output: ListDashboardRecentProjectsOutputPort<TestViewModel> = {
      present: vi.fn((response: ListDashboardRecentProjectsResponse) => ({
        ids: response.projects.map((project) => project.identity),
        sources: response.projects.map((project) => project.source),
      })),
    };
    const sources: RecentProjectsSourcePort[] = [
      {
        sourceId: 'claude',
        list: vi.fn().mockResolvedValue([
          makeCandidate({
            identity: 'repo:fresh',
            providerIds: ['anthropic'],
            sourceKind: 'claude',
          }),
        ]),
      },
      {
        sourceId: 'codex',
        list: vi.fn().mockRejectedValue(new Error('codex unavailable')),
      },
    ];
    const logger = createLogger();
    let now = 15_000;

    const useCase = new ListDashboardRecentProjectsUseCase({
      sources,
      cache,
      output,
      clock: {
        now: () => {
          const current = now;
          now += 200;
          return current;
        },
      },
      logger,
    });

    await expect(useCase.execute('recent-projects:stale')).resolves.toEqual(stale);
    expect(output.present).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith('recent-projects:stale', stale, 1_500);
    expect(logger.info).toHaveBeenCalledWith('recent-projects served stale cache', {
      cacheKey: 'recent-projects:stale',
      degradedSources: 1,
      cacheTtlMs: 1_500,
      durationMs: 200,
    });
  });
});
