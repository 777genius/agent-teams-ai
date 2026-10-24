import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';

import { FileSearchService } from '@main/services/editor/FileSearchService';
import { GitStatusService } from '@main/services/editor/GitStatusService';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface GitSandbox {
  projectRoot: string;
  gitStatus: GitStatusService;
  fileSearch: FileSearchService;
}

async function withGitSandbox(run: (sandbox: GitSandbox) => Promise<void>): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'git-services-real-'));
  const gitStatus = new GitStatusService();
  const fileSearch = new FileSearchService();

  try {
    await Promise.all([
      writeFile(join(projectRoot, '.gitignore'), 'ignored.txt\n'),
      writeFile(join(projectRoot, '.gitconfig-test'), ''),
      writeFile(join(projectRoot, 'tracked file.txt'), 'tracked\n'),
      writeFile(join(projectRoot, 'untracked.txt'), 'untracked\n'),
      writeFile(join(projectRoot, 'ignored.txt'), 'ignored\n'),
    ]);

    // Initialize only this fixture, without inherited Git paths, config or templates.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    );
    env.GIT_CONFIG_GLOBAL = join(projectRoot, '.gitconfig-test');
    env.GIT_CONFIG_NOSYSTEM = '1';
    const options = { cwd: projectRoot, env, timeout: 10_000 };
    // This test requires installed Git on the runner's PATH, with fixed argv and sandbox cwd.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Fixture setup accepts no product input.
    execFileSync('git', ['init', '--initial-branch=sandbox-main', '--template='], options);
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- Same installed Git and isolated fixture.
    execFileSync('git', ['add', '--', '.gitignore', 'tracked file.txt'], options);

    // Inherited config with a missing pair makes Git fail if a service forwards it.
    // Keep setup clean so the public-service assertions prove ambient filtering.
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', undefined);
    vi.stubEnv('GIT_CONFIG_VALUE_0', undefined);

    await run({ projectRoot, gitStatus, fileSearch });
  } finally {
    vi.unstubAllEnvs();
    gitStatus.destroy();
    fileSearch.invalidateListFilesCache(projectRoot);
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe('editor services with real Git', () => {
  it('reads staged status while omitting untracked files', async () => {
    await withGitSandbox(async ({ projectRoot, gitStatus }) => {
      gitStatus.init(projectRoot);

      const status = await gitStatus.getStatus();

      expect(status.isGitRepo).toBe(true);
      expect(status.branch).toBe('sandbox-main');
      expect(status.files).toContainEqual({ path: 'tracked file.txt', status: 'staged' });
      expect(status.files.some((file) => file.path === 'untracked.txt')).toBe(false);
    });
  });

  it('lists tracked and untracked files while respecting Git ignores', async () => {
    await withGitSandbox(async ({ projectRoot, fileSearch }) => {
      const files = await fileSearch.listFiles(projectRoot);

      // The filesystem fallback includes ignored.txt, so it cannot hide a failed Git call.
      expect(files).toEqual([
        {
          path: join(projectRoot, 'tracked file.txt'),
          name: 'tracked file.txt',
          relativePath: 'tracked file.txt',
        },
        {
          path: join(projectRoot, 'untracked.txt'),
          name: 'untracked.txt',
          relativePath: 'untracked.txt',
        },
      ]);
    });
  });

  it('keeps arbitrary Git configuration environment variables blocked', async () => {
    await withGitSandbox(async ({ projectRoot }) => {
      const git = simpleGit({ baseDir: projectRoot }).env('GIT_CONFIG_COUNT', '0');

      await expect(git.status()).rejects.toThrow(/GIT_CONFIG_COUNT.*not permitted/);
    });
  });
});
