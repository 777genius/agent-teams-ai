import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '@features/workspace-trust/main';
import { afterEach, describe, expect, it } from 'vitest';

let tmpDir: string | null = null;

async function makeTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-trust-git-root-'));
  return tmpDir;
}

async function createSyntheticWorktree(input: {
  repoDir: string;
  worktreeDir: string;
  name: string;
}): Promise<void> {
  const worktreeGitDir = path.join(input.repoDir, '.git', 'worktrees', input.name);
  await fs.mkdir(input.worktreeDir, { recursive: true });
  await fs.mkdir(worktreeGitDir, { recursive: true });
  await fs.writeFile(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(input.worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
  await fs.writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n', 'utf8');
  await fs.writeFile(
    path.join(worktreeGitDir, 'gitdir'),
    `${path.join(input.worktreeDir, '.git')}\n`,
    'utf8'
  );
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('resolveWorkspaceTrustCanonicalGitRoot', () => {
  it('rejects forged or malformed Git markers before elevating a parent to a trust root', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'parent');
    const nested = path.join(repo, 'nested');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(nested);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('preserves the original filesystem spelling for decomposed unicode paths', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'Cafe\u0301');
    const nested = path.join(repo, 'nested');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git', 'config'), '[core]\n');
    await fs.mkdir(nested);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBe(repo);
  });

  it('rejects forged .git pointers to another repository', async () => {
    const dir = await makeTmpDir();
    const repo = path.join(dir, 'parent');
    const nested = path.join(repo, 'nested');
    const foreign = path.join(dir, 'foreign-git');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(path.join(foreign, 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repo, '.git'), `gitdir: ${foreign}\n`);
    await expect(resolveWorkspaceTrustFilesystemGitRoot(nested)).resolves.toBeNull();
  });

  it('finds a git root from nested paths without spawning git', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const nestedDir = path.join(repoDir, 'packages', 'app');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');
    await fs.mkdir(nestedDir, { recursive: true });

    await expect(resolveWorkspaceTrustFilesystemGitRoot(nestedDir)).resolves.toBe(repoDir);
  });

  it('does not infer a git root from a missing path', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const missingDir = path.join(repoDir, 'packages', 'missing');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');

    await expect(resolveWorkspaceTrustFilesystemGitRoot(missingDir)).resolves.toBeNull();
  });

  it('resolves a valid git worktree to the canonical repository root', async () => {
    const dir = await makeTmpDir();
    const repoDir = path.join(dir, 'repo');
    const worktreeDir = path.join(dir, 'worktrees', 'alice');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n');
    await createSyntheticWorktree({ repoDir, worktreeDir, name: 'alice' });

    await expect(resolveWorkspaceTrustCanonicalGitRoot(worktreeDir)).resolves.toBe(repoDir);
  });

  it('does not accept a forged gitdir pointer to another repository', async () => {
    const dir = await makeTmpDir();
    const trustedRepoDir = path.join(dir, 'trusted-repo');
    const forgedDir = path.join(dir, 'forged');
    await fs.mkdir(path.join(trustedRepoDir, '.git'), { recursive: true });
    await fs.mkdir(forgedDir, { recursive: true });
    await fs.writeFile(
      path.join(forgedDir, '.git'),
      `gitdir: ${path.join(trustedRepoDir, '.git')}\n`,
      'utf8'
    );

    await expect(resolveWorkspaceTrustCanonicalGitRoot(forgedDir)).resolves.toBe(forgedDir);
  });

  it('does not accept borrowed worktree metadata without a backlink', async () => {
    const dir = await makeTmpDir();
    const trustedRepoDir = path.join(dir, 'trusted-repo');
    const forgedDir = path.join(dir, 'forged');
    const borrowedWorktreeGitDir = path.join(trustedRepoDir, '.git', 'worktrees', 'alice');
    await fs.mkdir(path.join(trustedRepoDir, '.git'), { recursive: true });
    await fs.mkdir(forgedDir, { recursive: true });
    await fs.mkdir(borrowedWorktreeGitDir, { recursive: true });
    await fs.writeFile(
      path.join(forgedDir, '.git'),
      `gitdir: ${borrowedWorktreeGitDir}\n`,
      'utf8'
    );
    await fs.writeFile(path.join(borrowedWorktreeGitDir, 'commondir'), '../..\n', 'utf8');
    await fs.writeFile(
      path.join(borrowedWorktreeGitDir, 'gitdir'),
      `${path.join(trustedRepoDir, '.git')}\n`,
      'utf8'
    );

    await expect(resolveWorkspaceTrustCanonicalGitRoot(forgedDir)).resolves.toBe(forgedDir);
  });
});
