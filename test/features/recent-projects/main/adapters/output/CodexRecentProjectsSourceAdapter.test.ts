import { describe, expect, it, vi } from 'vitest';

import { CodexRecentProjectsSourceAdapter } from '@features/recent-projects/main/adapters/output/sources/CodexRecentProjectsSourceAdapter';

import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
import type { CodexAppServerClient } from '@features/recent-projects/main/infrastructure/codex/CodexAppServerClient';
import type { RecentProjectIdentityResolver } from '@features/recent-projects/main/infrastructure/identity/RecentProjectIdentityResolver';

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

describe('CodexRecentProjectsSourceAdapter', () => {
  it('treats archived-only timeout as non-blocking degradation when live threads loaded', async () => {
    const logger = createLogger();
    const appServerClient = {
      listRecentThreads: vi.fn().mockResolvedValue({
        live: {
          threads: [
            {
              id: 'thread-live',
              cwd: '/Users/belief/dev/projects/headless',
              source: 'cli',
              updatedAt: 1_700_000_000,
              gitInfo: { branch: 'main' },
            },
          ],
        },
        archived: {
          threads: [],
          error: 'JSON-RPC request timed out: thread/list',
        },
      }),
      listRecentLiveThreads: vi.fn(),
    } as unknown as CodexAppServerClient;
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue({
        id: 'repo:headless',
        name: 'headless',
      }),
    } as unknown as RecentProjectIdentityResolver;

    const adapter = new CodexRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      resolveBinary: vi.fn().mockResolvedValue('/usr/local/bin/codex'),
      appServerClient,
      identityResolver,
      logger,
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          identity: 'repo:headless',
          primaryPath: '/Users/belief/dev/projects/headless',
        }),
      ],
      degraded: true,
    });

    expect(logger.info).toHaveBeenCalledWith(
      'codex recent-projects archived thread list degraded',
      {
        error: 'JSON-RPC request timed out: thread/list',
      }
    );
    expect(logger.warn).not.toHaveBeenCalledWith('codex recent-projects thread list failed', {
      segment: 'archived',
      error: 'JSON-RPC request timed out: thread/list',
    });
  });

  it('falls back to live-only threads when the full app-server session fails fast', async () => {
    const logger = createLogger();
    const appServerClient = {
      listRecentThreads: vi
        .fn()
        .mockRejectedValue(new Error('JSON-RPC process exited unexpectedly (code=1 signal=null)')),
      listRecentLiveThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: 'thread-live',
            cwd: '/Users/belief/dev/projects/headless',
            source: 'cli',
            updatedAt: 1_700_000_000,
            gitInfo: { branch: 'main' },
          },
        ],
      }),
    } as unknown as CodexAppServerClient;
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue({
        id: 'repo:headless',
        name: 'headless',
      }),
    } as unknown as RecentProjectIdentityResolver;

    const adapter = new CodexRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      resolveBinary: vi.fn().mockResolvedValue('/usr/local/bin/codex'),
      appServerClient,
      identityResolver,
      logger,
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          identity: 'repo:headless',
          displayName: 'headless',
          primaryPath: '/Users/belief/dev/projects/headless',
          providerIds: ['codex'],
          sourceKind: 'codex',
          openTarget: {
            type: 'synthetic-path',
            path: '/Users/belief/dev/projects/headless',
          },
          branchName: 'main',
        }),
      ],
      degraded: true,
    });

    expect(appServerClient.listRecentThreads).toHaveBeenCalledTimes(1);
    expect(appServerClient.listRecentLiveThreads).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('codex recent-projects recovered with live-only fallback', {
      liveCount: 1,
    });
  });

  it('does not spend extra time on live-only fallback after a full session timeout', async () => {
    const logger = createLogger();
    const appServerClient = {
      listRecentThreads: vi
        .fn()
        .mockRejectedValue(new Error('codex app-server thread/list timed out after 8500ms')),
      listRecentLiveThreads: vi.fn(),
    } as unknown as CodexAppServerClient;
    const identityResolver = {
      resolve: vi.fn(),
    } as unknown as RecentProjectIdentityResolver;

    const adapter = new CodexRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      resolveBinary: vi.fn().mockResolvedValue('/usr/local/bin/codex'),
      appServerClient,
      identityResolver,
      logger,
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [],
      degraded: true,
    });
    expect(appServerClient.listRecentLiveThreads).not.toHaveBeenCalled();
  });
});
