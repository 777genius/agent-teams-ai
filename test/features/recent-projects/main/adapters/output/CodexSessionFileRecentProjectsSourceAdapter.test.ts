import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexSessionFileRecentProjectsSourceAdapter } from '@features/recent-projects/main/adapters/output/sources/CodexSessionFileRecentProjectsSourceAdapter';

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
    });

    const result = await adapter.list();

    expect(result.candidates.map((candidate) => candidate.primaryPath)).toEqual([
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
    });

    await expect(adapter.list()).resolves.toEqual({
      candidates: [],
      degraded: false,
    });
  });
});
