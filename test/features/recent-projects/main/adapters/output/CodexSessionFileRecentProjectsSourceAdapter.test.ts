import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CodexSessionFileRecentProjectsSourceAdapter } from '@features/recent-projects/main/adapters/output/sources/CodexSessionFileRecentProjectsSourceAdapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
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

function getSessionFileCachePath(appDataPath: string): string {
  return path.join(appDataPath, 'recent-projects', 'codex-session-files-index.json');
}

async function writeRollout(
  filePath: string,
  payload: {
    cwd: string;
    source?: string;
    timestamp?: string;
    branch?: string;
    metadataPadding?: string;
  },
  mtime: Date
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: payload.timestamp ?? mtime.toISOString(),
      type: 'session_meta',
      payload: {
        id: path.basename(filePath, '.jsonl'),
        timestamp: payload.timestamp ?? mtime.toISOString(),
        cwd: payload.cwd,
        source: payload.source ?? 'cli',
        git: payload.branch ? { branch: payload.branch } : undefined,
        ...(payload.metadataPadding
          ? { base_instructions: { text: payload.metadataPadding } }
          : {}),
      },
    })}\n${'x'.repeat(1024)}`,
    'utf8'
  );
  await fs.utimes(filePath, mtime, mtime);
}

describe('CodexSessionFileRecentProjectsSourceAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads recent interactive Codex projects from session files', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue({
        id: 'repo:alpha',
        name: 'alpha',
      }),
    } as unknown as RecentProjectIdentityResolver;
    const updatedAt = new Date('2026-04-14T12:00:00.000Z');
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-alpha.jsonl'),
      {
        cwd: '/Users/test/projects/alpha',
        branch: 'main',
      },
      updatedAt
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          identity: 'repo:alpha',
          displayName: 'alpha',
          primaryPath: '/Users/test/projects/alpha',
          lastActivityAt: updatedAt.getTime(),
          providerIds: ['codex'],
          sourceKind: 'codex',
          openTarget: {
            type: 'synthetic-path',
            path: '/Users/test/projects/alpha',
          },
          branchName: 'main',
        }),
      ],
      degraded: false,
    });
    expect(identityResolver.resolve).toHaveBeenCalledWith('/Users/test/projects/alpha');
  });

  it('marks a Codex session project as deleted when its cwd is gone', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const fsProvider = {
      exists: vi.fn().mockResolvedValue(false),
    };
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-deleted.jsonl'),
      {
        cwd: '/Users/test/projects/deleted',
      },
      new Date('2026-04-14T12:00:00.000Z')
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1', fsProvider }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    const result = await adapter.list();

    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        primaryPath: '/Users/test/projects/deleted',
        filesystemState: 'deleted',
      })
    );
    expect(fsProvider.exists).toHaveBeenCalledWith('/Users/test/projects/deleted');
  });

  it('loads Codex projects from large session metadata lines without parsing the full line', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const updatedAt = new Date('2026-04-14T12:00:00.000Z');
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-large.jsonl'),
      {
        cwd: '/Users/test/projects/large',
        metadataPadding: 'x'.repeat(160_000),
      },
      updatedAt
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    const result = await adapter.list();

    expect(result.candidates).toEqual([
      expect.objectContaining({
        primaryPath: '/Users/test/projects/large',
        sourceKind: 'codex',
      }),
    ]);
  });

  it('deduplicates sessions by cwd and keeps the newest activity', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '13', 'rollout-alpha-old.jsonl'),
      {
        cwd: '/Users/test/projects/alpha',
        branch: 'old',
      },
      new Date('2026-04-13T12:00:00.000Z')
    );
    await writeRollout(
      path.join(codexHome, 'archived_sessions', 'rollout-alpha-new.jsonl'),
      {
        cwd: '/Users/test/projects/alpha',
        branch: 'new',
      },
      new Date('2026-04-14T12:00:00.000Z')
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    const result = await adapter.list();

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        primaryPath: '/Users/test/projects/alpha',
        lastActivityAt: Date.parse('2026-04-14T12:00:00.000Z'),
        branchName: 'new',
      })
    );
    expect(identityResolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning past duplicate recent sessions to find more projects', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const baseTime = Date.parse('2026-04-14T12:00:00.000Z');

    await Promise.all(
      Array.from({ length: 130 }).map((_, index) =>
        writeRollout(
          path.join(codexHome, 'sessions', '2026', '04', '14', `rollout-alpha-${index}.jsonl`),
          {
            cwd: '/Users/test/projects/alpha',
            branch: 'main',
          },
          new Date(baseTime - index * 1000)
        )
      )
    );
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-beta.jsonl'),
      {
        cwd: '/Users/test/projects/beta',
        branch: 'main',
      },
      new Date(baseTime - 140_000)
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    const result = await adapter.list();

    expect(result.candidates.map((candidate) => candidate.primaryPath)).toEqual([
      '/Users/test/projects/alpha',
      '/Users/test/projects/beta',
    ]);
  });

  it('reuses cached unchanged session metadata without reopening jsonl files', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const appDataPath = path.join(tempDir, 'app-data');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const updatedAt = new Date('2026-04-14T12:00:00.000Z');
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-alpha.jsonl'),
      {
        cwd: '/Users/test/projects/alpha',
        branch: 'main',
      },
      updatedAt
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });
    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          primaryPath: '/Users/test/projects/alpha',
          branchName: 'main',
        }),
      ],
      degraded: false,
    });

    const openSpy = vi.spyOn(fs, 'open');
    const cachedAdapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });

    await expect(cachedAdapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          primaryPath: '/Users/test/projects/alpha',
          branchName: 'main',
        }),
      ],
      degraded: false,
    });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('invalidates cached session metadata when the jsonl fingerprint changes', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const appDataPath = path.join(tempDir, 'app-data');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const sessionPath = path.join(
      codexHome,
      'sessions',
      '2026',
      '04',
      '14',
      'rollout-active.jsonl'
    );
    await writeRollout(
      sessionPath,
      {
        cwd: '/Users/test/projects/alpha',
      },
      new Date('2026-04-14T12:00:00.000Z')
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });
    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          primaryPath: '/Users/test/projects/alpha',
        }),
      ],
      degraded: false,
    });

    await writeRollout(
      sessionPath,
      {
        cwd: '/Users/test/projects/beta',
      },
      new Date('2026-04-14T12:01:00.000Z')
    );

    const refreshedAdapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });

    await expect(refreshedAdapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          primaryPath: '/Users/test/projects/beta',
        }),
      ],
      degraded: false,
    });
  });

  it('does not let a slow jsonl read hold the whole source past its timeout budget', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const appDataPath = path.join(tempDir, 'app-data');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const baseTime = Date.parse('2026-04-14T12:00:00.000Z');
    const slowSessionPath = path.join(
      codexHome,
      'sessions',
      '2026',
      '04',
      '14',
      'rollout-slow.jsonl'
    );
    await writeRollout(
      slowSessionPath,
      {
        cwd: '/Users/test/projects/slow',
      },
      new Date(baseTime)
    );
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-fast.jsonl'),
      {
        cwd: '/Users/test/projects/fast',
      },
      new Date(baseTime - 1000)
    );
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === slowSessionPath) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      return originalOpen(...args);
    });

    const startedAt = Date.now();
    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });
    const result = await adapter.list();

    expect(Date.now() - startedAt).toBeLessThan(1600);
    expect(result.degraded).toBe(true);
    expect(result.candidates.map((candidate) => candidate.primaryPath)).toEqual([
      '/Users/test/projects/fast',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'codex session-file recent-projects source partial',
      expect.objectContaining({
        files: 2,
        timedOutReads: 1,
      })
    );
  });

  it('ignores a corrupt session-file cache and rebuilds from session files', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const appDataPath = path.join(tempDir, 'app-data');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-alpha.jsonl'),
      {
        cwd: '/Users/test/projects/alpha',
      },
      new Date('2026-04-14T12:00:00.000Z')
    );
    const cachePath = getSessionFileCachePath(appDataPath);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, '{not-json', 'utf8');

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          primaryPath: '/Users/test/projects/alpha',
        }),
      ],
      degraded: false,
    });
  });

  it('returns a degraded partial result under the uncached read cap and completes on the next cached pass', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const appDataPath = path.join(tempDir, 'app-data');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn().mockResolvedValue(null),
    } as unknown as RecentProjectIdentityResolver;
    const baseTime = Date.parse('2026-04-14T12:00:00.000Z');

    await Promise.all(
      Array.from({ length: 170 }).map((_, index) =>
        writeRollout(
          path.join(codexHome, 'sessions', '2026', '04', '14', `rollout-alpha-${index}.jsonl`),
          {
            cwd: '/Users/test/projects/alpha',
            branch: 'main',
          },
          new Date(baseTime - index * 1000)
        )
      )
    );
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-beta.jsonl'),
      {
        cwd: '/Users/test/projects/beta',
        branch: 'main',
      },
      new Date(baseTime - 200_000)
    );

    const firstAdapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });
    const firstResult = await firstAdapter.list();

    expect(firstResult.degraded).toBe(true);
    expect(firstResult.candidates.map((candidate) => candidate.primaryPath)).toEqual([
      '/Users/test/projects/alpha',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'codex session-file recent-projects source partial',
      expect.objectContaining({
        files: 171,
        uncachedReads: 160,
        skippedUncached: 11,
      })
    );

    const secondAdapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath,
    });
    const secondResult = await secondAdapter.list();

    expect(secondResult.degraded).toBe(false);
    expect(secondResult.candidates.map((candidate) => candidate.primaryPath)).toEqual([
      '/Users/test/projects/alpha',
      '/Users/test/projects/beta',
    ]);
  });

  it('skips non-interactive and ephemeral sessions', async () => {
    const codexHome = path.join(tempDir, '.codex');
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn(),
    } as unknown as RecentProjectIdentityResolver;
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-background.jsonl'),
      {
        cwd: '/Users/test/projects/background',
        source: 'background',
      },
      new Date('2026-04-14T12:00:00.000Z')
    );
    await writeRollout(
      path.join(codexHome, 'sessions', '2026', '04', '14', 'rollout-temp.jsonl'),
      {
        cwd: '/private/var/folders/x/T/codex-agent-teams-appstyle-123',
        source: 'cli',
      },
      new Date('2026-04-14T12:01:00.000Z')
    );

    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome,
      appDataPath: path.join(tempDir, 'app-data'),
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [],
      degraded: false,
    });
    expect(identityResolver.resolve).not.toHaveBeenCalled();
  });

  it('returns an empty healthy result when Codex session folders are absent', async () => {
    const logger = createLogger();
    const identityResolver = {
      resolve: vi.fn(),
    } as unknown as RecentProjectIdentityResolver;
    const adapter = new CodexSessionFileRecentProjectsSourceAdapter({
      getActiveContext: () => ({ type: 'local', id: 'local-1' }) as never,
      getLocalContext: () => ({ type: 'local', id: 'local-1' }) as never,
      identityResolver,
      logger,
      codexHome: path.join(tempDir, 'missing-codex-home'),
      appDataPath: path.join(tempDir, 'app-data'),
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [],
      degraded: false,
    });
  });
});
